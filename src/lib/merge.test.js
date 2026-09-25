import { describe, it, expect } from 'vitest';
import { applyRemotePull, mergeAttendanceList } from './merge.js';

// Characterization tests (v1.16, limecore#11).
//
// This module is the entire reason StudyDesk data survives two devices. Every
// rule here was written to fix a specific reported bug, and each one is
// invisible to a reader skimming for dead code — which is exactly what the
// code-health pass (limecore#12) will be doing. These pin current behaviour so
// that pass has something to fail against.

// `applyRemotePull` reads ten remote collections and defaults each one; an
// undefined list must leave local state untouched rather than blank it.
function remote(over = {}) {
  return {
    subjects: [],
    grades: [],
    sessions: [],
    assignments: [],
    exams: [],
    actions: [],
    notes: [],
    noteAttachments: [],
    attendance: [],
    plannedSessions: [],
    academicTerms: [],
    timetableEntries: [],
    attachments: [],
    commitments: [],
    ...over,
  };
}

const EARLY = '2026-01-01T10:00:00.000Z';
const LATE = '2026-01-01T12:00:00.000Z';

describe('LWW timestamp comparison', () => {
  it('compares as instants, not strings, across the two timestamp formats', () => {
    // The bug this guards: local `updatedAt` is `Date.toISOString()`
    // (`...sssZ`), remote `updated_at` is Postgres timestamptz text
    // (`...+00:00`, variable fractional digits, no `Z`). For two writes in the
    // same second, a lexicographic `>` compares `Z` against `+` and flips the
    // answer — clobbering the newer edit. Same instant, different spelling:
    // remote must NOT win.
    const state = {
      courses: { s1: { id: 's1', name: 'local', updatedAt: '2026-01-01T10:00:00.500Z' } },
    };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'remote', updated_at: '2026-01-01T10:00:00.5+00:00' }] }),
    );
    expect(out.courses.s1.name).toBe('local');
  });

  it('lets a genuinely newer remote row win', () => {
    const state = { courses: { s1: { id: 's1', name: 'local', updatedAt: EARLY } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'remote', updated_at: LATE }] }),
    );
    expect(out.courses.s1.name).toBe('remote');
  });

  it('lets a remote row win when the local row has no timestamp at all', () => {
    const state = { courses: { s1: { id: 's1', name: 'local' } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'remote', updated_at: EARLY }] }),
    );
    expect(out.courses.s1.name).toBe('remote');
  });

  it('keeps the local row when the remote one has no timestamp', () => {
    const state = { courses: { s1: { id: 's1', name: 'local', updatedAt: EARLY } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'remote' }] }),
    );
    expect(out.courses.s1.name).toBe('local');
  });
});

describe('subject merge', () => {
  it('gives a subject discovered remotely the default grey when it has no colour', () => {
    const out = applyRemotePull({}, remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: EARLY }] }));
    expect(out.courses.s1).toMatchObject({ name: 'Maths', color: '#7a7570', notes: [] });
  });

  it('defaults credits to 1 and the nullable columns to null', () => {
    const out = applyRemotePull({}, remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: EARLY }] }));
    expect(out.courses.s1).toMatchObject({
      credits: 1,
      semester: null,
      schoolYear: null,
      archivedAt: null,
      deletedAt: null,
    });
  });

  it('does not wipe a local colour when a newer remote edit left colour unset', () => {
    // NCC also writes subjects. An edit from there that does not touch colour
    // must not clear the colour the user picked here.
    const state = { courses: { s1: { id: 's1', name: 'Maths', color: '#ff0000', updatedAt: EARLY } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths II', updated_at: LATE, color: null }] }),
    );
    expect(out.courses.s1.name).toBe('Maths II');
    expect(out.courses.s1.color).toBe('#ff0000');
  });

  it('takes a colour the remote row does set', () => {
    const state = { courses: { s1: { id: 's1', name: 'Maths', color: '#ff0000', updatedAt: EARLY } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: LATE, color: '#00ff00' }] }),
    );
    expect(out.courses.s1.color).toBe('#00ff00');
  });

  it('keeps local-only notes across a remote-wins merge', () => {
    const state = {
      courses: { s1: { id: 's1', name: 'Maths', updatedAt: EARLY, notes: [{ id: 'n1' }] } },
    };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths II', updated_at: LATE }] }),
    );
    expect(out.courses.s1.notes).toEqual([{ id: 'n1' }]);
  });

  it('keeps a soft-delete as a tombstone rather than dropping the row', () => {
    // Courses/grades/sessions keep `deletedAt`; the newer tables remove
    // instead. Both behaviours are deliberate and both are pinned here.
    const out = applyRemotePull(
      {},
      remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: EARLY, deleted_at: LATE }] }),
    );
    expect(out.courses.s1).toBeDefined();
    expect(out.courses.s1.deletedAt).toBe(LATE);
  });
});

describe('delete wins (limecore#27, registry P6)', () => {
  // The three collections that keep tombstones in local state used plain LWW,
  // so a local edit stamped after a remote delete kept the row alive on this
  // device while every other device had dropped it.

  it('a remote tombstone beats a NEWER local edit of a course', () => {
    const state = { courses: { s1: { id: 's1', name: 'edited here', updatedAt: LATE } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: EARLY, deleted_at: EARLY }] }),
    );
    expect(out.courses.s1.deletedAt).toBe(EARLY);
  });

  it('...and of a grade, and of a study session', () => {
    const state = {
      grades: [{ id: 'g1', subjectId: 's1', grade: 7, updatedAt: LATE }],
      studySessions: [{ id: 'x1', durationMinutes: 30, updatedAt: LATE }],
    };
    const out = applyRemotePull(state, remote({
      grades: [{ id: 'g1', subject_id: 's1', grade: 6, updated_at: EARLY, deleted_at: EARLY }],
      sessions: [{ id: 'x1', duration_minutes: 30, updated_at: EARLY, deleted_at: EARLY }],
    }));
    expect(out.grades[0].deletedAt).toBe(EARLY);
    expect(out.studySessions[0].deletedAt).toBe(EARLY);
  });

  it('a newer LIVE remote row still revives a local tombstone — revival is plain LWW', () => {
    const state = { courses: { s1: { id: 's1', name: 'Maths', updatedAt: EARLY, deletedAt: EARLY } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: LATE, deleted_at: null }] }),
    );
    expect(out.courses.s1.deletedAt).toBeNull();
  });

  it('an OLDER live remote row does not revive a local tombstone', () => {
    const state = { courses: { s1: { id: 's1', name: 'Maths', updatedAt: LATE, deletedAt: LATE } } };
    const out = applyRemotePull(
      state,
      remote({ subjects: [{ id: 's1', name: 'Maths', updated_at: EARLY, deleted_at: null }] }),
    );
    expect(out.courses.s1.deletedAt).toBe(LATE);
  });
});

describe('tombstone-removal collections', () => {
  it('removes a deleted assignment instead of keeping a tombstone', () => {
    // Assignments are read in ~20 places that do not filter `deletedAt`, so a
    // tombstone here would put deleted homework back on a user's screen.
    const state = { assignments: [{ id: 'a1', title: 'Essay', updatedAt: EARLY }] };
    const out = applyRemotePull(
      state,
      remote({ assignments: [{ id: 'a1', deleted_at: LATE, updated_at: LATE }] }),
    );
    expect(out.assignments).toEqual([]);
  });

  it('lets a delete beat a simultaneous local edit', () => {
    const state = { assignments: [{ id: 'a1', title: 'Edited locally', updatedAt: LATE }] };
    const out = applyRemotePull(
      state,
      remote({ assignments: [{ id: 'a1', deleted_at: EARLY, updated_at: EARLY }] }),
    );
    expect(out.assignments).toEqual([]);
  });

  it('leaves a local list untouched when the remote collection is missing', () => {
    // A client that pulled before a table existed, or a partial response where
    // one select failed, must not blank a term tree the user just built.
    const state = {
      assignments: [{ id: 'a1', title: 'Essay', updatedAt: EARLY }],
      academicTerms: [{ id: 't1', name: 'Autumn', updatedAt: EARLY }],
    };
    const out = applyRemotePull(state, {
      subjects: [],
      grades: [],
      sessions: [],
      attendance: [],
    });
    expect(out.assignments).toEqual(state.assignments);
    expect(out.academicTerms).toEqual(state.academicTerms);
  });

  it('keeps a purely local row that the server has never seen', () => {
    const state = { assignments: [{ id: 'local-only', title: 'Offline', updatedAt: EARLY }] };
    const out = applyRemotePull(state, remote());
    expect(out.assignments).toEqual(state.assignments);
  });
});

describe('mergeAttendanceList', () => {
  // The server's identity for an attendance fact is
  // (user_id, timetable_entry_id, date), not the client uuid. Two devices
  // marking the same lesson offline mint different uuids for the same fact.

  it('replaces a local row with the remote one sharing its natural key', () => {
    const local = [{ id: 'local-uuid', timetableEntryId: 'tt1', date: '2026-01-05', status: 'present', updatedAt: EARLY }];
    const out = mergeAttendanceList(local, [
      { id: 'server-uuid', timetable_entry_id: 'tt1', date: '2026-01-05', status: 'absent', updated_at: LATE },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'server-uuid', status: 'absent' });
  });

  it('adopts the remote id even when local content wins on LWW', () => {
    // Keeping the local uuid would leave this device pushing under an id the
    // server does not use, and the next pull would hand back a row matching
    // nothing locally — permanent cross-device ping-pong.
    const local = [{ id: 'local-uuid', timetableEntryId: 'tt1', date: '2026-01-05', status: 'present', updatedAt: LATE }];
    const out = mergeAttendanceList(local, [
      { id: 'server-uuid', timetable_entry_id: 'tt1', date: '2026-01-05', status: 'absent', updated_at: EARLY },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('server-uuid');
    expect(out[0].status).toBe('present');
  });

  it('does not count one lesson twice when the two sides disagree on uuid', () => {
    const local = [{ id: 'A1', timetableEntryId: 'tt1', date: '2026-01-05', status: 'present', updatedAt: EARLY }];
    const out = mergeAttendanceList(local, [
      { id: 'B1', timetable_entry_id: 'tt1', date: '2026-01-05', status: 'present', updated_at: EARLY },
    ]);
    expect(out).toHaveLength(1);
  });

  it('clears a lesson by natural key whatever uuid the local row carried', () => {
    const local = [{ id: 'local-uuid', timetableEntryId: 'tt1', date: '2026-01-05', status: 'present', updatedAt: EARLY }];
    const out = mergeAttendanceList(local, [
      { id: 'server-uuid', timetable_entry_id: 'tt1', date: '2026-01-05', deleted_at: LATE, updated_at: LATE },
    ]);
    expect(out).toEqual([]);
  });

  it('preserves a local-only mark the outbox has not drained yet', () => {
    const local = [{ id: 'offline', timetableEntryId: 'tt9', date: '2026-01-09', status: 'present', updatedAt: EARLY }];
    const out = mergeAttendanceList(local, []);
    expect(out).toEqual(local);
  });

  it('keeps marks for different dates on the same lesson apart', () => {
    const out = mergeAttendanceList(
      [{ id: 'a', timetableEntryId: 'tt1', date: '2026-01-05', status: 'present', updatedAt: EARLY }],
      [{ id: 'b', timetable_entry_id: 'tt1', date: '2026-01-12', status: 'absent', updated_at: EARLY }],
    );
    expect(out).toHaveLength(2);
  });

  it('tolerates null lists on either side', () => {
    expect(mergeAttendanceList(null, null)).toEqual([]);
    expect(mergeAttendanceList(undefined, undefined)).toEqual([]);
  });
});

describe('applyRemotePull shape', () => {
  it('carries unrelated state keys through untouched', () => {
    const out = applyRemotePull({ settings: { theme: 'cream' } }, remote());
    expect(out.settings).toEqual({ theme: 'cream' });
  });

  it('returns every collection it owns even from empty state', () => {
    const out = applyRemotePull({}, remote());
    for (const key of [
      'courses', 'grades', 'studySessions', 'assignments', 'exams', 'actions',
      'notes', 'noteAttachments', 'attendance', 'plannedSessions',
      'academicTerms', 'timetableEntries', 'attachments', 'commitments',
    ]) {
      expect(out[key]).toBeDefined();
    }
  });
});

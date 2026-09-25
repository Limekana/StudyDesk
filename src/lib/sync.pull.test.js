import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeClient, makeUuids } from '../test/fakePostgrest.js';

// v1.16 (limecore#28, StudyDesk#73) — the real `pullAllStudyData`, run against
// a PostgREST stand-in that truncates at 1000 rows without an error, the way
// the real one does.

const holder = vi.hoisted(() => ({ client: null }));
vi.mock('./supabase.js', () => ({
  get supabase() {
    return holder.client;
  },
}));

const { pullAllStudyData } = await import('./sync.js');

const TABLES = [
  'subjects', 'grades', 'study_sessions', 'assignments', 'exams', 'study_actions',
  'planned_sessions', 'academic_terms', 'timetable_entries', 'assignment_attachments',
  'commitments', 'notebook_entries', 'notebook_attachments', 'lesson_attendance',
];

function seed(sizes = {}) {
  const tables = {};
  for (const t of TABLES) {
    tables[t] = makeUuids(sizes[t] ?? 3).map((id) => ({ id, updated_at: '2026-01-01T00:00:00Z' }));
  }
  return tables;
}

beforeEach(() => {
  holder.client = null;
});

describe('pullAllStudyData', () => {
  it('returns every attendance row past the 1000-row cap', async () => {
    // `lesson_attendance` is the table that actually gets there: it grows
    // every school day. Before v1.16 this pull returned exactly 1000 of these.
    const tables = seed({ lesson_attendance: 1200 });
    holder.client = fakeClient(tables);
    const remote = await pullAllStudyData();
    expect(remote.attendance).toHaveLength(1200);
    expect(new Set(remote.attendance.map((r) => r.id))).toEqual(
      new Set(tables.lesson_attendance.map((r) => r.id)),
    );
  });

  it('pages every table it reads, not just the ones that are big today', async () => {
    // The structural guard. A table added to this pull later with a bare
    // `select('*')` makes a request with no keyset order, and fails here —
    // whatever it is called and however small it is when it is added.
    holder.client = fakeClient(seed());
    await pullAllStudyData();
    const unpaged = holder.client.requests.filter((r) => !r.order || r.order.col !== 'id');
    expect(unpaged.map((r) => r.table)).toEqual([]);
    expect(new Set(holder.client.requests.map((r) => r.table))).toEqual(new Set(TABLES));
  });

  it('maps each table to the key the merge reads', async () => {
    holder.client = fakeClient(seed({ subjects: 2, notebook_entries: 4 }));
    const remote = await pullAllStudyData();
    expect(remote.subjects).toHaveLength(2);
    expect(remote.notes).toHaveLength(4);
    expect(Object.keys(remote).sort()).toEqual([
      'academicTerms', 'actions', 'assignments', 'attachments', 'attendance',
      'commitments', 'exams', 'grades', 'noteAttachments', 'notes',
      'plannedSessions', 'sessions', 'subjects', 'timetableEntries',
    ]);
  });

  it('still tolerates a missing notebook or attendance table', async () => {
    // The 1.13 window: a newer app against a database the owner has not
    // migrated yet. Paging must not turn "feature not there yet" into
    // "sync is broken".
    const tables = seed();
    delete tables.notebook_entries;
    delete tables.notebook_attachments;
    delete tables.lesson_attendance;
    holder.client = fakeClient(tables);
    const remote = await pullAllStudyData();
    expect(remote.notes).toEqual([]);
    expect(remote.attendance).toEqual([]);
    expect(remote.subjects).toHaveLength(3);
  });

  it('throws, rather than returning a partial pull, when a later page fails', async () => {
    const tables = seed({ assignments: 2500 });
    holder.client = fakeClient(tables, {
      failWhen: (req) =>
        req.table === 'assignments' && req.gt
          ? { code: '57014', message: 'canceling statement due to statement timeout' }
          : null,
    });
    await expect(pullAllStudyData()).rejects.toMatchObject({ code: '57014' });
  });

  it('throws on a missing core table, as before', async () => {
    const tables = seed();
    delete tables.grades;
    holder.client = fakeClient(tables);
    await expect(pullAllStudyData()).rejects.toMatchObject({ code: '42P01' });
  });
});

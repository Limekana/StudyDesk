import { describe, it, expect, beforeEach } from 'vitest';
import { editStamp, pushStamp, recordPull, resetEditStamps, STAMPED_KINDS } from './editStamp.js';

// v1.16 (limecore#27, registry P6) — stamp the edit with
// max(deviceNow, lastSeenServerStamp + 1 ms).

const T = (iso) => new Date(iso).getTime();
const NOON = T('2026-09-25T12:00:00.000Z');

beforeEach(() => resetEditStamps());

describe('editStamp — the base', () => {
  it('stamps an edit with the device clock when nothing newer is known', () => {
    expect(editStamp('upsert_assignment', { id: 'a1' }, NOON)).toBe('2026-09-25T12:00:00.000Z');
  });

  it('uses the row\'s own edit time when the payload carries one', () => {
    // A row re-queued at launch was edited earlier; "now" would overstate it
    // and let a stale edit beat a newer one from another device.
    const s = editStamp('upsert_assignment', { id: 'a1', updatedAt: '2026-09-25T10:00:00.000Z' }, NOON);
    expect(s).toBe('2026-09-25T10:00:00.000Z');
  });

  it('ignores an unparseable payload stamp and falls back to the clock', () => {
    expect(editStamp('upsert_assignment', { id: 'a1', updatedAt: 'nonsense' }, NOON)).toBe(
      '2026-09-25T12:00:00.000Z',
    );
  });
});

describe('editStamp — never older than what this device has seen', () => {
  it('stamps 1 ms past a pulled row on a device whose clock runs slow', () => {
    // Another device (correct clock) wrote at 12:00:05; this device's clock
    // says 12:00:00. Without the rule the edit would be OLDER than the version
    // it was made on, and the server would silently decline it.
    recordPull({ assignments: [{ id: 'a1', updated_at: '2026-09-25T12:00:05.000+00:00' }] });
    expect(editStamp('upsert_assignment', { id: 'a1' }, NOON)).toBe('2026-09-25T12:00:05.001Z');
  });

  it('leaves the clock alone when it is already ahead of what was pulled', () => {
    recordPull({ assignments: [{ id: 'a1', updated_at: '2026-09-25T11:00:00+00:00' }] });
    expect(editStamp('upsert_assignment', { id: 'a1' }, NOON)).toBe('2026-09-25T12:00:00.000Z');
  });

  it('keeps one row\'s edits strictly increasing even if the clock steps back', () => {
    const first = editStamp('upsert_exam', { id: 'e1' }, NOON);
    const second = editStamp('upsert_exam', { id: 'e1' }, NOON - 60_000); // NTP stepped back
    expect(T(second)).toBeGreaterThan(T(first));
  });

  it('is per row — another row\'s stamp does not push this one forward', () => {
    recordPull({ assignments: [{ id: 'other', updated_at: '2026-09-25T13:00:00+00:00' }] });
    expect(editStamp('upsert_assignment', { id: 'a1' }, NOON)).toBe('2026-09-25T12:00:00.000Z');
  });

  it('is per table — an exam and an assignment may share nothing', () => {
    recordPull({ exams: [{ id: 'x', updated_at: '2026-09-25T13:00:00+00:00' }] });
    expect(editStamp('upsert_assignment', { id: 'x' }, NOON)).toBe('2026-09-25T12:00:00.000Z');
  });

  it('keeps the newer of a pulled stamp and this device\'s own', () => {
    editStamp('upsert_note', { id: 'n1' }, NOON); // this device stamped 12:00
    recordPull({ notes: [{ id: 'n1', updated_at: '2026-09-25T11:00:00+00:00' }] }); // pull predates it
    expect(T(editStamp('upsert_note', { id: 'n1' }, NOON))).toBe(NOON + 1);
  });
});

describe('editStamp — attendance is known by its lesson, not its uuid', () => {
  it('matches a pulled row by (timetable entry, date) whatever id each side holds', () => {
    // The local uuid is only a queue handle; the server may know the lesson
    // under a different id (limecore#31 / blocker A4).
    recordPull({
      attendance: [{ id: 'server-id', timetable_entry_id: 't1', date: '2026-09-25', updated_at: '2026-09-25T12:00:05+00:00' }],
    });
    const s = editStamp('upsert_attendance', { id: 'local-id', timetableEntryId: 't1', date: '2026-09-25' }, NOON);
    expect(s).toBe('2026-09-25T12:00:05.001Z');
  });

  it('stamps re-marking a cleared lesson newer than its tombstone, so the revival lands', () => {
    // The server accepts a revival only when it is newer than the tombstone.
    recordPull({
      attendance: [{ id: 's', timetable_entry_id: 't1', date: '2026-09-25', updated_at: '2026-09-25T12:00:05+00:00', deleted_at: '2026-09-25T12:00:05+00:00' }],
    });
    const s = editStamp('upsert_attendance', { timetableEntryId: 't1', date: '2026-09-25' }, NOON);
    expect(T(s)).toBeGreaterThan(T('2026-09-25T12:00:05Z'));
  });
});

describe('editStamp — what it does not stamp', () => {
  it('returns null for kinds that write no updated_at', () => {
    for (const kind of ['submit_feedback', 'record_app_open', 'archive_semester', 'delete_assignment']) {
      expect(editStamp(kind, { id: 'x' }, NOON)).toBeNull();
    }
  });

  it('returns null for a payload with no row identity', () => {
    expect(editStamp('upsert_assignment', {}, NOON)).toBeNull();
    expect(editStamp('upsert_attendance', { timetableEntryId: 't1' }, NOON)).toBeNull();
  });

  it('covers every upsert kind the outbox can send to a table with updated_at', () => {
    expect(Object.keys(STAMPED_KINDS).sort()).toEqual([
      'log_session', 'update_session', 'upsert_action', 'upsert_assignment', 'upsert_attendance',
      'upsert_commitment', 'upsert_exam', 'upsert_grade', 'upsert_note', 'upsert_note_attachment',
      'upsert_planned', 'upsert_subject', 'upsert_term', 'upsert_timetable',
    ]);
  });
});

describe('pushStamp', () => {
  it('sends the payload\'s edit stamp', () => {
    expect(pushStamp('2026-09-25T10:00:00.000Z')).toBe('2026-09-25T10:00:00.000Z');
  });

  it('falls back to now for an item queued by an older build, as every push did before', () => {
    const before = Date.now();
    const s = T(pushStamp(undefined));
    expect(s).toBeGreaterThanOrEqual(before);
    expect(s).toBeLessThanOrEqual(Date.now());
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeLwwServer } from '../test/lwwServer.js';

// v1.18.1 — sync against a stand-in that applies the server's
// last-writer-wins rules (set_updated_at) and its no-op guard
// (zz_skip_noop_update): StudyDesk#143 (attendance clear and re-mark),
// StudyDesk#145 (semester archive overwriting newer edits), StudyDesk#163
// (the archive stamped at the edit, not the push) and StudyDesk#146
// (the one-off legacy push).

const H = vi.hoisted(() => ({ server: null }));
vi.mock('./supabase.js', () => ({
  supabase: {
    from: (t) => H.server.from(t),
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
  },
}));
const outbox = await import('./outbox.js');
const { resetEditStamps, recordPull } = await import('./editStamp.js');
const { applyRemotePull } = await import('./merge.js');
const { reconcileUnsynced } = await import('./reconcile.js');
const { runLegacyPush } = await import('./legacyPush.js');
const { stampsFromPull } = await import('./syncStamps.js');
const sync = await import('./sync.js');
const { reducer } = await import('./appReducer.js');

function storage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}
const at = (iso) => vi.setSystemTime(new Date(iso));
const online = (on) => vi.stubGlobal('navigator', { onLine: on });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('window', { dispatchEvent() {}, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('CustomEvent', class { constructor(n) { this.type = n; } });
  H.server = makeLwwServer();
  resetEditStamps();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const E = 'entry-1';
const D = '2026-10-12';
const live = () => (H.server.tables.lesson_attendance || []).filter((r) => !r.deleted_at);
const queue = () => JSON.parse(localStorage.getItem('studydesk-outbox') || '[]');
// The next `n` attendance upserts fail, as on a flaky connection.
function failMarks(n) {
  const real = H.server.from;
  H.server.from = (t) => {
    const api = real(t);
    if (t !== 'lesson_attendance') return api;
    return { ...api, upsert: (...a) => (n-- > 0 ? Promise.resolve({ error: { message: 'network down' } }) : api.upsert(...a)) };
  };
}

describe('attendance clear and re-mark (StudyDesk#143)', () => {
  it('online, mark then clear before any pull: the clear reaches the server row', async () => {
    online(true);
    at('2026-10-12T08:00:00Z');
    outbox.enqueue('upsert_attendance', { id: 'local-L', timetableEntryId: E, date: D, status: 'present' });
    await outbox.drain();
    await settle();
    at('2026-10-12T08:00:20Z');
    outbox.enqueue('delete_attendance', { id: 'local-L', timetableEntryId: E, date: D });
    await outbox.drain();
    await settle();
    expect(outbox.getStatus().pending).toBe(0);
    expect(live()).toHaveLength(0);
  });

  it('offline, mark then clear: drains in tap order and the server ends cleared', async () => {
    online(false);
    at('2026-10-12T08:00:00Z');
    outbox.enqueue('upsert_attendance', { id: 'local-L', timetableEntryId: E, date: D, status: 'present' });
    at('2026-10-12T08:00:05Z');
    outbox.enqueue('delete_attendance', { id: 'local-L', timetableEntryId: E, date: D });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(live()).toHaveLength(0);
  });

  it('offline, clear then re-mark a synced lesson: the re-mark lands and survives the next pull', async () => {
    online(true);
    at('2026-10-12T07:00:00Z');
    outbox.enqueue('upsert_attendance', { id: 'x', timetableEntryId: E, date: D, status: 'absent' });
    await outbox.drain();
    await settle();
    const S = H.server.tables.lesson_attendance[0].id;
    online(false);
    at('2026-10-12T09:00:00Z');
    outbox.enqueue('delete_attendance', { id: S, timetableEntryId: E, date: D });
    at('2026-10-12T09:00:02Z');
    outbox.enqueue('upsert_attendance', { id: S, timetableEntryId: E, date: D, status: 'present' });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(live().map((r) => r.status)).toEqual(['present']);
    const local = [{ id: S, timetableEntryId: E, date: D, status: 'present', note: null, updatedAt: '2026-10-12T09:00:02.000Z', deletedAt: null }];
    const pulled = { subjects: [], grades: [], sessions: [], attendance: H.server.tables.lesson_attendance };
    const merged = applyRemotePull({ courses: {}, grades: [], studySessions: [], attendance: local }, pulled);
    expect(merged.attendance.map((a) => a.status)).toEqual(['present']);
  });

  // Review of v1.18.1, S1: the clear ran while the mark waited for a retry,
  // matched nothing, and the retry then inserted the row the user cleared.
  it('offline, mark then clear, and the mark fails once on reconnect: the server still ends cleared', async () => {
    online(false);
    at('2026-10-12T08:00:00Z');
    outbox.enqueue('upsert_attendance', { id: 'local-L', timetableEntryId: E, date: D, status: 'present' });
    at('2026-10-12T08:00:05Z');
    outbox.enqueue('delete_attendance', { id: 'local-L', timetableEntryId: E, date: D });
    failMarks(1);
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    await outbox.drain();
    await settle();
    expect(live()).toHaveLength(0);
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('a clear drops the marks queued before it for that lesson, and only those', () => {
    online(false);
    at('2026-10-12T08:00:00Z');
    outbox.enqueue('upsert_attendance', { id: 'local-L', timetableEntryId: E, date: D, status: 'present' });
    // Same lesson under the server's id (adopted from a pull), and another lesson.
    outbox.enqueue('upsert_attendance', { id: 'srv-9', timetableEntryId: E, date: D, status: 'late' });
    outbox.enqueue('upsert_attendance', { id: 'other', timetableEntryId: E, date: '2026-10-13', status: 'present' });
    outbox.enqueue('delete_attendance', { id: 'local-L', timetableEntryId: E, date: D });
    // A clear queued by an older build carries only the id.
    outbox.enqueue('upsert_attendance', { id: 'old', status: 'present' });
    outbox.enqueue('delete_attendance', { id: 'old' });
    expect(queue().map((i) => `${i.kind}:${i.payload.id}`)).toEqual([
      'upsert_attendance:other', 'delete_attendance:local-L', 'delete_attendance:old',
    ]);
  });

  it('a mark quarantined on its lesson and then cleared is not revived when the lesson lands', async () => {
    localStorage.setItem('studydesk-outbox', JSON.stringify([{
      id: 'q1', createdAt: '2026-10-12T08:00:00.000Z', kind: 'upsert_attendance',
      payload: { id: 'local-L', timetableEntryId: E, date: D, status: 'present', updatedAt: '2026-10-12T08:00:00.000Z' },
      attempts: 5, quarantined: true, lastErrorCode: '23503',
      lastError: 'insert or update on table "lesson_attendance" violates foreign key constraint',
    }]));
    online(false);
    at('2026-10-12T08:00:05Z');
    outbox.enqueue('delete_attendance', { id: 'local-L', timetableEntryId: E, date: D });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    // The lesson itself reaches the server later (reconcile re-queues it).
    outbox.enqueue('upsert_timetable', { id: E, termId: 'term-1', title: 'Maths', weekday: 1, startsAt: '08:00', endsAt: '09:00' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.timetable_entries).toHaveLength(1);
    expect(live()).toHaveLength(0);
    expect(outbox.getStatus().pending).toBe(0);
  });
});

describe('semester archive offline (StudyDesk#145)', () => {
  it('a rename made elsewhere while this device was offline is kept, and the archive lands', async () => {
    H.server = makeLwwServer({
      subjects: [{ id: 'm', user_id: 'u1', name: 'Math', credits: 5, semester: 'Fall', archived_at: null, deleted_at: null, updated_at: '2026-10-01T00:00:00.000Z' }],
    });
    online(false);
    at('2026-10-12T10:00:00Z');
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', color: '#111', schoolYear: '2026', updatedAt: '2026-10-01T00:00:00Z' } };
    outbox.enqueue('archive_semester', { courses, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    // Another device renames the course at 11:00.
    at('2026-10-12T11:00:00Z');
    Object.assign(H.server.tables.subjects[0], { name: 'Mathematics', updated_at: '2026-10-12T11:00:00.000Z' });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    const row = H.server.tables.subjects[0];
    expect(row.name).toBe('Mathematics');
    expect(row.archived_at).toBe('2026-10-12T10:00:00.000Z');
  });

  // Review of v1.18.1, S2: an update that affects no row is not proof the row
  // is missing. The fallback may only ever create one.
  it('a restore the server already has (the no-op guard drops it) leaves a newer rename alone', async () => {
    H.server = makeLwwServer({
      subjects: [{ id: 'm', user_id: 'u1', name: 'Mathematics', credits: 5, semester: 'Fall', archived_at: null, deleted_at: null, updated_at: '2026-10-12T11:00:00.000Z' }],
    });
    online(true);
    at('2026-10-12T12:00:00Z');
    // A snapshot from before the rename, with no edit stamp (an old install).
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: '2026-09-01T00:00:00.000Z' } };
    outbox.enqueue('restore_semester', { courses, semester: 'Fall' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects).toEqual([expect.objectContaining({ name: 'Mathematics', archived_at: null, updated_at: '2026-10-12T11:00:00.000Z' })]);
    expect(outbox.getStatus().pending).toBe(0);
  });

  // v1.18.1 (StudyDesk#163): a newer CONTENT edit no longer declines an
  // archive (the archive has its own stamp); a newer archive change does.
  it('an archive the server declines (its archive change is newer) leaves that row alone', async () => {
    // This device's clock is an hour slow and has not learned the offset yet.
    H.server = makeLwwServer({
      subjects: [{ id: 'm', user_id: 'u1', name: 'Mathematics', credits: 5, semester: 'Fall', archived_at: null, archived_edited_at: '2026-10-12T11:30:00.000Z', deleted_at: null, updated_at: '2026-10-12T11:30:00.000Z' }],
    }, { clockAheadMs: 3600_000 });
    online(true);
    at('2026-10-12T11:00:00Z');
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null } };
    outbox.enqueue('archive_semester', { courses, semester: 'Fall', stamp: '2026-10-12T11:00:00.000Z' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects).toEqual([expect.objectContaining({ name: 'Mathematics', archived_at: null, updated_at: '2026-10-12T11:30:00.000Z' })]);
  });

  it('an archive older than a rename lands without declining or undoing it (slow clock)', async () => {
    H.server = makeLwwServer({
      subjects: [{ id: 'm', user_id: 'u1', name: 'Mathematics', credits: 5, semester: 'Fall', archived_at: null, deleted_at: null, updated_at: '2026-10-12T11:30:00.000Z' }],
    }, { clockAheadMs: 3600_000 });
    online(true);
    at('2026-10-12T11:00:00Z');
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null } };
    outbox.enqueue('archive_semester', { courses, semester: 'Fall', stamp: '2026-10-12T11:00:00.000Z' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects).toEqual([expect.objectContaining({
      name: 'Mathematics', archived_at: '2026-10-12T11:00:00.000Z', archived_edited_at: '2026-10-12T11:00:00.000Z', updated_at: '2026-10-12T11:30:00.001Z',
    })]);
  });

  it('a course the server has never seen is created, archived', async () => {
    online(true);
    at('2026-10-12T12:00:00Z');
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: '2026-10-12T09:00:00.000Z' } };
    outbox.enqueue('archive_semester', { courses, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects).toEqual([expect.objectContaining({ id: 'm', name: 'Math', archived_at: '2026-10-12T10:00:00.000Z' })]);
  });
});

describe('semester archive stamped at the edit (StudyDesk#163)', () => {
  const T0 = '2026-10-12T09:00:00.000Z';
  const row = (extra = {}) => ({ id: 'm', user_id: 'u1', name: 'Math', credits: 5, semester: 'Fall', archived_at: null, deleted_at: null, updated_at: T0, ...extra });
  const course = (extra = {}) => ({ id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0, ...extra });
  const pullOf = () => ({ subjects: H.server.tables.subjects.map((r) => ({ ...r })), grades: [], sessions: [] });
  const local = (courses) => ({ courses, grades: [], studySessions: [] });

  it('the issue: B restores at 11:00, A\'s offline 10:00 archive pushes at 12:00, B\'s 11:30 rename pushes at 12:30', async () => {
    H.server = makeLwwServer({ subjects: [row({ archived_at: '2026-10-12T08:00:00.000Z', archived_edited_at: '2026-10-12T08:00:00.000Z' })] });
    // A, offline, archives at 10:00 (its copy shows the course active).
    online(false);
    at('2026-10-12T10:00:00Z');
    let a = local({ m: course() });
    a = reducer(a, { type: 'ARCHIVE_SEMESTER', semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    outbox.enqueue('archive_semester', { courses: { m: course() }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    // B, online, restores at 11:00.
    at('2026-10-12T11:00:00Z');
    await sync.restoreSemester({ m: course({ archivedAt: '2026-10-12T08:00:00.000Z' }) }, 'Fall', '2026-10-12T11:00:00.000Z');
    // A comes back online at 12:00.
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects[0]).toMatchObject({ archived_at: null, archived_edited_at: '2026-10-12T11:00:00.000Z' });
    // B's rename, made offline at 11:30, pushes at 12:30.
    at('2026-10-12T12:30:00Z');
    await sync.upsertSubject({ id: 'm', name: 'Mathematics', credits: 5, semester: 'Fall', updatedAt: '2026-10-12T11:30:00.000Z' });
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Mathematics', archived_at: null, updated_at: '2026-10-12T11:30:00.000Z' });
    // A pulls: the restore and the rename both reach it.
    const merged = applyRemotePull(a, pullOf()).courses.m;
    expect(merged).toMatchObject({ name: 'Mathematics', archivedAt: null });
  });

  it('an offline archive pushed late does not decline renames made before its push, before or after the archive', async () => {
    H.server = makeLwwServer({ subjects: [row()] });
    online(false);
    at('2026-10-12T10:00:00Z');
    outbox.enqueue('archive_semester', { courses: { m: course() }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects[0]).toMatchObject({ archived_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T09:00:00.001Z' });
    at('2026-10-12T12:30:00Z');
    await sync.upsertSubject({ id: 'm', name: 'Maths', credits: 5, semester: 'Fall', updatedAt: '2026-10-12T09:30:00.000Z' });
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Maths', archived_at: '2026-10-12T10:00:00.000Z' });
    await sync.upsertSubject({ id: 'm', name: 'Mathematics', credits: 5, semester: 'Fall', updatedAt: '2026-10-12T11:30:00.000Z' });
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Mathematics', archived_at: '2026-10-12T10:00:00.000Z' });
  });

  it('archive then restore offline, drained in order: the restore wins', async () => {
    H.server = makeLwwServer({ subjects: [row()] });
    online(false);
    at('2026-10-12T10:00:00Z');
    outbox.enqueue('archive_semester', { courses: { m: course() }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    at('2026-10-12T10:05:00Z');
    outbox.enqueue('restore_semester', { courses: { m: course({ archivedAt: '2026-10-12T10:00:00.000Z' }) }, semester: 'Fall', stamp: '2026-10-12T10:05:00.000Z' });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects[0]).toMatchObject({ archived_at: null, archived_edited_at: '2026-10-12T10:05:00.000Z' });
  });

  it('pull merges the archive on its own stamp, whichever side wins the row', () => {
    // Local copy is newer (an unpushed rename) but the remote restore is newer than its archive.
    const mine = course({ name: 'Mine', updatedAt: '2026-10-12T12:00:00.000Z', archivedAt: '2026-10-12T10:00:00.000Z', archivedEditedAt: '2026-10-12T10:00:00.000Z' });
    let pulled = { subjects: [row({ updated_at: '2026-10-12T11:00:00.000Z', archived_edited_at: '2026-10-12T11:00:00.000Z' })], grades: [], sessions: [] };
    expect(applyRemotePull(local({ m: mine }), pulled).courses.m).toMatchObject({ name: 'Mine', archivedAt: null, archivedEditedAt: '2026-10-12T11:00:00.000Z' });
    // Remote is newer (a rename) but this device's archive has not landed yet.
    const archivedHere = course({ archivedAt: '2026-10-12T10:00:00.000Z', archivedEditedAt: '2026-10-12T10:00:00.000Z' });
    pulled = { subjects: [row({ name: 'Theirs', updated_at: '2026-10-12T09:30:00.000Z' })], grades: [], sessions: [] };
    expect(applyRemotePull(local({ m: archivedHere }), pulled).courses.m).toMatchObject({ name: 'Theirs', archivedAt: '2026-10-12T10:00:00.000Z' });
    // No stamp on either side (rows only older builds touched): the row's winner, as before.
    pulled = { subjects: [row({ name: 'Theirs', updated_at: '2026-10-12T09:30:00.000Z', archived_at: '2026-10-12T09:30:00.000Z' })], grades: [], sessions: [] };
    expect(applyRemotePull(local({ m: course() }), pulled).courses.m).toMatchObject({ name: 'Theirs', archivedAt: '2026-10-12T09:30:00.000Z' });
  });

  it('archiving locally leaves the course\'s content stamp alone', () => {
    const s = reducer(local({ m: course() }), { type: 'ARCHIVE_SEMESTER', semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    expect(s.courses.m).toMatchObject({ archivedAt: '2026-10-12T10:00:00.000Z', archivedEditedAt: '2026-10-12T10:00:00.000Z', updatedAt: T0 });
    const r = reducer(s, { type: 'RESTORE_SEMESTER', semester: 'Fall', stamp: '2026-10-12T10:05:00.000Z' });
    expect(r.courses.m).toMatchObject({ archivedAt: null, archivedEditedAt: '2026-10-12T10:05:00.000Z', updatedAt: T0 });
  });
});

describe('archive edit stamp and shipped builds (StudyDesk#163, P1)', () => {
  const T0 = '2026-10-12T09:00:00.000Z';
  const row = (extra = {}) => ({ id: 'm', user_id: 'u1', name: 'Math', credits: 5, semester: 'Fall', archived_at: null, deleted_at: null, updated_at: T0, ...extra });

  it('a restore queued by an older build (no stamp) is written as 1.18.0 wrote it', async () => {
    H.server = makeLwwServer({ subjects: [row({ archived_at: '2026-10-12T08:00:00.000Z' })] });
    online(true);
    at('2026-10-12T12:00:00Z');
    const courses = { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: '2026-10-12T08:00:00.000Z' } };
    outbox.enqueue('restore_semester', { courses, semester: 'Fall' });
    await outbox.drain();
    await settle();
    const update = H.server.log.find(([op, t]) => op === 'update' && t === 'subjects');
    expect(update[3]).toEqual({ archived_at: null, updated_at: '2026-10-12T12:00:00.000Z' });
    expect(H.server.tables.subjects[0]).toMatchObject({ archived_at: null, archived_edited_at: '2026-10-12T12:00:00.000Z', updated_at: '2026-10-12T12:00:00.000Z' });
  });

  it('writes that never send the stamp keep today\'s last-writer-wins outcomes', async () => {
    H.server = makeLwwServer({ subjects: [row()] });
    at('2026-10-12T12:00:00Z');
    const upd = (patch) => H.server.from('subjects').update(patch).eq('id', 'm').select('id').then((r) => r.data.length);
    expect(await upd({ archived_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' })).toBe(1);
    expect(await upd({ archived_at: null, updated_at: '2026-10-12T09:30:00.000Z' })).toBe(0);
    expect(await upd({ name: 'Maths', archived_at: null, updated_at: '2026-10-12T11:00:00.000Z' })).toBe(1);
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Maths', archived_at: null, updated_at: '2026-10-12T11:00:00.000Z' });
  });

  it('a shipped build\'s restore at 11:00, then a 1.18.1 archive from 10:00: the restore stays', async () => {
    H.server = makeLwwServer({ subjects: [row({ archived_at: '2026-10-12T08:00:00.000Z' })] });
    online(false);
    at('2026-10-12T10:00:00Z');
    outbox.enqueue('archive_semester', { courses: { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0 } }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    // The old build's restore, push-time stamped, as 1.18.0 sends it.
    at('2026-10-12T11:00:00Z');
    await H.server.from('subjects').update({ archived_at: null, updated_at: '2026-10-12T11:00:00.000Z' }).eq('id', 'm');
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects[0]).toMatchObject({ archived_at: null, updated_at: '2026-10-12T11:00:00.000Z' });
  });

  it('a shipped build pushing the whole course with a stale archived_at keeps the newer archive (NCC)', async () => {
    H.server = makeLwwServer({ subjects: [row()] });
    online(true);
    at('2026-10-12T11:00:00Z');
    outbox.enqueue('archive_semester', { courses: { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0 } }, semester: 'Fall', stamp: '2026-10-12T11:00:00.000Z' });
    await outbox.drain();
    await settle();
    at('2026-10-12T12:00:00Z');
    await H.server.from('subjects').upsert(row({ name: 'Maths', archived_at: null, updated_at: '2026-10-12T10:30:00.000Z' }));
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Maths', archived_at: '2026-10-12T11:00:00.000Z' });
  });

  // The server before 20261016_archive_edit_stamp.sql: no column, no guard.
  function withoutArchiveColumn(initial) {
    H.server = makeLwwServer(initial, { archiveColumn: false });
    const real = H.server.from;
    const refusal = { code: 'PGRST204', message: "Could not find the 'archived_edited_at' column of 'subjects' in the schema cache" };
    H.server.from = (t) => {
      const api = real(t);
      if (t !== 'subjects') return api;
      const refused = { eq: () => refused, select: () => refused, then: (res, rej) => Promise.resolve({ data: null, error: refusal }).then(res, rej) };
      return {
        ...api,
        update: (patch) => ('archived_edited_at' in patch ? refused : api.update(patch)),
        upsert: (payload, opts) => ('archived_edited_at' in payload ? Promise.resolve({ error: refusal }) : api.upsert(payload, opts)),
      };
    };
  }

  it('a server without the column (migration not yet applied): the 1.18.0 write, and the archive lands', async () => {
    withoutArchiveColumn({ subjects: [row({ name: 'Mathematics', updated_at: '2026-10-12T11:00:00.000Z' })] });
    online(true);
    at('2026-10-12T12:00:00Z');
    outbox.enqueue('archive_semester', { courses: { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0 } }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    await outbox.drain();
    await settle();
    expect(H.server.tables.subjects[0]).toMatchObject({ name: 'Mathematics', archived_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T12:00:00.000Z' });
    expect(outbox.getStatus().pending).toBe(0);
  });

  // Review of v1.18.1 (StudyDesk#163): a missing remote stamp counted as
  // "oldest", so this device kept its own archive after anyone restored it.
  it('archived here without the column, then restored by a build that sends no stamp: the pull restores it', async () => {
    withoutArchiveColumn({ subjects: [row()] });
    online(false);
    at('2026-10-12T10:00:00Z');
    const mine = reducer({ courses: { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0 } }, grades: [], studySessions: [] },
      { type: 'ARCHIVE_SEMESTER', semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    outbox.enqueue('archive_semester', { courses: { m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: null, updatedAt: T0 } }, semester: 'Fall', stamp: '2026-10-12T10:00:00.000Z' });
    at('2026-10-12T12:00:00Z');
    online(true);
    await outbox.drain();
    await settle();
    const pull = () => ({ subjects: H.server.tables.subjects.map((r) => ({ ...r })), grades: [], sessions: [] });
    const synced = applyRemotePull(mine, pull());
    expect(synced.courses.m.archivedAt).toBe('2026-10-12T10:00:00.000Z');
    // Another device on an older build restores at 13:00.
    at('2026-10-12T13:00:00Z');
    await H.server.from('subjects').update({ archived_at: null, updated_at: '2026-10-12T13:00:00.000Z' }).eq('id', 'm');
    expect(applyRemotePull(synced, pull()).courses.m.archivedAt).toBeNull();
    expect(applyRemotePull(mine, pull()).courses.m.archivedAt).toBeNull();
  });

  it('a pending local archive still beats a remote row that predates it', () => {
    const mine = { id: 'm', name: 'Math', credits: 5, semester: 'Fall', archivedAt: '2026-10-12T10:00:00.000Z', archivedEditedAt: '2026-10-12T10:00:00.000Z', updatedAt: T0 };
    const pulled = { subjects: [row({ updated_at: '2026-10-12T09:30:00.000Z' })], grades: [], sessions: [] };
    expect(applyRemotePull({ courses: { m: mine }, grades: [], studySessions: [] }, pulled).courses.m.archivedAt).toBe('2026-10-12T10:00:00.000Z');
  });
});

describe('the stand-in server reports what production does (StudyDesk#145)', () => {
  const seed = () => makeLwwServer({
    subjects: [{ id: 'm', user_id: 'u1', name: 'Math', archived_at: null, deleted_at: null, updated_at: '2026-10-12T11:00:00.000Z' }],
  });

  it('an update older than the row is declined, and affects no row', async () => {
    H.server = seed();
    at('2026-10-12T12:00:00Z');
    const { data } = await H.server.from('subjects').update({ name: 'Old', updated_at: '2026-10-12T10:00:00.000Z' }).eq('id', 'm').select('id');
    expect(data).toEqual([]);
    expect(H.server.tables.subjects[0].name).toBe('Math');
  });

  it('an update that changes nothing but updated_at affects no row, and writes nothing', async () => {
    H.server = seed();
    at('2026-10-12T12:00:00Z');
    const { data } = await H.server.from('subjects').update({ archived_at: null, updated_at: '2026-10-12T12:00:00.000Z' }).eq('id', 'm').select('id');
    expect(data).toEqual([]);
    expect(H.server.tables.subjects[0].updated_at).toBe('2026-10-12T11:00:00.000Z');
  });

  it('an update that changes a column affects its row', async () => {
    H.server = seed();
    at('2026-10-12T12:00:00Z');
    const { data } = await H.server.from('subjects').update({ name: 'Maths', updated_at: '2026-10-12T12:00:00.000Z' }).eq('id', 'm').select('id');
    expect(data).toEqual([{ id: 'm', user_id: 'u1', name: 'Maths', archived_at: null, deleted_at: null, updated_at: '2026-10-12T12:00:00.000Z' }]);
  });
});

describe('one-off legacy push (StudyDesk#146)', () => {
  const FLAG = 'studydesk-needs-initial-push';
  const T0 = '2026-10-01T00:00:00.000Z';
  // What the server holds, as the first pull returns it.
  const server = () => ({
    subjects: [{ id: 'm', user_id: 'u1', name: 'Math', credits: 5, semester: 'Fall', deleted_at: null, updated_at: T0 }],
    study_sessions: [{
      id: 's1', user_id: 'u1', subject_id: 'm', started_at: T0, duration_minutes: 50, notes: null,
      focus_rating: 4, ai_session_summary: 'Went well', ai_comprehension: 3, deleted_at: null, updated_at: T0,
    }],
    study_actions: [{ id: 'todo-srv', user_id: 'u1', subject_id: null, text: 'Newer text', bucket: 'today', done: false, deleted_at: null, updated_at: '2026-10-12T11:00:00.000Z' }],
  });
  // This device after the first pull: the server's rows plus what the id
  // migration re-keyed, which the server has never seen.
  const state = () => ({
    courses: {
      m: { id: 'm', name: 'Math', credits: 5, semester: 'Fall', updatedAt: T0 },
      m2: { id: 'm2', name: 'History', credits: 3, semester: 'Fall', updatedAt: T0 },
      gone: { id: 'gone', name: 'Dropped', credits: 1, deletedAt: T0, updatedAt: T0 },
    },
    grades: [{ id: 'g1', subjectId: 'm2', grade: 9, weight: 1, date: '2026-09-30', updatedAt: T0 }],
    studySessions: [
      { id: 's1', subjectId: 'm', startedAt: T0, durationMinutes: 50, notes: null, focusRating: 4, aiSessionSummary: 'Went well', aiComprehension: 3, updatedAt: T0 },
      { id: 's2', subjectId: 'm2', startedAt: T0, durationMinutes: 25, notes: null, focusRating: 5, updatedAt: T0 },
    ],
    assignments: [], exams: [],
    actions: [
      { id: 'todo-srv', text: 'Newer text', bucket: 'today', courseId: null, done: false, updatedAt: '2026-10-12T11:00:00.000Z' },
      { id: 'todo-new', text: 'Read ch. 3', bucket: 'week', courseId: 'm2', done: false, updatedAt: T0 },
      { id: 'todo-sugg', text: 'Derived', bucket: 'today', courseId: 'm', suggested: true, updatedAt: T0 },
      { id: 'todo-orphan', text: 'Tagged to a dropped course', bucket: 'today', courseId: 'gone', updatedAt: T0 },
    ],
  });
  const pulled = (rows) => ({
    subjects: rows.subjects, sessions: rows.study_sessions, actions: rows.study_actions,
    grades: [], assignments: [], exams: [],
  });

  it('after the first pull, the rows the server lacks reach it and the rows it has keep every column', async () => {
    const rows = server();
    H.server = makeLwwServer(rows);
    const remote = pulled(rows);
    recordPull(remote); // as pullAllStudyData does
    localStorage.setItem(FLAG, '1');
    online(false);
    at('2026-10-12T12:00:00Z');
    // What App.jsx's pull runs, then useCloudPushers once the pull settled.
    reconcileUnsynced(state(), remote, outbox);
    expect(runLegacyPush(state(), stampsFromPull(remote))).toBe(1);
    expect(localStorage.getItem(FLAG)).toBeNull();
    online(true);
    await outbox.drain();
    await settle();
    const t = H.server.tables;
    // Review of v1.18.1, S5: the partial session payload nulled these.
    expect(t.study_sessions.find((r) => r.id === 's1')).toMatchObject({ focus_rating: 4, ai_session_summary: 'Went well', ai_comprehension: 3 });
    expect(t.study_sessions.map((r) => r.id).sort()).toEqual(['s1', 's2']);
    expect(t.subjects.map((r) => r.id).sort()).toEqual(['m', 'm2']);
    expect(t.grades.map((r) => r.id)).toEqual(['g1']);
    expect(t.study_actions.map((r) => r.id).sort()).toEqual(['todo-new', 'todo-srv']);
    expect(t.study_actions.find((r) => r.id === 'todo-srv').text).toBe('Newer text');
    expect(outbox.getStatus().pending).toBe(0);
  });

  it('keeps the flag when the queue cannot be written, and does nothing without it', () => {
    const rows = server();
    const remote = pulled(rows);
    online(false);
    expect(runLegacyPush(state(), stampsFromPull(remote))).toBeNull(); // no flag
    expect(queue()).toEqual([]);
    localStorage.setItem(FLAG, '1');
    const setItem = localStorage.setItem;
    localStorage.setItem = (k, v) => {
      if (k === 'studydesk-outbox') throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
      return setItem(k, v);
    };
    expect(runLegacyPush(state(), stampsFromPull(remote))).toBeNull();
    expect(localStorage.getItem(FLAG)).toBe('1');
  });
});

// Review of v1.18.1, B1: one enqueue per row parsed and re-wrote the whole
// queue each time, so 1,820 rows took 7 s on the main thread.
describe('queueing many rows at once (StudyDesk#146)', () => {
  it('reads and writes the queue once, and coalesces as enqueue does', () => {
    online(false);
    at('2026-10-12T12:00:00Z');
    const setItem = vi.spyOn(localStorage, 'setItem');
    const items = Array.from({ length: 2000 }, (_, i) => ({ kind: 'upsert_grade', payload: { id: `g${i}`, subjectId: 'm', grade: 8 } }));
    items.push({ kind: 'upsert_grade', payload: { id: 'g0', subjectId: 'm', grade: 10 } });
    expect(outbox.enqueueMany(items)).toBe(true);
    expect(setItem.mock.calls.filter(([k]) => k === 'studydesk-outbox')).toHaveLength(1);
    const q = queue();
    expect(q).toHaveLength(2000);
    expect(q[0].payload.grade).toBe(10);
    expect(new Set(q.map((i) => i.id)).size).toBe(2000);
  });
});

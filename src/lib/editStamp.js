// v1.16 (limecore#27, registry P6) — every push carries the moment of the EDIT.
//
// The bug. Every upsert sent `updated_at: nowISO()` — the device clock at PUSH
// time. A snapshot edited offline at 10:00 and pushed at 12:00 therefore
// arrived stamped 12:00, overwrote an edit another device made at 11:00, and
// the server could not tell. The outbox comment's "server-stamped now()" was
// the intent; the code never did that — the stamp was always this device's
// clock, read at the wrong moment.
//
// The rule (owner decision 2026-09-25, Option 1): stamp an edit with
//
//     max(deviceNow, lastSeenServerStamp + 1 ms)
//
// so an edit made after seeing a version is always newer than it, whatever
// this device's clock says. Without the `+ 1 ms` half, a phone whose clock
// runs a few seconds slow would stamp an edit to a row it had just pulled
// OLDER than that row, and the server would silently decline it.
//
// Where it is applied: in `outbox.enqueue`, not at the ~20 call sites. The
// outbox sees every write at the moment of the user's action (enqueue time is
// edit time, to within the tick an effect takes), and it re-stamps on every
// enqueue — so an edit that coalesces onto a queued one carries the NEW edit's
// time, not the first one's. A payload that already carries the row's own
// `updatedAt` (the reconciler's, the note autosave's) uses that as the base,
// because for a row re-queued at launch it is the real edit time and "now" is
// not.
//
// `lastSeen` is this device's best knowledge of the newest stamp each row has:
// what the last pull returned, or what this device last stamped it with,
// whichever is later. It lives in memory only. After a restart it refills on
// the first pull; until then an edit falls back to the plain device clock,
// which is exactly the behaviour before this file existed.

/** Outbox kinds whose push writes `updated_at`, and the table each lands in.
 *  Deletes are absent on purpose: under "delete wins" the server accepts a
 *  tombstone whatever its stamp. */
export const STAMPED_KINDS = {
  upsert_subject: 'subjects',
  upsert_grade: 'grades',
  log_session: 'study_sessions',
  update_session: 'study_sessions',
  upsert_assignment: 'assignments',
  upsert_exam: 'exams',
  upsert_action: 'study_actions',
  upsert_planned: 'planned_sessions',
  upsert_term: 'academic_terms',
  upsert_timetable: 'timetable_entries',
  upsert_commitment: 'commitments',
  upsert_note: 'notebook_entries',
  upsert_note_attachment: 'notebook_attachments',
  upsert_attendance: 'lesson_attendance',
};

/** `pullAllStudyData()` result key → table. */
const PULLED = {
  subjects: 'subjects',
  grades: 'grades',
  sessions: 'study_sessions',
  assignments: 'assignments',
  exams: 'exams',
  actions: 'study_actions',
  plannedSessions: 'planned_sessions',
  academicTerms: 'academic_terms',
  timetableEntries: 'timetable_entries',
  commitments: 'commitments',
  notes: 'notebook_entries',
  noteAttachments: 'notebook_attachments',
  attendance: 'lesson_attendance',
};

const lastSeen = new Map();

function ms(iso) {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

/** How a row is known across devices. Attendance by its natural key, because
 *  the local uuid is only a queue handle until the server's id is adopted. */
function keyOf(table, row) {
  if (table === 'lesson_attendance') {
    const entry = row?.timetableEntryId ?? row?.timetable_entry_id;
    return entry && row?.date ? `${table}:${entry}::${row.date}` : null;
  }
  return row?.id ? `${table}:${row.id}` : null;
}

function remember(key, at) {
  if (!key || !Number.isFinite(at)) return;
  const prev = lastSeen.get(key);
  if (prev === undefined || at > prev) lastSeen.set(key, at);
}

/** Record every stamp a pull returned. Called from `pullAllStudyData`. */
export function recordPull(remote) {
  for (const [field, table] of Object.entries(PULLED)) {
    for (const row of remote?.[field] || []) {
      remember(keyOf(table, row), ms(row?.updated_at));
    }
  }
}

/**
 * The stamp this edit should carry, or null for a kind that writes no
 * `updated_at` (feedback, app opens, bulk semester archive) or a payload with
 * no row identity. Records the result, so the next edit of the same row on
 * this device is newer again even if the clock steps backwards.
 */
export function editStamp(kind, payload, now = Date.now()) {
  const table = STAMPED_KINDS[kind];
  if (!table) return null;
  const key = keyOf(table, payload);
  if (!key) return null;
  const own = ms(payload?.updatedAt);
  let at = Number.isFinite(own) ? own : now;
  const seen = lastSeen.get(key);
  if (seen !== undefined && at <= seen) at = seen + 1;
  remember(key, at);
  return new Date(at).toISOString();
}

/** What a push sends as `updated_at`: the payload's edit stamp, or — for an
 *  item queued by a build older than this file, which carries none — the
 *  device clock now, which is what every push sent before. */
export function pushStamp(updatedAt) {
  const at = ms(updatedAt);
  return new Date(Number.isFinite(at) ? at : Date.now()).toISOString();
}

/** Test seam. */
export function resetEditStamps() {
  lastSeen.clear();
}

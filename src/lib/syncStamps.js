// What the server last said about each row — so a pull is not mistaken for an edit.
//
// StudyDesk#72, Limekana/limecore#24. Two effects in App.jsx push rows on their
// own initiative rather than from a call site: the v1.7 reconciler
// (assignments, exams, to-dos) and the note autosave. Both decide that a row
// "changed" by watching its `updatedAt`.
//
// A pull changes `updatedAt` too. Every push stamps `updated_at = now()` at the
// moment it is SENT, which is always later than the local edit stamp, so the
// next pull hands back a newer timestamp and `MERGE_REMOTE` adopts it. Both
// effects then read the server's own copy as a fresh local edit and push it
// again — with a newer stamp, which the next pull hands back, and so on.
//
// Today that loop turns once per extra pull. The moment realtime works it turns
// every ~3 s per row, forever: the push echoes, the echo pulls, the pull pushes.
// The dead realtime channel (limecore#24) is the only thing that has hidden it.
//
// The fix is to remember, per row, the `updated_at` the last pull returned. A
// row whose local stamp is that same instant IS the server's copy, and pushing
// it back can only churn. A row whose stamp differs was edited here since.
//
// Pure module: no React, no Supabase. Asserted in scripts/check-logic.mjs.

// The four lists an effect pushes without being asked. Keys are the local
// state names; values are the key the same rows arrive under in
// `sync.pullAllStudyData()`.
const TRACKED = {
  assignments: 'assignments',
  exams: 'exams',
  actions: 'actions',
  notes: 'notes',
};

/** Epoch ms for an ISO string in either format, or NaN.
 *
 *  Local stamps are `Date.toISOString()` (`...sssZ`); server stamps are
 *  Postgres timestamptz text (`...+00:00`, microseconds). Equal instants
 *  never compare equal as strings, so they are compared as numbers — at
 *  millisecond precision, which is what the client wrote in the first place. */
function instant(iso) {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

/**
 * Index a pull by row.
 *
 * @param {object} remote  The result of `sync.pullAllStudyData()`.
 * @returns {Record<string, Map<string, {at: number, deleted: boolean}>>}
 */
export function stampsFromPull(remote) {
  const out = {};
  for (const [local, remoteKey] of Object.entries(TRACKED)) {
    const m = new Map();
    for (const row of remote?.[remoteKey] || []) {
      if (!row?.id) continue;
      m.set(row.id, { at: instant(row.updated_at), deleted: Boolean(row.deleted_at) });
    }
    out[local] = m;
  }
  return out;
}

/** True when a local row is exactly the copy the server last returned, so
 *  pushing it would only move the server's timestamp. False for a row the
 *  server has never seen, and for any row edited locally since the pull. */
export function isInSync(kind, row, stamps) {
  const s = stamps?.[kind]?.get(row?.id);
  if (!s || s.deleted) return false;
  const local = instant(row?.updatedAt);
  return Number.isFinite(local) && local === s.at;
}

/** True when the last pull carried this row as a tombstone. A row that left
 *  local state because of that pull was deleted ELSEWHERE; queueing a delete
 *  for it would only stamp the tombstone again. */
export function isRemoteTombstone(kind, id, stamps) {
  return Boolean(stamps?.[kind]?.get(id)?.deleted);
}

/** Pull throttle. Coming back to the window is the moment a user expects to
 *  see the other device's changes, and also something a desktop user does
 *  dozens of times an hour — a full pull is 14 requests, so returns inside the
 *  window reuse the last one. */
export const MIN_PULL_INTERVAL_MS = 30_000;

export function shouldPull(lastPullAt, now, minMs = MIN_PULL_INTERVAL_MS) {
  if (!Number.isFinite(lastPullAt)) return true;
  return now - lastPullAt >= minMs;
}

// v1.18.1 (StudyDesk#146) — the one-off push after the v1.0.4/v1.7 id
// migration in rehydrate.js, as outbox items. useCloudPushers.js runs it once
// the first pull of the session has succeeded.
//
// Only manual to-dos. The other tables the migration re-keys (subjects,
// grades, study sessions, assignments, exams) are reconcile.js's: it runs
// after every pull and queues each row the server does not have, with its
// whole payload and only once its course will exist. A re-keyed row is such a
// row, since the server rejected its old id and never stored it. Queueing
// them here as well only doubled that work, and queueing the rows the server
// DID have did harm: the payloads here were partial (a study session without
// its focus rating or AI debrief), a row pulled a moment earlier carries the
// server's own stamp, the server accepts an equal stamp, and the push wrote
// null over those columns. To-dos are the one table reconcile leaves out (see
// `reconcileUnsynced`), so they are what is left to this push.
import * as outbox from './outbox.js';

const FLAG = 'studydesk-needs-initial-push';

/** The to-dos this install still owes the server, as outbox items.
 *  `stamps` is the last pull (syncStamps.stampsFromPull); a to-do the server
 *  has, live or deleted, is left alone, so nothing it holds is overwritten. */
export function legacyActionItems(state, stamps) {
  const onServer = stamps?.actions;
  const out = [];
  for (const a of state?.actions || []) {
    // Suggested to-dos are derived from assignments and exams on every render
    // and must never reach the cloud, or they would come back as duplicate
    // real rows alongside the freshly derived ones.
    if (!a?.id || a.suggested || onServer?.has(a.id)) continue;
    // study_actions.subject_id is a foreign key. A course this device still
    // has is on the server or queued by reconcile in the same pull; one it has
    // deleted may never have got there, and the to-do would then fail on every
    // retry. Same rule as reconcile's `parentWillExist`.
    if (a.courseId) {
      const c = state.courses?.[a.courseId];
      if (!c || c.deletedAt) continue;
    }
    // Every column sync.upsertAction writes, so the push cannot null one.
    out.push({
      kind: 'upsert_action',
      payload: { id: a.id, text: a.text, bucket: a.bucket, courseId: a.courseId, done: a.done, updatedAt: a.updatedAt },
    });
  }
  return out;
}

/**
 * Queue the to-dos if this install still owes the push, and clear the flag
 * once the queue write has landed. Returns how many were queued, or null when
 * nothing ran: no flag, or a queue that could not be written (full storage),
 * in which case the flag stays and the next launch tries again.
 */
export function runLegacyPush(state, stamps) {
  try {
    if (localStorage.getItem(FLAG) !== '1') return null;
  } catch {
    return null;
  }
  const items = legacyActionItems(state, stamps);
  if (!outbox.enqueueMany(items)) return null;
  // If this removal fails, the next launch runs it again: to-dos already on
  // the server are skipped, and ones still queued coalesce.
  try { localStorage.removeItem(FLAG); } catch { /* see above */ }
  return items.length;
}

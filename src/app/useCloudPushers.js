// The two pushers that diff state instead of enqueueing at call sites.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { useEffect, useRef } from "react";
import * as outbox from "../lib/outbox.js";
import { isInSync, isRemoteTombstone } from "../lib/syncStamps.js";
import { runLegacyPush } from "../lib/legacyPush.js";

export function useCloudPushers({ session, state, pulledOnce, pulledOnceRef, remoteStampsRef, showFlash, t }) {
  // ── v1.0.4 one-shot post-migration push ─────────────────────────────────────
  // The UUID migration in the reducer init may have rewritten local IDs. Those
  // rewritten rows have never reached Supabase (the old short-ID pushes were
  // failing silently). Push everything once after sign-in. Subjects must go
  // before grades (FK), grades before sessions doesn't matter (no FK between).
  // Fire-and-forget per row, log failures — next user edit will retry.
  //
  // v1.18.1 (StudyDesk#146): queued through the outbox after the first pull,
  // instead of pushed directly before it, and the flag is cleared once the
  // queue write lands. Pushed directly, each row was stamped with the push
  // time, and one row that could never succeed (a to-do whose course was
  // deleted before it synced fails its foreign key) kept the flag set, so
  // EVERY launch re-sent the whole dataset stamped "now" and overwrote edits
  // made on other devices. Now only the to-dos the server lacks are queued:
  // reconcile, in the same pull, queues every other row it lacks (see
  // legacyPush.js). The flash says "waiting to sync", since queued is not
  // yet synced.
  useEffect(() => {
    if (!session || !pulledOnce) return;
    // The first pull failed, so what the server holds is unknown. The flag
    // stays, and the next launch tries again.
    if (!remoteStampsRef.current) return;
    const queued = runLegacyPush(state, remoteStampsRef.current);
    if (queued > 0) showFlash(t('av.flash.queuedLegacy', { count: queued }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, pulledOnce]);

  // ── v1.7 push reconciler for assignments / exams / actions (StudyDesk#6) ────
  //
  // Courses, grades and sessions enqueue their own pushes at each call site.
  // These three deliberately do not, and the reason is structural: they are
  // mutated from ~15 places across AsgnItem, ExamCard and ActionsView, none of
  // which receive `session`. Threading it through every one of those props
  // would be a wide change to working components, and any call site missed
  // would be an edit that silently never syncs — the exact bug being fixed.
  //
  // Instead: diff the three arrays after every state change and enqueue what
  // actually moved. One place, no call sites to miss, and it picks up any
  // future mutation path for free.
  const pushBaseline = useRef(null);
  useEffect(() => {
    if (!session) { pushBaseline.current = null; return; }
    // Wait for the first pull to settle before arming. Pushing local rows
    // before knowing the remote state would stamp them updated_at = now and
    // let a stale device win against a newer edit made elsewhere.
    if (!pulledOnceRef.current) return;

    const snap = (list, fields) => {
      const m = new Map();
      for (const x of list || []) m.set(x.id, fields(x));
      return m;
    };
    // Compare on updatedAt, not deep equality — every mutation stamps it, so
    // this is both cheaper and immune to unrelated field churn.
    const stamp = (x) => x.updatedAt || '';
    const next = {
      assignments: snap(state.assignments, stamp),
      exams: snap(state.exams, stamp),
      actions: snap((state.actions || []).filter((a) => !a.suggested), stamp),
    };

    // First run after a pull: record the baseline, push nothing. What is on
    // screen right now is already reconciled with the cloud.
    if (!pushBaseline.current) { pushBaseline.current = next; return; }

    const prev = pushBaseline.current;
    const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
    const assignmentsById = byId(state.assignments);
    const examsById = byId(state.exams);
    const actionsById = byId(state.actions);

    // StudyDesk#72 — `stamps` is what the last pull returned. A row whose
    // stamp moved because a pull brought the server's copy in is not a local
    // edit, and a row that left because the pull carried its tombstone was
    // deleted elsewhere; re-queueing either only moves the server's timestamp,
    // which the next pull brings back here (Limekana/limecore#24).
    const stamps = remoteStampsRef.current;

    for (const [id, s] of next.assignments) {
      if (prev.assignments.get(id) === s) continue;
      const a = assignmentsById.get(id);
      if (!a?.courseId) continue;
      if (isInSync('assignments', a, stamps)) continue;
      outbox.enqueue('upsert_assignment', { id, courseId: a.courseId, title: a.title, type: a.type, dueDate: a.dueDate, dueTime: a.dueTime, notes: a.notes, done: a.done, updatedAt: a.updatedAt });
    }
    for (const id of prev.assignments.keys()) {
      if (!next.assignments.has(id) && !isRemoteTombstone('assignments', id, stamps)) outbox.enqueue('delete_assignment', { id });
    }

    for (const [id, s] of next.exams) {
      if (prev.exams.get(id) === s) continue;
      const e = examsById.get(id);
      if (!e?.courseId) continue;
      if (isInSync('exams', e, stamps)) continue;
      outbox.enqueue('upsert_exam', { id, courseId: e.courseId, title: e.title, dueDate: e.dueDate, difficulty: e.difficulty, notes: e.notes, done: e.done, topics: e.topics, updatedAt: e.updatedAt });
    }
    for (const id of prev.exams.keys()) {
      if (!next.exams.has(id) && !isRemoteTombstone('exams', id, stamps)) outbox.enqueue('delete_exam', { id });
    }

    for (const [id, s] of next.actions) {
      if (prev.actions.get(id) === s) continue;
      const a = actionsById.get(id);
      if (!a) continue;
      if (isInSync('actions', a, stamps)) continue;
      outbox.enqueue('upsert_action', { id, text: a.text, bucket: a.bucket, courseId: a.courseId, done: a.done, updatedAt: a.updatedAt });
    }
    for (const id of prev.actions.keys()) {
      if (!next.actions.has(id) && !isRemoteTombstone('actions', id, stamps)) outbox.enqueue('delete_action', { id });
    }

    pushBaseline.current = next;
  // `session` is read for the sign-in gate only; the identity that matters is
  // the user id, which the pull effect already keys on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, state.assignments, state.exams, state.actions]);
}

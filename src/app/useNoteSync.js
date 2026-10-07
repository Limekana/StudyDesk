// Note edits to the outbox: debounced pushes, the flush on backgrounding, deletes.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { useEffect, useCallback, useRef } from "react";
import * as outbox from "../lib/outbox.js";
import { isInSync } from "../lib/syncStamps.js";

export function useNoteSync({ state, session, pulledOnce, remoteStampsRef, dispatch }) {
  // ── v1.13 Item 1b — pushing note edits ──────────────────────────────────
  //
  // A note changes on every keystroke, so it CANNOT be enqueued the way an
  // assignment is. Enqueueing per change would put hundreds of items in a
  // queue that persists to localStorage on every write — which is the exact
  // pressure that Item 1a identifies as the cause of the five-hours loss.
  //
  // So: debounce, and enqueue at most one item per note per idle window. The
  // outbox de-duplicates nothing, but `upsert_note` carries the whole note as
  // a snapshot, so a later item simply supersedes an earlier one under LWW —
  // which makes a stale queued copy harmless rather than a lost edit.
  //
  // The 1500ms window matches the realtime pull's own coalescing constant, so
  // the two do not fight: an edit settles, pushes, and the echo arrives after
  // the queue has already drained it.
  const noteTimers = useRef(new Map());
  useEffect(() => {
    if (!session) return undefined;
    // StudyDesk#72 — wait for the first pull to settle, as the v1.7
    // reconciler already does. Until then this effect cannot tell a note the
    // user just edited from a stale local copy, and it used to push them all
    // 1.5s after sign-in stamped `now()`: on a connection slower than the
    // debounce, an out-of-date copy overwrote a newer edit made on another
    // device. `pulledOnce` flips on success AND failure, so an offline launch
    // still pushes, and an edit made in the gap is picked up when it flips.
    if (!pulledOnce) return undefined;
    const timers = noteTimers.current;
    for (const n of state.notes || []) {
      if (n.deletedAt) continue;
      const prev = timers.get(n.id);
      if (prev?.updatedAt === n.updatedAt) continue;
      if (prev?.handle) clearTimeout(prev.handle);
      // StudyDesk#72 — this note is exactly the copy the last pull returned:
      // either it arrived from another device or it is our own push coming
      // back with its push-time stamp. Record the baseline, push nothing.
      // Pushing it would stamp a newer `updated_at`, which the next pull
      // returns, which lands here again — a loop once per pull, and every ~3s
      // per note once realtime works (Limekana/limecore#24). Cancelling the
      // pending timer above is correct too: the server's copy is newer than
      // the payload it captured.
      if (isInSync("notes", n, remoteStampsRef.current)) {
        timers.set(n.id, { updatedAt: n.updatedAt, handle: 0, payload: null });
        continue;
      }
      // The payload is captured HERE, alongside the timer, so `flush` below
      // can push it without the note being in scope. Without it the flush had
      // nothing to send — see blocker 3 on that effect.
      const payload = {
        id: n.id,
        courseId: n.courseId,
        title: n.title,
        lessonDate: n.lessonDate,
        content: n.content,
        sessionId: n.sessionId,
        layout: n.layout ?? null,
        // v1.16 (limecore#27): the note's own edit time — the keystroke, not
        // the debounce firing 1.5 s later. The outbox stamps from it.
        updatedAt: n.updatedAt,
      };
      const handle = setTimeout(() => {
        outbox.enqueue("upsert_note", payload);
        const cur = timers.get(n.id);
        if (cur) timers.set(n.id, { ...cur, handle: 0 });
      }, 1500);
      timers.set(n.id, { updatedAt: n.updatedAt, handle, payload });
    }
    return undefined;
  }, [state.notes, session, pulledOnce, remoteStampsRef]);

  // Flush pending note pushes on unmount and on backgrounding.
  //
  // ── This CANCELLED them instead (v1.13 review, blocker 3) ──────────────
  //
  // It cleared every timer and enqueued nothing, so the edit it was written
  // to rescue was the exact edit it destroyed: type a line, press Home inside
  // the 1.5s debounce, and the write never left the device. It fired on
  // unmount too, so merely navigating out of the notebook did the same.
  //
  // Nor was reconcile the safety net the old comment claimed. `findUnsynced`
  // compares IDS: once a note has been pushed even once it exists remotely,
  // so a later lost edit is invisible to it. The note then sits locally with
  // a newer `updatedAt` that no one ever sees, until another device's older
  // copy wins LWW and overwrites it.
  //
  // That is the five-hours bug, in the data the build plan calls the most
  // precious in the app. It now enqueues.
  useEffect(() => {
    const flush = () => {
      for (const [, rec] of noteTimers.current) {
        if (!rec.handle) continue;
        clearTimeout(rec.handle);
        // Cancel the timer and do its job immediately. `enqueue` coalesces on
        // the note id, so a flush racing a timer that already fired replaces
        // one pending item rather than queueing a second.
        if (rec.payload) outbox.enqueue("upsert_note", rec.payload);
      }
      noteTimers.current.clear();
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    // `pagehide` as well as `visibilitychange`. iOS WKWebView does not reliably
    // deliver `visibilitychange` when the OS terminates a backgrounded app, and
    // this flush is the last thing standing between a debounced note edit and
    // losing it. `pagehide` fires on that path, and flushing twice is free —
    // `flush` clears the timer map, and `enqueue` coalesces on the note id.
    const onPageHide = () => flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flush();
    };
  }, []);

  // Deleting a note. v1.13 review, blocker 4.
  //
  // `DELETE_NOTE` existed in the reducer and `delete_note` in KIND_DISPATCH,
  // and NOTHING dispatched or enqueued either — the notebook shipped with no
  // way to delete a note at all. The half that would have bitten hardest is
  // the sync half: a note removed on one device would have stayed live on the
  // server and come back on the next reinstall.
  //
  // Sited here rather than in the view because this is where `session` and
  // the outbox live, matching every other delete path in this file.
  const onDeleteNote = useCallback((id) => {
    if (!id) return;
    const pending = noteTimers.current.get(id);
    // Drop any queued upsert for this note first: pushing an edit and then a
    // tombstone for the same note in one drain is two round trips to reach
    // the state one of them describes.
    if (pending?.handle) clearTimeout(pending.handle);
    noteTimers.current.delete(id);
    dispatch({ type: "DELETE_NOTE", id });
    if (session) outbox.enqueue("delete_note", { id });
  }, [session, dispatch]);
  return { onDeleteNote };
}

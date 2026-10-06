// App-wide event wiring: outbox drain/pull triggers and reminder action taps.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { useEffect } from "react";
import { LocalNotifications } from "@capacitor/local-notifications";
import * as outbox from "../lib/outbox.js";
import { ACTION_DONE_ID } from "../lib/planNotifications.js";

export function useOutboxTriggers(requestPullRef) {
  // v1.3 — outbox drain triggers. The outbox holds pending Supabase writes
  // when the device is offline or a sync call failed; this effect re-runs
  // drain on three signals:
  //
  //   1. App cold-start (mount) — catches anything queued in a prior
  //      session that hadn't drained yet.
  //   2. `online` window event — fires when the OS detects network
  //      restoration. Capacitor surfaces this in the Android WebView.
  //   3. `visibilitychange` → visible — fires when the app comes back to
  //      the foreground after being backgrounded. Capacitor maps Android's
  //      onResume here. Useful when the device was online but the user
  //      was away long enough for a retry to make sense.
  //
  // drain() is single-flight inside the outbox (coalesces overlapping
  // calls) so firing it from all three paths is safe.
  //
  // StudyDesk#72 — the same signals now also pull, after the drain, so local
  // edits reach the server before the server's view is merged back. Window
  // `focus` joins them for the desktop edition, where switching between
  // windows never changes `visibilityState`. The pull is throttled inside
  // `requestPullRef` (syncStamps.js), so an alt-tab habit costs nothing.
  useEffect(() => {
    // One-shot on mount.
    void outbox.drain();
    const drainThenPull = () => {
      void Promise.resolve(outbox.drain())
        .catch(() => { /* drain reports its own failures */ })
        .then(() => requestPullRef.current?.());
    };
    function onOnline() { drainThenPull(); }
    function onVisibility() {
      if (document.visibilityState === 'visible') drainThenPull();
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', drainThenPull);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', drainThenPull);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [requestPullRef]);
}

export function useReminderActions(dispatch) {
  // Listen for "Mark done" action-button taps on assignment reminders.
  // The handler dispatches TOGGLE_ASSIGNMENT — since reschedules filter out
  // assignments where done===true, the next scheduling pass naturally drops
  // any further reminders for the just-completed assignment. The reducer's
  // toggle (rather than a one-way mark-done) is fine here because Android
  // auto-dismisses the notification on action tap, so accidental
  // double-taps that would un-toggle aren't reachable.
  useEffect(() => {
    // Hold the listener PROMISE and remove via it. With the old
    // `let handle=null; (async)=>{handle=await add()}` pattern, React 19
    // StrictMode's mount→cleanup→mount runs cleanup before the await resolves
    // (handle still null → .remove() skipped), orphaning the first listener and
    // double-registering — so "Mark done" fired TOGGLE_ASSIGNMENT twice (net
    // no-op). The backButton listener below already uses this safe idiom.
    const handlePromise = LocalNotifications.addListener(
          "localNotificationActionPerformed",
          (event) => {
            // v1.3.1 BUG-14 — body-tap navigation. @capacitor/local-notifications
            // fires this same event for both the "Mark done" action button AND
            // a tap on the notification body itself (actionId === 'tap'). The
            // existing handler only acted on 'done'; body taps fell through and
            // the app opened on whatever screen it was last on instead of the
            // relevant assignments view. Route body taps to the plan view so
            // the user lands on the full assignment list — same target as the
            // ActionsView ("Next Up") would imply but "plan" surfaces all
            // upcoming work, which matches the tap intent better.
            if (event.actionId === "tap") {
              dispatch({ type: "SET_VIEW", view: "plan" });
              return;
            }
            if (event.actionId !== ACTION_DONE_ID) return;
            const assignmentId = event.notification?.extra?.assignmentId;
            if (!assignmentId) return;
            dispatch({ type: "TOGGLE_ASSIGNMENT", id: assignmentId });
          },
        );
    handlePromise.catch((e) => console.warn("[StudyDesk] action listener failed:", e));
    return () => { handlePromise.then((h) => h.remove()).catch(() => {}); };
  }, [dispatch]);
}

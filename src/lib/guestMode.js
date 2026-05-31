// Guest-mode flag — lets users skip the first-launch AuthGate and use
// StudyDesk locally without a Supabase session. Cloud sync (Supabase
// realtime + outbox enqueue) is already gated on `session`, so a guest-
// mode user gets the full local feature set with sync turned off.
//
// Stored in localStorage under `studydesk.guestMode` to match StudyDesk's
// existing flag-storage pattern (the outbox uses localStorage too). The
// Capacitor WebView's localStorage persists across launches on Android;
// only "Clear data" / uninstall wipes it, both of which legitimately
// drop the user back to AuthGate anyway.
//
// State transitions:
//   First launch       → flag absent → AuthGate shown
//   Tap Continue Guest → flag set    → AuthGate dismissed
//   Sign in from guest → flag cleared (AuthGate's nexus/google/email paths)
//   Sign out           → flag cleared (so user lands back on AuthGate)

const KEY = "studydesk.guestMode";

export function isGuestMode() {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setGuestMode(enabled) {
  try {
    if (enabled) {
      localStorage.setItem(KEY, "1");
    } else {
      localStorage.removeItem(KEY);
    }
  } catch {
    /* swallow — best-effort flag */
  }
}

// ── Password recovery state (#52) ──────────────────────────────────────────
//
// The problem this module exists to solve is not "send the email" — that is one
// supabase-js call. It is that **recovery produces a real session**, and this
// app's gate is `session ? app : AuthGate`. So the moment the user proves they
// own the mailbox, they are signed in and the app opens — with their password
// still the one they could not remember. They are in on this device and locked
// out on the next one, which is exactly the state issue #52 was filed from.
//
// So a recovery session has to be distinguishable from an ordinary one until a
// new password has actually been set. That is the flag this module holds, and
// why it is a module rather than state inside AuthGate: AuthGate UNMOUNTS the
// instant a session exists, so it cannot be the thing that remembers why.
//
// Two entry points converge here, deliberately:
//
//   1. A typed code — `verifyOtp({ type: 'recovery' })` in AuthGate, which
//      calls `begin()` itself before it has a session to react to.
//   2. A clicked link — supabase-js detects the recovery token in the URL and
//      emits `PASSWORD_RECOVERY`, which the listener below catches. This is
//      the only signal for that path, and nothing else in the app listens for
//      it, so it has to be caught at module scope: on web the event can fire
//      before any component that cares has mounted.
//
// Both land on the same screen, which is the point — one implementation, two
// entry points, so the two cannot drift.
//
// ── Why sessionStorage ──
//
// A reload in the middle of the flow (the user taps the link a second time, or
// Android restarts the WebView) must not silently drop the user into the app
// with an unknown password. sessionStorage survives that and dies with the
// tab, which is the correct lifetime: a flag that outlived the browser session
// could block the app on a later launch for a recovery nobody is doing any
// more. It is also why `SetPasswordScreen` carries a sign-out escape hatch —
// no flag should be able to trap someone, however short its life.

const KEY = 'studydesk-password-recovery';
const EVENT = 'studydesk:password-recovery-changed';

// The URL as it was when this module was first imported.
//
// This is not defensiveness, it is the only reliable read. supabase-js strips
// its own auth params out of the address bar as part of `detectSessionInUrl`,
// and that runs asynchronously — so by the time any component could look, the
// `type=recovery` that identifies the link may be gone. Module evaluation
// happens during the synchronous import phase, before any promise in the
// client's constructor can advance, so a snapshot taken here is guaranteed to
// predate the cleanup. `main.jsx` imports supabase.js first and this still
// wins, because nothing supabase-js queues can run until that import phase
// yields.
const INITIAL_URL = typeof window !== 'undefined' ? (window.location?.href ?? '') : '';

/**
 * Does this URL name a password recovery?
 *
 * Supabase puts `type=recovery` in the query string under the PKCE flow and in
 * the fragment under the implicit one, and which arrives depends on project
 * settings rather than anything this app controls — so check both rather than
 * betting on one. Exported for the native deep-link path, which gets its URL
 * from an intent instead of the address bar.
 *
 * @param {string} url
 */
export function looksLikeRecovery(url) {
  if (!url) return false;
  // One test over the whole string: the marker is the same token in either
  // position, and parsing two URL halves to ask one question is more code with
  // more ways to be wrong.
  return /[?&#]type=recovery(?:&|$)/.test(url);
}

// Mirrors the stored flag so a read never depends on storage being readable
// (private mode, a locked-down WebView). Storage is the durable copy; this is
// the authority for the current page.
let pending = read();

function read() {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function write(value) {
  try {
    if (value) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    /* in-memory `pending` still carries the flow through this page */
  }
}

function announce() {
  try {
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* no window (a check script importing this module) — nothing to notify */
  }
}

/** True while a recovery is in flight and no new password has been set yet. */
export function isRecoveryPending() {
  return pending;
}

/** Enter the recovery flow. Idempotent. */
export function beginRecovery() {
  if (pending) return;
  pending = true;
  write(true);
  announce();
}

/** Leave it — the password was set, or the user backed out. Idempotent. */
export function endRecovery() {
  if (!pending) return;
  pending = false;
  write(false);
  announce();
}

/**
 * Subscribe to changes. Returns an unsubscribe function.
 * @param {() => void} cb
 */
export function subscribeRecovery(cb) {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

/**
 * Start listening for Supabase's own recovery signal.
 *
 * Called once from `main.jsx`, BEFORE render, for the same reason
 * `bootstrapTheme()` is: on web, supabase-js consumes the recovery token out
 * of the URL during client construction, so `PASSWORD_RECOVERY` can be emitted
 * before React has mounted anything. A listener installed inside a component
 * would miss it and the user would be dropped into the app, signed in, with
 * the password they came to change.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 */
export function watchForRecovery(supabase) {
  // The link path, read off the URL this page was opened with. Deliberately
  // first and deliberately not dependent on which event supabase-js decides to
  // emit for a recovery token: under PKCE it exchanges the code and reports an
  // ordinary SIGNED_IN, and a flow that only worked when PASSWORD_RECOVERY
  // happened to fire would drop the user into the app with the password they
  // came to change.
  if (looksLikeRecovery(INITIAL_URL)) beginRecovery();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') beginRecovery();
    // A sign-out ends any flow: there is no longer a user whose password this
    // screen could be setting, and leaving the flag up would show the
    // set-password screen over the next person's sign-in.
    if (event === 'SIGNED_OUT') endRecovery();
  });
}

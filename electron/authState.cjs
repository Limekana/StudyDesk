// v1.16 (limecore#3) — OAuth `state` for the desktop loopback listener.
//
// Until now the listener accepted a callback whenever a sign-in was pending —
// one module-level `authPending` boolean. The listener is reachable by
// anything running as this user, so any local process that hit /callback
// during a sign-in could hand the app a code of its choosing, and by getting
// there first it consumed the pending flag and broke the user's real sign-in.
//
// PKCE already makes an injected code fail at redemption: the verifier never
// leaves the renderer. What `state` adds is that the listener itself can tell
// its own callback from anyone else's, so a foreign request is refused before
// it reaches the renderer and cannot disarm the genuine one.
//
// Supabase consumes the provider's own `state` at /auth/v1/callback and does
// not forward it, so this is our own nonce, carried on the loopback redirect
// URI: `http://127.0.0.1:<port>/callback?state=<nonce>`. Both halves of that
// were verified against the live project on 2026-09-25 before this was written:
//   - GoTrue keeps a query string on `redirect_to` and appends its own
//     parameters after it, so the nonce comes back on the callback.
//   - The redirect allow-list is glob-matched over the WHOLE URL, query
//     included, so each port needs a `…/callback**` entry. The owner added
//     those alongside the exact `…/callback` entries, which stay: every
//     desktop build shipped before this one still sends the bare URI.
//
// Kept byte-identical between NCC and StudyDesk. Pure: no Electron, no
// sockets; the clock and the nonce source are injectable for the tests.
'use strict';

const crypto = require('node:crypto');

/** Long enough for a consent screen, a 2FA prompt and a password manager;
 *  short enough that an abandoned attempt does not stay armed all day. */
const STATE_TTL_MS = 10 * 60 * 1000;

function createAuthState({
  now = () => Date.now(),
  newNonce = () => crypto.randomBytes(32).toString('base64url'),
  ttlMs = STATE_TTL_MS,
} = {}) {
  let pending = null; // { nonce, expiresAt }

  /**
   * Arm a sign-in and return the URL to open, or null to refuse.
   *
   * `providerUrl` is the Supabase authorize URL the renderer built. Its
   * `redirect_to` must be exactly this launch's loopback URI — anything else
   * would not come back here, so there is nothing for this listener to guard
   * and the request is refused rather than opened. A new arm replaces any
   * earlier one: the user pressed the button again, and only the latest tab
   * should be able to finish.
   */
  function arm(providerUrl, redirectUri) {
    if (typeof providerUrl !== 'string' || typeof redirectUri !== 'string' || !redirectUri) {
      return null;
    }
    let url;
    try {
      url = new URL(providerUrl);
    } catch {
      return null;
    }
    // An OAuth leg over plain http would leak the flow; `openExternally`
    // tolerates http for ordinary links, so the check has to live here.
    if (url.protocol !== 'https:') return null;
    if (url.searchParams.get('redirect_to') !== redirectUri) return null;

    const nonce = newNonce();
    const back = new URL(redirectUri);
    back.searchParams.set('state', nonce);
    url.searchParams.set('redirect_to', back.toString());
    pending = { nonce, expiresAt: now() + ttlMs };
    return url.toString();
  }

  /** Forget the pending sign-in, e.g. when the browser could not be opened. */
  function disarm() {
    pending = null;
  }

  /**
   * Judge a callback's `state`:
   *   'ok'       — the pending sign-in's nonce; consumed, so a replay fails.
   *   'none'     — nothing is pending; an unsolicited request.
   *   'expired'  — pending, but past its TTL; cleared.
   *   'mismatch' — wrong or missing state. The pending sign-in is KEPT, so a
   *                stray request cannot cancel the user's real one.
   */
  function check(state) {
    if (!pending) return 'none';
    if (now() > pending.expiresAt) {
      pending = null;
      return 'expired';
    }
    if (typeof state !== 'string' || !safeEqual(state, pending.nonce)) return 'mismatch';
    pending = null;
    return 'ok';
  }

  return { arm, disarm, check, isArmed: () => pending !== null };
}

// Constant-time on equal lengths. The nonce length is fixed and public, so
// returning early on a length difference leaks nothing.
function safeEqual(a, b) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { createAuthState, STATE_TTL_MS };

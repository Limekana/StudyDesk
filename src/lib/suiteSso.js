// v1.4 — cross-app SSO consumer (StudyDesk side).
//
// Mirror of LimeLog's suiteSso.ts. Queries NCC's signature-protected
// SessionContentProvider and applies the returned bundle to StudyDesk's
// Supabase client. See LimeLog's wrapper for the full design rationale.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from './supabase.js';

const SuiteSso = registerPlugin('SuiteSso');

// How long any single network step in the SSO path may take before we stop
// waiting and fall through to the next option.
//
// v1.13 review, item G. `adoptSession` awaited `functions.invoke` and
// `setSession` with no timeout, no AbortController and no Promise.race, from a
// session-init effect that renders a loading label until it settles. A request
// that never settles — not one that fails, one that HANGS — therefore pinned
// the app on that label indefinitely. An OS-level TCP timeout on a
// half-connected network is minutes, not seconds, and a captive portal or a
// device with partial connectivity (the test phone was Tailscale-only, with no
// general internet path) reproduces it exactly. So does a normal user on a
// hotel wifi that accepts the connection and then drops the traffic.
//
// Eight seconds is chosen to be longer than any plausible successful round
// trip on a slow mobile connection and far shorter than a TCP timeout. The
// cost of expiring too early is one degraded sign-in; the cost of not
// expiring at all is an app that never opens.
const SSO_STEP_TIMEOUT_MS = 8000;

/** Resolve to `{ timedOut: true }` rather than hanging forever.
 *
 *  Deliberately resolves rather than rejects: every caller here already
 *  branches on a result object, and a timeout is an expected outcome on a bad
 *  network, not an exceptional one. The timer is always cleared, so a slow
 *  call that eventually settles does not leave a pending handle behind. */
function withTimeout(promise, ms = SSO_STEP_TIMEOUT_MS) {
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    expiry,
  ]).finally(() => clearTimeout(timer));
}


// -- v1.10: inherit the IDENTITY, not the refresh token -------------------
// This used to call supabase.auth.setSession() with NCC's tokens, which put
// this app into NCC's refresh-token rotation family. Supabase rotates a
// refresh_token on every use and treats a second presentation of a spent one
// as theft, revoking the whole family - so whichever sibling woke up second
// signed all three apps out. That was the "logged out every day or two"
// report, and the server-side record agreed: six sessions died in seventeen
// days, all Android, each one minutes after a successful rotation by another
// app rather than after any idle period.
//
// Now we hand NCC's access_token to the `suite-session` Edge Function, which
// verifies it and returns a one-time credential; redeeming it gives this app a
// session with its own independent rotation chain. The apps can no longer
// revoke one another.
//
// The setSession path is kept as a fallback for one reason: if the function is
// unreachable (offline, not yet deployed, an older backend) the old behaviour
// is still better than refusing to sign in. It is strictly the degraded path -
// it restores the collision risk - so it says so in the log.
async function adoptSession(bundle) {
  try {
    const invoked = await withTimeout(supabase.functions.invoke('suite-session', {
      body: { app: 'studydesk' },
      headers: { Authorization: 'Bearer ' + bundle.access_token },
    }));
    if (invoked.timedOut) {
      console.warn('[sso] suite-session timed out, using shared-token fallback');
      return fallbackSession(bundle);
    }
    if (invoked.error) throw invoked.error;
    const { data, error } = invoked.value || {};
    if (error) {
      console.warn('[sso] suite-session unavailable, using shared-token fallback:', error.message);
    } else if (data && data.token_hash) {
      // v1.11 — try each credential type rather than betting on one.
      //
      // `suite-session` mints with `generateLink({ type: 'magiclink' })`, but
      // GoTrue has no `magiclink` value in its `one_time_token_type` enum — it
      // files a magiclink under `recovery_token`. Which string `verifyOtp`
      // wants for that row has moved between GoTrue versions, and getting it
      // wrong fails as `403 "One-time token not found"`, which the server logs
      // show happening.
      //
      // That failure is not cosmetic: it drops us to the shared-token fallback
      // below, which is exactly the refresh-token collision this whole SSO
      // rewrite exists to prevent. The server-side record shows the result —
      // healthy rotation for hours, then the entire token family revoked and a
      // fresh session seconds later, i.e. all three apps signed out.
      //
      // Trying the three plausible types costs one round trip on the unlucky
      // path and nothing on the lucky one, and it stops a version difference
      // in Auth from silently re-enabling a daily logout.
      let otpErr = null;
      for (const type of ['magiclink', 'email', 'recovery']) {
        const verified = await withTimeout(
          supabase.auth.verifyOtp({ token_hash: data.token_hash, type }),
        );
        // A hung verify is not worth retrying with another type — the network
        // is the problem, not the credential type.
        if (verified.timedOut) {
          console.warn('[sso] verifyOtp timed out, using shared-token fallback');
          return fallbackSession(bundle);
        }
        const { error } = verified.error ? { error: verified.error } : (verified.value || {});
        if (!error) return { ok: true, email: bundle.email };
        otpErr = error;
        // A consumed one-time token cannot be retried with another type, so
        // stop rather than burning the remaining attempts on a dead credential.
        if (!/not found|invalid|expired/i.test(error.message || '')) break;
      }
      console.warn('[sso] one-time credential rejected, using fallback:', otpErr && otpErr.message);
    }
  } catch (e) {
    console.warn('[sso] suite-session threw, using shared-token fallback:', e.message);
  }

  return fallbackSession(bundle);
}

// Degraded path - shares NCC's refresh token, so the revocation collision
// this release exists to fix is possible again until the function is back.
//
// Bounded too. This is the path every timeout above falls through to, and a
// fallback that can itself hang forever would just move item G's blank screen
// one call further down.
async function fallbackSession(bundle) {
  const applied = await withTimeout(supabase.auth.setSession({
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
  }));
  if (applied.timedOut) {
    return { ok: false, reason: 'Timed out applying the inherited session. Sign in normally.' };
  }
  if (applied.error) {
    return { ok: false, reason: 'Supabase rejected the inherited session: ' + applied.error.message };
  }
  const { error } = applied.value || {};
  if (error) {
    return { ok: false, reason: 'Supabase rejected the inherited session: ' + error.message };
  }
  return { ok: true, email: bundle.email };
}

/** Pull NCC's active session and apply it to StudyDesk's Supabase client.
 *  No-op on web. Returns { ok, reason?, email? }. */
export async function inheritFromNexus() {
  if (!Capacitor.isNativePlatform()) {
    return { ok: false, reason: 'Cross-app sign-in is only available on Android.' };
  }
  let queryResult;
  try {
    queryResult = await SuiteSso.getNexusSession();
  } catch (e) {
    return { ok: false, reason: 'SSO plugin unavailable: ' + e.message };
  }
  if (!queryResult.available) {
    return { ok: false, reason: queryResult.reason || 'No Nexus session available.' };
  }
  let bundle;
  try {
    bundle = JSON.parse(queryResult.bundleJson || '{}');
  } catch {
    return { ok: false, reason: 'Nexus returned a malformed session bundle.' };
  }
  if (!bundle.access_token || !bundle.refresh_token) {
    return { ok: false, reason: 'Nexus session missing required tokens.' };
  }
  return adoptSession(bundle);
}

// v1.4 — cross-app SSO consumer (StudyDesk side).
//
// Mirror of LimeLog's suiteSso.ts. Queries NCC's signature-protected
// SessionContentProvider and applies the returned bundle to StudyDesk's
// Supabase client. See LimeLog's wrapper for the full design rationale.

import { Capacitor, registerPlugin } from '@capacitor/core';
import { supabase } from './supabase.js';

const SuiteSso = registerPlugin('SuiteSso');


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
    const { data, error } = await supabase.functions.invoke('suite-session', {
      body: { app: 'studydesk' },
      headers: { Authorization: 'Bearer ' + bundle.access_token },
    });
    if (error) {
      console.warn('[sso] suite-session unavailable, using shared-token fallback:', error.message);
    } else if (data && data.token_hash) {
      const { error: otpErr } = await supabase.auth.verifyOtp({
        token_hash: data.token_hash,
        type: 'email',
      });
      if (!otpErr) return { ok: true, email: bundle.email };
      console.warn('[sso] one-time credential rejected, using fallback:', otpErr.message);
    }
  } catch (e) {
    console.warn('[sso] suite-session threw, using shared-token fallback:', e.message);
  }

  // Degraded path - shares NCC's refresh token, so the revocation collision
  // this release exists to fix is possible again until the function is back.
  const { error } = await supabase.auth.setSession({
    access_token: bundle.access_token,
    refresh_token: bundle.refresh_token,
  });
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

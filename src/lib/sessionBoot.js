// v1.18.1 (StudyDesk#142) — cold start must not wait on the network.
//
// getSession() answers from storage at once while the access token is valid,
// and when nobody is signed in. Only an EXPIRED token makes it refresh first,
// and offline that refresh retries with backoff: ~51 s measured with auth-js
// 2.106 and fetch failing, after which it answers `session: null` and emits
// INITIAL_SESSION with null, although the stored session (and its refresh
// token) is intact. App took that as "signed out": "Loading…" for ~51 s, then
// AuthGate, with the local data out of reach until the network came back.
//
// So getSession() gets a short head start; past that the app opens on the
// stored session, marked unverified, and the real answer settles in the
// background. "Could not ask" (a retryable fetch error) never signs anyone
// out; a real answer (no session, a refresh token the server rejected) does.
// Same approach as NCC#141 and LimeLog#67.
import { isAuthRetryableFetchError } from '@supabase/supabase-js';

export const SESSION_HEAD_START_MS = 1500;

/**
 * @param {object} o
 * @param {object} o.auth               supabase.auth
 * @param {() => Promise<object|null>} o.readStoredSession
 * @param {() => Promise<object|null>} o.inherit  called when there is truly no
 *        session; returns one adopted from elsewhere (NCC), or null
 * @param {(session: object|null, event: string) => void} o.apply
 * @param {number} [o.headStartMs]
 * @returns {{ cancel(): void }}
 */
export function startSessionBoot({ auth, readStoredSession, inherit, apply, headStartMs = SESSION_HEAD_START_MS }) {
  let unverified = false;
  let cancelled = false;
  // A SIGNED_IN or SIGNED_OUT arrived: the user (or the server) has decided,
  // so nothing the boot found on its own (the stored session, an inherited
  // one) may be applied over it.
  let decided = false;
  // Set by holdSignedOut() after a sign-out that could not reach the server.
  // A refresh already in flight would otherwise save the old session again
  // and bring it back; while held, no session is applied until the sign-out
  // call itself has settled.
  let heldOut = false;

  // The listener goes on FIRST, so an answer that lands after cold start (a
  // refresh that finally succeeded, a sign-out the server asserted) is seen.
  const { data: sub } = auth.onAuthStateChange((event, s) => {
    if (cancelled) return;
    if (heldOut && s) return;
    // "Could not ask", not "signed out" — see above. A real sign-out still
    // arrives as SIGNED_OUT.
    if (event === 'INITIAL_SESSION' && !s && unverified) return;
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') decided = true;
    unverified = false;
    apply(s, event);
  });

  const showStored = async () => {
    if (decided || heldOut) return false;
    const stored = await readStoredSession();
    if (cancelled || decided || heldOut || !stored) return false;
    unverified = true;
    apply(stored, 'STORED_SESSION');
    return true;
  };

  const settle = async ({ session, error }) => {
    if (cancelled || decided || heldOut) return;
    if (session) {
      unverified = false;
      apply(session, 'GET_SESSION');
      return;
    }
    if (error && isAuthRetryableFetchError(error)) {
      // Keep what is on screen; open on the stored session if nothing is.
      if (unverified || (await showStored())) return;
    }
    const inherited = await inherit();
    // A sign-in made on AuthGate while this ran wins over it.
    if (cancelled || decided || heldOut) return;
    unverified = false;
    apply(inherited, 'GET_SESSION');
  };

  (async () => {
    const answer = auth.getSession().then(
      ({ data, error }) => ({ session: data?.session ?? null, error }),
      (error) => ({ session: null, error }),
    );
    let timer;
    const first = await Promise.race([
      answer,
      new Promise((res) => { timer = setTimeout(() => res(null), headStartMs); }),
    ]);
    clearTimeout(timer);
    if (cancelled) return;
    if (first) {
      await settle(first);
      return;
    }
    // Still refreshing: open on the account this device already has. Nothing
    // in the UI uses the stored token as a credential; every request goes
    // through supabase-js, which waits for the refresh itself.
    await showStored();
    await settle(await answer);
  })();

  return {
    cancel() {
      cancelled = true;
      sub.subscription.unsubscribe();
    },
    /** true after a local-only sign-out; false once its signOut call settled. */
    holdSignedOut(on) {
      heldOut = on;
      if (on) {
        decided = true;
        unverified = false;
      }
    },
  };
}

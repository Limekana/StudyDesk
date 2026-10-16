// v1.18.1 (limecore#59 §1) — which account the local data on this device
// belongs to.
//
// Local state and the outbox were wiped only on an explicit sign-out. When a
// session ended any other way (a refresh the server refused, a revoked
// session) and a different account signed in, by hand or through the NCC
// auto sign-in, that account's pull merged into the first account's local
// data, and the reconciler uploaded the first account's unsynced rows under
// the second account's user id. Nothing recorded whose data it was.
//
// Set when a session is adopted; cleared by an explicit sign-out (which wipes
// the data itself). A guest's data has no owner, so the first account to sign
// in takes it, as before.

const KEY = 'studydesk.ownerUserId';

// v1.18.1 (StudyDesk#169) — which copy of the local data this page holds.
//
// On the web, tabs share localStorage but each holds its own copy of the data
// in memory. When another tab wiped the shared data (a different account
// signed in there, or a sign-out), this page went on showing the old
// account's copy, wrote it back to storage, and queued its unsynced rows
// under whoever was signed in now. KEY alone cannot tell this page: by the
// time auth-js reports the new sign-in here, the other tab has already
// claimed the data for it. So every wipe writes a new random value here, and
// a page whose value no longer matches the stored one is holding a copy that
// is gone (isPageStale). Random rather than a counter: two tabs bumping at
// once must not land on the same value.
const EPOCH_KEY = 'studydesk.localDataEpoch';

function readEpoch() {
  try {
    return localStorage.getItem(EPOCH_KEY);
  } catch {
    return null;
  }
}

// Read when the module loads, which is before App reads the data from storage.
let pageEpoch = readEpoch();

/** Call when this page replaces the local data (a wipe). Other pages then
 *  find themselves stale; this one does not. */
export function markLocalDataReplaced() {
  try {
    localStorage.setItem(EPOCH_KEY, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  } catch { /* best effort */ }
  // Read back rather than assumed: if the write failed, this page must not
  // call itself stale for the rest of its life.
  pageEpoch = readEpoch();
}

/** True when another page has wiped the local data since this page read it:
 *  what this page holds in memory belongs to an account (or a guest session)
 *  that is no longer this device's. Such a page must not write to storage or
 *  to the server, and should reload. */
export function isPageStale() {
  return readEpoch() !== pageEpoch;
}

// Past the sign-out wait in SettingsView (3 s), after which a sign-out that
// could not reach the server has removed the stored session itself.
export const STALE_RELOAD_FALLBACK_MS = 5000;
const RELOAD_NOTICE_KEY = 'studydesk.staleReloaded';
let reloading = false;

/** Reloads a stale page, once, so it starts from what is in storage now.
 *  Leaves a per-tab flag so the reloaded page can say why. */
export function reloadStalePage() {
  if (reloading) return;
  reloading = true;
  try { sessionStorage.setItem(RELOAD_NOTICE_KEY, '1'); } catch { /* best effort */ }
  try { window.location.reload(); } catch { /* no window */ }
}

/** True once after a reload done by reloadStalePage. */
export function takeStaleReloadNotice() {
  try {
    if (sessionStorage.getItem(RELOAD_NOTICE_KEY) !== '1') return false;
    sessionStorage.removeItem(RELOAD_NOTICE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Calls `onStale` once when another page wipes the local data. Returns an
 *  unsubscriber. The `storage` event fires only in OTHER pages, which is what
 *  is wanted; a null key means another page cleared all of localStorage. */
export function watchPageStale(onStale) {
  if (typeof window === 'undefined') return () => {};
  let fired = false;
  const handler = (e) => {
    if (fired || (e.key !== EPOCH_KEY && e.key !== null)) return;
    if (!isPageStale()) return;
    fired = true;
    onStale();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export function readOwner() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeOwner(userId) {
  try {
    localStorage.setItem(KEY, userId);
  } catch { /* best effort */ }
}

export function clearOwner() {
  try {
    localStorage.removeItem(KEY);
  } catch { /* best effort */ }
}

/** Records `userId` as the owner. Returns true when the local data belonged
 *  to a DIFFERENT account, i.e. the caller must wipe it before this account
 *  pulls or pushes anything. No owner yet (first sign-in, or guest data)
 *  adopts the data as before. */
export function claimForUser(userId) {
  if (!userId) return false;
  const owner = readOwner();
  if (owner === userId) return false;
  // v1.18.1 (StudyDesk#169): before the new owner is written, so a page that
  // sees the new owner also sees that its copy is stale. The wipe that
  // follows marks it again, after the data is gone.
  if (owner !== null) markLocalDataReplaced();
  writeOwner(userId);
  return owner !== null;
}

/** The user id (`sub`) inside an access token, without verifying it: used
 *  only to decide whether to adopt a session, never as a credential. */
export function tokenUserId(accessToken) {
  try {
    const seg = String(accessToken).split('.')[1];
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return typeof json.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

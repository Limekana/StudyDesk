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

// v1.18.1 (limecore#59 §1) — everything on this device that belongs to the
// signed-in account, apart from the reducer state (the caller dispatches
// RESET_AFTER_SIGNOUT; this module has no dispatch). One list, used by
// sign-out, account deletion and a different account signing in, so the three
// cannot drift apart again: calendar feeds were missed by all of them, and a
// feed's ICS address is a private capability URL whose poll then imported the
// previous account's deadlines into the next one.
import * as outbox from './outbox.js';
import { clearEntitlement } from './entitlement.js';
import { clearAvatarCache } from './profile.js';
import { markLocalDataReplaced } from './deviceOwner.js';

export const ACCOUNT_LOCAL_KEYS = [
  'studydesk-calendar-feeds',
  'studydesk-calendar-feed-items',
  'sd-timer',
];

export function wipeAccountLocalData() {
  outbox.clear();
  clearEntitlement();
  clearAvatarCache();
  for (const k of ACCOUNT_LOCAL_KEYS) {
    try { localStorage.removeItem(k); } catch { /* private mode */ }
  }
  // v1.18.1 (StudyDesk#169): the stored copy of the reducer state goes now,
  // not when the caller's RESET_AFTER_SIGNOUT is persisted on the next
  // render. Another tab that reloads in between would read the previous
  // account's data back from it. Then other tabs are told their copy is gone;
  // last, so a tab that sees that also sees the data removed.
  try { localStorage.removeItem('studydesk-v1'); } catch { /* private mode */ }
  markLocalDataReplaced();
}

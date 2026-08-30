// v1.12 Item 0 — retention instrumentation.
//
// One row per user per app per day, written when the app comes to the
// foreground. That is the whole feature; everything below is about the four
// ways a naive version of it goes wrong.
//
// **Foreground, not sign-in.** Sign-in is precisely the event `SESS-1`
// corrupted — the daily forced sign-out meant `last_sign_in_at` recorded a bug,
// not a habit. "Came back" is the app being opened.
//
// **Local date, not UTC.** `new Date().toISOString().slice(0,10)` — the
// idiom already used elsewhere in this codebase — is the *UTC* date. For a user
// in UTC+3 opening the app at 01:00 on the 30th, that records the 29th, and two
// consecutive real days can collapse into one bucket or split into three. Day
// bucketing is the entire point of the table, so the day has to be the user's.
// This is the same class of bug as the `datetime-local`/`toISOString()` drift
// that NCC's 1.10.1 hotfix existed to fix.
//
// **Queued, not pushed.** A cold start can foreground before `adoptSession()`
// has resolved, and RLS rejects a write with no session; the phone is also
// frequently offline at exactly that moment. The outbox turns both into a retry
// instead of a lost day.
//
// **Never queued for a guest.** The outbox deliberately never drops a failed
// item — it retries forever so nothing is silently lost — and `drain()` stops
// at the first failure. A guest has no `user_id`, so an enqueued open would
// fail permanently and wedge every real mutation behind it. Guests are skipped
// outright; they have no server-side identity to attribute a day to.

import { Capacitor } from '@capacitor/core';
import * as outbox from './outbox.js';
import { isGuestMode } from './guestMode.js';
import pkg from '../../package.json';

const APP = 'studydesk';
const LAST_KEY = 'studydesk.lastAppOpen';

/** The user's own calendar date, not UTC's. See the header. */
function localDay(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * One of 'android' | 'desktop' | 'web' — the values the table's CHECK allows.
 *
 * Capacitor reports the Electron desktop build as 'web', since from the web
 * layer's point of view that is what it is. The two are worth telling apart
 * here: a desktop user and a phone user are different retention stories.
 */
function platform() {
  if (Capacitor.isNativePlatform()) {
    return Capacitor.getPlatform() === 'android' ? 'android' : 'web';
  }
  if (typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent)) {
    return 'desktop';
  }
  return 'web';
}

/**
 * Record today's open, at most once per local day.
 *
 * The localStorage guard is a cost control, not correctness: the composite
 * primary key already makes the write idempotent, so a duplicate would be
 * harmless — it would just be a wasted queue item on every tab switch.
 *
 * Returns true when something was queued, so callers can be tested.
 */
export function recordAppOpen() {
  if (isGuestMode()) return false;
  const today = localDay();
  try {
    if (localStorage.getItem(LAST_KEY) === today) return false;
  } catch {
    // Private mode or blocked storage — fall through and queue. The primary
    // key still collapses the duplicate server-side.
  }
  outbox.enqueue('record_app_open', {
    app: APP,
    appVersion: pkg.version,
    platform: platform(),
    openedOn: today,
  });
  try { localStorage.setItem(LAST_KEY, today); } catch { /* see above */ }
  return true;
}

/**
 * Wire foreground detection. Returns an unsubscribe function.
 *
 * Both triggers are needed: mount covers a cold start, and visibilitychange
 * covers the far commoner case of the app being resumed from the background
 * days later without the process ever having died.
 */
export function watchAppOpens() {
  recordAppOpen();
  if (typeof document === 'undefined') return () => {};
  const onVisible = () => {
    if (document.visibilityState === 'visible') recordAppOpen();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => document.removeEventListener('visibilitychange', onVisible);
}

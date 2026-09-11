// ── Durable local writes ───────────────────────────────────────────────────
//
// **The bug this exists to close.** Every persistence site in this app was
// shaped like this:
//
//     try { localStorage.setItem("studydesk-v1", JSON.stringify(state)); } catch {}
//
// A bare catch on the write that IS the app's database. When that write fails
// the app does not stop, warn, or retry — it keeps running on in-memory state
// that will not exist after the next cold start. The user goes on studying,
// the timer goes on logging, and everything since the last SUCCESSFUL write
// disappears when they reopen the app.
//
// That is the reported loss, exactly:
//
//   > "Offline sessions never synced; an app update then destroyed them.
//      Five hours of logged study, gone from every device."   (`1cab0fb7`)
//
// The two halves compound, and the person they compound for is precisely the
// offline user:
//
//   1. Offline, so nothing reaches the server and the outbox grows instead.
//   2. The outbox lives in the SAME localStorage as the state snapshot and
//      the same origin quota. A long offline stretch inflates it.
//   3. At the quota ceiling both writes begin to fail — and both were silent.
//   4. Relaunch (an app update is just a relaunch that people notice) reads
//      the last write that actually landed. Everything after it is gone, and
//      because step 1 means the server never saw it either, it is gone from
//      every device.
//
// Nothing in that chain requires an app update to be special. The update is
// when the user finds out.
//
// ── What this module changes ─────────────────────────────────────────────
//
// A failed write is now a REPORTED event. That is the whole idea: this module
// cannot conjure space, and pretending otherwise would be the same lie in a
// nicer wrapper. What it can do is make the failure visible while the data
// still exists in memory, so the user has the chance to act on it — which is
// the difference between "the app told me and I exported" and "five hours
// gone".
//
// It also tries, in order, the three things that are actually worth trying
// before giving up:
//
//   1. Write.
//   2. On a quota error, drop the RECOVERABLE caches (signed-URL caches and
//      similar) and write again. These are re-derivable from the server and
//      are the correct thing to sacrifice for user data.
//   3. Report failure loudly and keep the last known-good bytes untouched.
//
// Step 3 matters as much as step 2: a partially-written key is worse than an
// old complete one, and `setItem` on a quota failure leaves the previous
// value in place, so "do not clear on failure" is a real guarantee rather
// than an aspiration.

const LISTENERS = new Set();

// Caches that may be dropped to make room for user data. Every key here must
// be RE-DERIVABLE — from the server, or by recomputation — because dropping
// it is silent by design. Anything a user typed is not eligible, ever.
//
// Deliberately a hand-written list rather than a prefix rule: a prefix rule
// would happily evict `studydesk-v1` the day someone renames it, and the
// failure mode of getting this wrong is the exact data loss above.
const EVICTABLE = [
  'studydesk.avatarCache',   // signed URLs; re-fetched on next render
  'studydesk-sync',          // last-sync bookkeeping; re-derived on next pull
  'studydesk.lastAppOpen',   // telemetry de-dupe; a repeat open is harmless
];

let lastFailure = null;

/** Current write health. `null` when the last write succeeded. */
export function storageFailure() {
  return lastFailure;
}

/** Clear the failure flag — call after a write succeeds again. */
function clearFailure() {
  if (!lastFailure) return;
  lastFailure = null;
  notify();
}

function notify() {
  for (const fn of LISTENERS) {
    try { fn(lastFailure); } catch { /* a bad listener must not break a write */ }
  }
  try {
    window.dispatchEvent(new CustomEvent('studydesk-storage-health'));
  } catch { /* non-window environment */ }
}

/** Subscribe to write-health changes. Returns an unsubscribe function. */
export function onStorageHealth(fn) {
  LISTENERS.add(fn);
  return () => LISTENERS.delete(fn);
}

// A quota error is reported inconsistently across engines: Chrome/Android
// WebView throw DOMException code 22 `QuotaExceededError`, Firefox uses code
// 1014 `NS_ERROR_DOM_QUOTA_REACHED`, and Safari in private mode historically
// threw a plain error. Name-matching alone misses cases; code-matching alone
// misses others. Check both, then fall back to the message.
function isQuotaError(e) {
  if (!e) return false;
  const name = String(e.name || '');
  const code = Number(e.code);
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (code === 22 || code === 1014) return true;
  return /quota|storage.*full|exceeded/i.test(String(e.message || ''));
}

function evictRecoverable() {
  let freed = 0;
  for (const key of EVICTABLE) {
    try {
      const v = localStorage.getItem(key);
      if (v == null) continue;
      freed += v.length;
      localStorage.removeItem(key);
    } catch { /* if we cannot even remove, there is nothing else to try */ }
  }
  return freed;
}

/**
 * Write a JSON-serialisable value, reporting failure instead of swallowing it.
 *
 * @param {string} key
 * @param {unknown} value
 * @param {object} [opts]
 * @param {boolean} [opts.critical=false]  true for user data. A critical
 *        write that fails raises the app-wide storage-failure state; a
 *        non-critical one (a UI preference) does not, because losing which
 *        sub-tab was open is not worth an alarm.
 * @returns {{ok: boolean, error?: Error, evicted?: number}}
 */
export function writeJson(key, value, { critical = false } = {}) {
  let serialised;
  try {
    serialised = JSON.stringify(value);
  } catch (e) {
    // A cyclic or non-serialisable value is a programming error, not a
    // storage one. Report it as itself rather than as a quota problem.
    if (critical) {
      lastFailure = { key, reason: 'serialise', message: String(e?.message || e), at: new Date().toISOString() };
      notify();
    }
    return { ok: false, error: e };
  }

  try {
    localStorage.setItem(key, serialised);
    if (critical) clearFailure();
    return { ok: true };
  } catch (first) {
    if (!isQuotaError(first)) {
      // Private mode, a disabled-storage policy, a corrupted profile. Not
      // something eviction can fix, so do not thrash the caches for nothing.
      if (critical) {
        lastFailure = { key, reason: 'blocked', message: String(first?.message || first), at: new Date().toISOString() };
        notify();
      }
      return { ok: false, error: first };
    }

    // Quota. Sacrifice what can be rebuilt, then try once more. One retry,
    // not a loop: if dropping every recoverable cache did not make room, the
    // next attempt will not either, and a loop here would freeze the UI
    // thread on the exact write that is already failing.
    const evicted = evictRecoverable();
    try {
      localStorage.setItem(key, serialised);
      if (critical) clearFailure();
      return { ok: true, evicted };
    } catch (second) {
      if (critical) {
        lastFailure = {
          key,
          reason: 'quota',
          message: String(second?.message || second),
          evicted,
          at: new Date().toISOString(),
        };
        notify();
      }
      return { ok: false, error: second, evicted };
    }
  }
}

/**
 * Read and parse. Returns `fallback` for a missing key, malformed JSON, or an
 * unreadable store — three situations the caller cannot usefully tell apart
 * and all of which mean "there is nothing here".
 */
export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Roughly how many bytes this origin is holding, and how much of it is ours.
 *
 * Approximate on purpose. There is no API for the real figure, and the
 * browser's own accounting counts UTF-16 code units plus per-key overhead
 * that varies by engine. This is for showing a user why a write failed, not
 * for capacity planning, and a number that is honestly labelled approximate
 * is more useful than no number at all.
 */
export function approximateUsage() {
  let total = 0;
  let ours = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k == null) continue;
      const v = localStorage.getItem(k) || '';
      // Two bytes per UTF-16 unit, plus the key itself, which is stored too.
      const size = (k.length + v.length) * 2;
      total += size;
      if (k.startsWith('studydesk')) ours += size;
    }
  } catch {
    return null;
  }
  return { total, ours };
}

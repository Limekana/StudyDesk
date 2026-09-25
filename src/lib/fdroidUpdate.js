// v1.16 (#67) — "a newer StudyDesk is on F-Droid", Android only.
//
// Why: half of all feedback ever received came from 1.10.1, the version
// F-Droid served for three weeks, including reports of bugs long fixed. The
// app had no way to say a newer version existed. Desktop has its own updater
// (desktopUpdate.js) and the web build is always current, so this is Android.
//
// Rules, all from the issue:
//   - F-Droid's own API, never GitHub Releases. F-Droid lags GitHub by one to
//     three days, and announcing a version the user cannot install yet is
//     worse than saying nothing.
//   - At most one request per 24 h. The attempt time is recorded whatever the
//     outcome, so a flaky connection cannot turn into a request per launch.
//   - Silent on every failure. Offline, an HTTP error, a malformed answer or a
//     package F-Droid does not know all mean "no notice", never an error.
//   - Never on the startup path: the caller fires it after first paint.
//   - Dismissing hides that version only; the next one is announced again.
//   - A Settings switch (default on) that stops the request entirely, as the
//     privacy policy promises (NCC#50). Off means no network call, not merely
//     no notice. The request carries nothing about the user: it is a plain GET
//     for a public package record.
//
// The request goes through CapacitorHttp (native), not fetch: f-droid.org's
// API sends no CORS headers, so a WebView fetch from the app origin would be
// refused before it left the device.
import { useSyncExternalStore } from 'react';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { App } from '@capacitor/app';

const PACKAGE = 'com.StudyDesk.app';
export const FDROID_PAGE = `https://f-droid.org/packages/${PACKAGE}/`;
const API = `https://f-droid.org/api/v1/packages/${PACKAGE}`;
const DAY_MS = 24 * 60 * 60 * 1000;

// Device-local, deliberately: whether this phone talks to f-droid.org is a
// property of the phone, not of the account, so it is not synced.
const KEY_ENABLED = 'sd-fdroid-check';      // 'off' disables; anything else is on
const KEY_LAST = 'sd-fdroid-last';          // { at, code, name } of the last answer
const KEY_DISMISSED = 'sd-fdroid-dismissed'; // versionCode the user dismissed

function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: the check simply runs again next time */ }
}

// ── A tiny store, so the notice and the Settings switch agree ─────────────
let state = { enabled: read(KEY_ENABLED) !== 'off', available: null };
const listeners = new Set();
function set(next) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}
function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function useFdroidUpdate() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export function setUpdateCheckEnabled(on) {
  write(KEY_ENABLED, on ? null : 'off');
  // Off also forgets what was known, so turning it back on starts clean
  // rather than resurfacing a stale answer from before.
  if (!on) write(KEY_LAST, null);
  set({ enabled: on, available: on ? state.available : null });
}

export function dismissUpdate() {
  if (state.available) write(KEY_DISMISSED, String(state.available.latest.code));
  set({ available: null });
}

/** F-Droid's suggested version, from cache when it is under a day old. */
async function latestOnFdroid(now, http) {
  let cached = null;
  try { cached = JSON.parse(read(KEY_LAST) ?? 'null'); } catch { /* ignore */ }
  if (cached && Number.isFinite(cached.at) && now - cached.at < DAY_MS && now >= cached.at) {
    return cached.code ? cached : null;
  }
  // Recorded before the request, so a failure still counts against the day.
  write(KEY_LAST, JSON.stringify({ at: now, code: 0, name: '' }));
  const res = await http.get({ url: API, connectTimeout: 8000, readTimeout: 8000 });
  if (!res || res.status !== 200 || !res.data) return null;
  const body = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  const code = Number(body?.suggestedVersionCode);
  if (!Number.isInteger(code) || code <= 0) return null;
  const name = (body.packages ?? []).find((p) => p?.versionCode === code)?.versionName ?? '';
  const answer = { at: now, code, name: typeof name === 'string' ? name.slice(0, 32) : '' };
  write(KEY_LAST, JSON.stringify(answer));
  return answer;
}

/**
 * Run the check once. Resolves to `{ current, latest }` when F-Droid has a
 * newer build than this one and the user has not dismissed that version,
 * otherwise null. Never throws. Dependencies are injectable for tests.
 */
export async function checkFdroidUpdate({ now = Date.now(), http = CapacitorHttp, app = App, platform = Capacitor.getPlatform() } = {}) {
  try {
    if (platform !== 'android' || !state.enabled) return null;
    const latest = await latestOnFdroid(now, http);
    if (!latest) return null;
    const info = await app.getInfo();
    const running = Number(info?.build);
    if (!Number.isInteger(running) || latest.code <= running) return null;
    if (read(KEY_DISMISSED) === String(latest.code)) return null;
    const available = { current: { code: running, name: info.version ?? '' }, latest: { code: latest.code, name: latest.name } };
    // The switch may have been turned off while the request was in flight.
    if (!state.enabled) return null;
    set({ available });
    return available;
  } catch {
    return null;
  }
}

/** Test-only: forget module state between cases. */
export function resetFdroidUpdateForTests() {
  state = { enabled: read(KEY_ENABLED) !== 'off', available: null };
}

// Subscribe to a calendar feed.
//
// ── One generic feature, no vendor in the codebase ───────────────────────
//
// Issue #44 asks for a specific LMS's calendar. The build plan's answer, and
// the reason this module is named after the format rather than a product:
//
//   > "Canvas publishes a private per-user ICS feed URL from its calendar
//      page. Subscribing needs no OAuth, no personal access token, no
//      per-institution app approval. The same feature works against Moodle,
//      Blackboard, Google Classroom and most university timetable systems,
//      because they all export ICS. So build one generic feature — 'subscribe
//      to a calendar feed' — and Canvas never appears in the codebase. It
//      appears in the help text."
//
// Dropping the OAuth and token subsystem is what moved this from v1.14 into
// v1.13. There is no vendor name anywhere in this file or in `icsParse.js`;
// the only place any is named is a translated help string.
//
// It also passes the integration policy's three tests, which is why it is the
// one integration on the "yes" list: it feeds StudyDesk data without placing
// StudyDesk inside another product; it removes typing a semester of due dates,
// which is the largest activation cost in the app; and it is invisible when
// unused — it lives in Settings, with no tab, no nav entry and no empty state.
//
// ── The URL is a capability, and stays on the device ─────────────────────
//
// Owner decision, 2026-09-02: stored DEVICE-ONLY. A feed URL is a capability
// URL — anyone holding it can read that calendar without authenticating — so
// it is deliberately kept out of Supabase, out of the outbox, and out of the
// export file. The blast radius is far smaller than an account-scoped token,
// but it is not nothing, and syncing it would put every user's private
// calendar URL in one database for no benefit they asked for.
//
// The consequence, stated plainly because users will meet it: the
// subscription does not follow you to a second device. The IMPORTED ITEMS do
// (they become ordinary assignment rows and sync like any other); the
// subscription itself has to be set up again. That is the cost of the
// decision, and it is the right way round.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { parseIcs, toFeedItems, mergeFeedItems } from './icsParse.js';
import { readJson, writeJson } from './localStore.js';

const FEEDS_KEY = 'studydesk-calendar-feeds';

/** Poll cadence. Six hours, and the number is a judgement rather than a
 *  default: a due date changes rarely, a student opens the app several times
 *  a day, and a feed fetch on every open would hammer somebody's university
 *  server from every install at once. Manual refresh covers the case where
 *  something changed and the user knows it. */
export const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Refuse anything but http(s). A feed URL is pasted from elsewhere, and
 *  `javascript:` or `file:` in a field that later gets fetched is the kind of
 *  thing that only has to work once. */
export function normaliseFeedUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  // `webcal:` is the conventional scheme for a calendar subscription and is
  // http(s) underneath — every client rewrites it, so this does too rather
  // than rejecting a URL the user copied from the button that offers it.
  const swapped = raw.replace(/^webcal:\/\//i, 'https://');
  let url;
  try {
    url = new URL(swapped);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

/** A URL safe to show in the UI. The path of a feed URL IS the secret — it
 *  is what makes it a capability URL — so only the host is displayed. */
export function describeFeedUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function loadFeeds() {
  const list = readJson(FEEDS_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveFeeds(feeds) {
  // Non-critical: the feed list is re-derivable by pasting the URL again, and
  // raising the storage alarm for it would cry wolf over something that is
  // not the user's own writing. Contrast with `studydesk-v1`.
  writeJson(FEEDS_KEY, feeds);
}

export function addFeed({ url, label }) {
  const clean = normaliseFeedUrl(url);
  if (!clean) return { ok: false, error: 'invalid-url' };
  const feeds = loadFeeds();
  if (feeds.some((f) => f.url === clean)) return { ok: false, error: 'duplicate' };
  const feed = {
    id: `feed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    url: clean,
    label: (label || '').trim() || null,
    addedAt: new Date().toISOString(),
    lastFetchedAt: null,
    lastError: null,
    itemCount: 0,
  };
  saveFeeds([...feeds, feed]);
  return { ok: true, feed };
}

export function removeFeed(id) {
  saveFeeds(loadFeeds().filter((f) => f.id !== id));
}

export function updateFeed(id, patch) {
  saveFeeds(loadFeeds().map((f) => (f.id === id ? { ...f, ...patch } : f)));
}

// ── Fetching ──────────────────────────────────────────────────────────────
//
// ── The CORS problem, and what is actually done about it ────────────────
//
// A feed server is a third party and will not send `Access-Control-Allow-
// Origin`. A plain `fetch` from a browser therefore fails, and it fails
// opaquely — the error says "Failed to fetch" with no detail, by design.
//
// On Android, `CapacitorHttp.get` performs the request NATIVELY, outside the
// WebView, so no CORS check applies. That is the path that matters: Android
// is the primary platform.
//
// It is used per-call rather than by enabling the `CapacitorHttp` plugin
// config, which patches the GLOBAL `fetch`. That patch would route every
// Supabase call through native HTTP too — including auth and realtime — and
// swapping the transport under the entire sync layer to add a feed reader is
// a trade nobody would make deliberately.
//
// On web and desktop there is no such escape and a cross-origin feed will
// fail. That is reported honestly as its own error rather than as a generic
// failure, because "your browser will not allow this, use the Android app"
// is actionable and "something went wrong" is not.

const MAX_BYTES = 2 * 1024 * 1024;

async function fetchText(url) {
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.get({
      url,
      // `text/calendar` first, but `*/*` after it: a surprising number of
      // servers return 406 for a strict Accept on a file they will happily
      // serve.
      headers: { Accept: 'text/calendar, text/plain, */*' },
      responseType: 'text',
      connectTimeout: 15000,
      readTimeout: 20000,
    });
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`http-${res.status}`);
      err.code = res.status === 404 ? 'not-found' : res.status === 401 || res.status === 403 ? 'forbidden' : 'http';
      err.status = res.status;
      throw err;
    }
    return String(res.data ?? '');
  }

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'text/calendar, text/plain, */*' } });
  } catch (e) {
    // A browser CORS rejection is indistinguishable from a network failure by
    // design, and on web it is overwhelmingly the former.
    const err = new Error('blocked');
    err.code = 'cors';
    err.cause = e;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`http-${res.status}`);
    err.code = res.status === 404 ? 'not-found' : res.status === 401 || res.status === 403 ? 'forbidden' : 'http';
    err.status = res.status;
    throw err;
  }
  return res.text();
}

/**
 * Fetch and parse one feed.
 *
 * @returns {{ok: true, items, name, errors}} | {{ok: false, code}}
 *
 * Never throws, and never returns items on failure. That second guarantee is
 * load-bearing: `mergeFeedItems` REMOVES a UID that has vanished from the
 * feed, which is correct for a subscription and catastrophic if a failed
 * fetch were allowed to look like an empty one. A flaky connection would
 * otherwise delete a term of deadlines.
 */
export async function refreshFeed(feed) {
  try {
    const text = await fetchText(feed.url);

    if (text.length > MAX_BYTES) {
      return { ok: false, code: 'too-large' };
    }
    // A wrong URL usually returns an HTML login page with a 200, which would
    // otherwise parse to zero events and read as "your feed is empty" — the
    // most confusing possible answer to "I pasted the wrong link".
    if (!/BEGIN:VCALENDAR/i.test(text)) {
      return { ok: false, code: 'not-a-calendar' };
    }

    const { events, name, errors } = parseIcs(text);
    const items = toFeedItems(events, feed.id);
    // Surfaced so the UI can say that repeating events came in as a single
    // occurrence. See `toFeedItems` — silently importing one lecture from a
    // term of them is the failure this number exists to prevent.
    return { ok: true, items, name, errors, repeating: items.repeating || 0 };
  } catch (e) {
    return { ok: false, code: e?.code || 'network' };
  }
}

/** Is this feed due a poll? */
export function isDue(feed, now = Date.now()) {
  if (!feed?.lastFetchedAt) return true;
  const at = Date.parse(feed.lastFetchedAt);
  if (Number.isNaN(at)) return true;
  return now - at >= POLL_INTERVAL_MS;
}

export { mergeFeedItems };

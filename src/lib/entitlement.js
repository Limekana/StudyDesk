// Supporter entitlement — reads `supporter_entitlements` for the signed-in
// user and answers one question: is a paid perk unlocked right now?
//
// The table is written *only* by the verified Ko-fi webhook Edge Function.
// RLS grants `select` on your own row and nothing else — there is no client
// insert/update path at all, so this module is a pure reader.
//
// Why `expires_at` and not an `active` boolean: Ko-fi's webhook fires on
// payment events only. There is no cancellation event, so a boolean could be
// set true and could never be set back. Each payment instead pushes
// `expires_at` out by a fixed window; lapsing is the absence of a renewal
// rather than an event we have to be told about. That means "entitled" is
// always a comparison against the clock, never a stored flag.
//
// Honest scope note: this is a cosmetic perk in an open-source, client-only
// app. The theme CSS is in the bundle for everyone and the app is on F-Droid
// with published source, so nothing here is — or can be — an enforcement
// boundary. It exists so that a supporter's perk switches on by itself, keeps
// working offline, and lapses correctly. Treat it as UX plumbing, not a lock.

import { supabase } from "./supabase";

const CACHE_KEY = "studydesk.entitlement";

// How long a cached answer is trusted before we ask the server again. Short
// enough that a fresh supporter sees their perk the same session, long enough
// that opening the app offline for a week doesn't strip a paid theme.
const REVALIDATE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

// Read the cached record without touching the network. Safe to call during the
// synchronous pre-paint pass — see `themeBoot` in index.html.
export function readCachedEntitlement() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec || typeof rec !== "object") return null;
    return rec;
  } catch {
    return null;
  }
}

// True when the cached record is present and its window has not closed.
// An absent, malformed or expired record all answer the same way: false.
export function isEntitled(now = Date.now()) {
  const rec = readCachedEntitlement();
  if (!rec) return false;
  // v1.12 Item 6a — a lifetime grant outranks the clock entirely. "Granted
  // forever" and "paid through" are genuinely different states: the webhook
  // upserts an explicit column list that excludes `lifetime`, so a later
  // membership payment moves expires_at without disturbing a manual grant.
  // Checking the flag first is what makes that survive.
  if (rec.lifetime) return true;
  if (!rec.expiresAt) return false;
  const expires = Date.parse(rec.expiresAt);
  if (Number.isNaN(expires)) return false;
  return expires > now;
}

export function entitlementTier() {
  return isEntitled() ? readCachedEntitlement()?.tier || null : null;
}

// v1.13 — every cache write announces itself. Entitlement resolves
// asynchronously after mount, and before this the only way a surface learned
// its answer had changed was to remount. The Settings screen shows the
// supporter block and the theme picker at the same time, so "refresh the
// entitlement" and "the theme rows are still disabled" were visible together.
//
// `theme.js` listens for this and re-resolves the theme, which is what makes
// a supporter's theme switch itself on the moment their entitlement lands
// rather than on the next cold start.
export const ENTITLEMENT_CHANGE_EVENT = "studydesk-entitlement-change";

function writeCache(rec) {
  try {
    if (rec) localStorage.setItem(CACHE_KEY, JSON.stringify(rec));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable — fall through to the un-entitled default */
  }
  // Fired even when the write above threw: the in-memory answer may still
  // have changed, and a listener that re-reads is correct either way.
  try {
    window.dispatchEvent(new CustomEvent(ENTITLEMENT_CHANGE_EVENT));
  } catch { /* SSR / non-window environments */ }
}

// Called on sign-out. Leaving a previous account's entitlement behind on a
// shared device would hand the next user a paid theme, same reasoning as the
// rest of the suite's on-signout local wipes.
export function clearEntitlement() {
  writeCache(null);
}

let inFlight = null;

// Ask the server. Returns the fresh entitled boolean. Never throws — a network
// failure keeps whatever was cached, because dropping a supporter's theme
// because their train went into a tunnel is the wrong failure mode.
export async function refreshEntitlement(userId, { force = false } = {}) {
  if (!userId) {
    clearEntitlement();
    return false;
  }

  const cached = readCachedEntitlement();
  if (
    !force &&
    cached &&
    cached.userId === userId &&
    Date.now() - (cached.checkedAt || 0) < REVALIDATE_AFTER_MS
  ) {
    return isEntitled();
  }

  // Collapse concurrent callers (App mount + a sign-in event can land together)
  // onto one request rather than racing two writes into the same cache key.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const { data, error } = await supabase
        .from("supporter_entitlements")
        .select("tier, expires_at, lifetime")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        // Includes the offline case. Keep the existing cache untouched.
        return isEntitled();
      }

      if (!data) {
        // Authoritative "no row" — this user has never supported, or their
        // row was removed. Clearing is correct here; it is not a failure.
        writeCache({ userId, tier: null, expiresAt: null, lifetime: false, checkedAt: Date.now() });
        return false;
      }

      writeCache({
        userId,
        tier: data.tier || null,
        expiresAt: data.expires_at || null,
        lifetime: data.lifetime === true,
        checkedAt: Date.now(),
      });
      return isEntitled();
    } catch {
      return isEntitled();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

// Item 8 — self-reported referral attribution.
//
// WHY SELF-REPORTED AT ALL
//
// F-Droid has no install-referrer mechanism. Play Store has the Install
// Referrer API; F-Droid has structurally nothing equivalent, and no UTM
// scheme or redirect trick closes the gap — the chain breaks the moment
// someone leaves the site to install. Vercel Analytics sees the web side
// only. So the sole way to attribute an F-Droid install back to a specific
// post is for the user to say so.
//
// SHAPE
//
// Reuses the `limecore_origin` mechanism exactly: one namespaced key in the
// user's own auth metadata, written once, never overwritten. No table, no
// column, no migration — clean against P1, nothing for an old build in the
// wild to fail to understand.
//
// The suite wrinkle from originMarker.js applies here too and is, unusually,
// a feature: the field lives on the shared auth user, so whichever suite app
// asks first records the answer and the other two see it already present and
// stay quiet. The user is asked once per account, not once per app.

import { supabase } from "./supabase";
import pkg from "../../package.json";

const REFERRAL_KEY = "referral_source";

// Kept broad on purpose. Cross-referencing a "reddit" answer against known
// post dates identifies which post worked; asking the user to recall which
// subreddit they were in would trade a reliable answer for an unreliable one.
export const REFERRAL_OPTIONS = ["reddit", "store", "friend", "other"];

// Written when the user dismisses instead of answering. A sentinel rather
// than nothing, so "never shown again" survives a reinstall or a second
// device — and so the data can tell "declined to say" apart from "never
// asked", which are very different denominators.
export const REFERRAL_DISMISSED = "dismissed";

// Local mirror of the same fact. The metadata write is the durable record;
// this is what stops a second prompt in the seconds before updateUser()
// round-trips, and covers the case where that write fails outright.
const ASKED_KEY = "sd-referral-asked";

// Only ask accounts young enough that the answer is a memory rather than a
// reconstruction. Without this gate every pre-existing account — 103 of them
// predate the instrumentation — would be prompted on next open, and their
// guesses would land in whatever week the prompt happened to ship, actively
// corrupting the per-post attribution this exists to produce.
const MAX_ACCOUNT_AGE_DAYS = 30;

export function hasReferralSource(user) {
  return Boolean(user?.user_metadata?.[REFERRAL_KEY]);
}

function askedLocally() {
  try {
    return localStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function markAskedLocally() {
  try {
    localStorage.setItem(ASKED_KEY, "1");
  } catch {
    // Non-fatal. The metadata write is the real record; losing the local
    // mirror costs at most one redundant prompt on this device.
  }
}

function accountAgeDays(user) {
  const created = user?.created_at ? Date.parse(user.created_at) : NaN;
  if (Number.isNaN(created)) return Infinity;   // unknown age -> don't ask
  return (Date.now() - created) / 86_400_000;
}

/** True when this signed-in user should see the prompt, exactly once, ever. */
export function shouldAskReferral(user) {
  if (!user) return false;                          // guests have no metadata
  if (hasReferralSource(user)) return false;
  if (askedLocally()) return false;
  return accountAgeDays(user) <= MAX_ACCOUNT_AGE_DAYS;
}

/**
 * Record the answer (or the dismissal) on the user, once.
 *
 * Fire-and-forget, like the origin stamp: attribution is not worth blocking
 * or failing anything the user is actually trying to do. The local flag is
 * set first and unconditionally, so a network failure costs the data point
 * rather than producing a prompt that reappears until it succeeds.
 */
export function recordReferralSource(user, source) {
  markAskedLocally();
  if (!user || hasReferralSource(user)) return;
  const value = {
    source,
    app: "studydesk",
    app_version: pkg.version,
    answered_at: new Date().toISOString(),
  };
  // Same deferral as scheduleOriginStamp: supabase-js holds an internal auth
  // lock across onAuthStateChange callbacks, and this can be reached from a
  // render triggered by one. Bouncing off the macrotask queue keeps it safe.
  setTimeout(() => {
    supabase.auth
      .updateUser({ data: { [REFERRAL_KEY]: value } })
      .catch((e) => console.warn("[studydesk] referral source write failed:", e));
  }, 0);
}

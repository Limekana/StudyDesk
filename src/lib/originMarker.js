// ACT-5 — where do the accounts actually come from?
//
// 103 accounts had arrived by 2026-07-26 against 52 lifetime APK downloads
// across all three repos, with no web build in existence and no F-Droid
// distribution during the surge. The leading hypothesis is that most of them
// are developers running a cloned repo against production: the Supabase URL
// and anon key have to resolve at build time for F-Droid's reproducible
// builds, so `git clone` + `npm run dev` yields a working client pointed at
// the real project.
//
// Until a client can be told apart from a dev server, that stays a
// hypothesis and every activation number is uninterpretable. This stamps one
// namespaced key into the user's own auth metadata so the three cases
// separate cleanly:
//
//   native Android build   -> native: true,  platform: 'android'
//   dev server / clone     -> native: false, platform: 'web', origin has :5173
//   future web build       -> native: false, platform: 'web', origin limecore.dev
//
// Written once and never overwritten, so it records where an account was
// FIRST seen by an instrumented build — not necessarily where it signed up.
// The 103 existing accounts predate this, so they only acquire a marker if
// they ever come back, which is itself a signal worth having.
//
// Note the suite wrinkle: StudyDesk can inherit a session from NCC over the
// SSO bridge, so `app` records which app happened to observe the user first,
// not which one they signed up in. Platform and origin are identical across
// suite apps on one device, so the answer ACT-5 actually needs is unaffected.
import { Capacitor } from "@capacitor/core";
import { supabase } from "./supabase";
import pkg from "../../package.json";

const ORIGIN_KEY = "limecore_origin";

export function hasOriginMarker(user) {
  return Boolean(user?.user_metadata?.[ORIGIN_KEY]);
}

function buildMarker() {
  return {
    app: "studydesk",
    app_version: pkg.version,
    platform: Capacitor.getPlatform(),
    native: Capacitor.isNativePlatform(),
    // Capacitor serves the native build from http(s)://localhost with no
    // port, a Vite dev server from http://localhost:5173. The port is the
    // discriminator, so keep the whole origin rather than the hostname.
    origin: typeof window !== "undefined" ? window.location.origin : "",
    first_seen: new Date().toISOString(),
  };
}

/**
 * Stamp the origin marker onto the signed-in user, once, ever.
 *
 * Safe to call on every auth event: the marker rides along in the session's
 * user_metadata, so the already-stamped case costs one property read and no
 * network call. updateUser() fires USER_UPDATED, which re-enters the caller's
 * auth listener — by then the metadata is present, so it terminates.
 *
 * Fire-and-forget by design. Instrumentation is not worth delaying or failing
 * a sign-in over, so this returns void and swallows its own errors.
 */
export function scheduleOriginStamp(user) {
  if (!user || hasOriginMarker(user)) return;
  // Deferred deliberately. supabase-js holds an internal auth lock for the
  // duration of an onAuthStateChange callback, and calling another
  // supabase.auth.* method from inside that callback deadlocks. Bouncing off
  // the macrotask queue means this is safe to call from an auth listener,
  // which is the only place it is ever called from.
  setTimeout(() => {
    supabase.auth
      .updateUser({ data: { [ORIGIN_KEY]: buildMarker() } })
      .catch((e) => console.warn("[studydesk] origin marker stamp failed:", e));
  }, 0);
}

// v1.10 (Item 12) — JS side of Lock In's native half.
//
// Two capabilities, deliberately independent because they fail differently and
// one is far more intrusive than the other:
//
//   * the CHIP  — an ongoing notification with a live countdown. On Android 16
//     it asks to be promoted, which is what puts it in Samsung's Now Bar on One
//     UI 8 and in the status-bar chip on stock. Harmless, so it defaults ON.
//   * PINNING   — screen pinning, which stops the user leaving the app until
//     they hold Back+Recents. Genuinely disruptive if it surprises someone, so
//     it defaults OFF and always will.
//
// Everything here is a no-op on web. Lock In is a web feature first (it works
// in a browser tab as a distraction-stripped view), and the native additions
// are enhancements to it, not prerequisites for it.

import { Capacitor, registerPlugin } from '@capacitor/core';

const FocusMode = registerPlugin('FocusMode');

const isNative = () => Capacitor.isNativePlatform();

/** Cached because it cannot change while the app is running, and because the
 *  settings screen would otherwise ask on every render. */
let capsPromise = null;

const NO_CAPS = { sdk: 0, pinning: false, promotedOngoing: false, notifications: false };

export function focusCapabilities() {
  if (!isNative()) return Promise.resolve({ ...NO_CAPS });
  if (!capsPromise) {
    capsPromise = FocusMode.capabilities()
      .then((c) => ({ ...NO_CAPS, ...c }))
      // A plugin that is missing (an older shell, a partial install) must read
      // as "no capabilities" rather than throwing into a settings render.
      .catch(() => ({ ...NO_CAPS }));
  }
  return capsPromise;
}

/**
 * Begin a focus block.
 *
 * `endsAt` is absolute epoch millis, not a duration: the native side hands it
 * straight to the system chronometer, which then counts down without anything
 * of ours running. Passing a duration would have meant staying alive to tick
 * it, which is the thing the design avoids.
 *
 * Returns what actually happened, not what was asked for — the user can refuse
 * the pinning prompt, and the caller needs to know it is not pinned so it can
 * avoid promising otherwise.
 */
export async function startFocus({ title, text, endsAt, chip = true, pin = false }) {
  if (!isNative()) return { chip: false, pinned: false };
  try {
    return await FocusMode.start({
      title: title || 'Focus',
      text: text || '',
      // Guard the cast here rather than native-side: a NaN would arrive as a
      // long 0 and silently turn the countdown off with no way to tell why.
      endsAt: Number.isFinite(endsAt) ? Math.round(endsAt) : 0,
      chip: !!chip,
      pin: !!pin,
    });
  } catch {
    return { chip: false, pinned: false };
  }
}

// ── Notification permission (issue #39) ─────────────────────────────────────
//
// StudyDesk only ever asks for POST_NOTIFICATIONS inside `scheduleNotifications`
// in App.jsx, which runs when `state.notifEnabled` is true. A user who answered
// "Maybe later" at onboarding is therefore never asked — and on Android 13+ an
// ungranted POST_NOTIFICATIONS means every `nm.notify()` in the app is silently
// dropped. That is one cause for both halves of #39's report: the focus chip
// "has never worked" AND "most notifications don't come through at all."
//
// The chip needs its own path to the prompt because it is reachable without
// ever turning reminders on.

/** Live notification state, re-read from the OS rather than from the cached
 *  capabilities. False when the runtime permission is ungranted OR when the
 *  user has switched notifications off for the app in system settings. */
export async function notificationsEnabled() {
  if (!isNative()) return false;
  try {
    const { enabled } = await FocusMode.notificationsEnabled();
    return !!enabled;
  } catch {
    // Older shell without the method — fall back to the cached capability so
    // an app updated mid-session does not report a false negative.
    const caps = await focusCapabilities();
    return !!caps.notifications;
  }
}

/**
 * Ask for notification permission if it is not already held, then report the
 * real outcome.
 *
 * Routed through `LocalNotifications.requestPermissions()` rather than a new
 * native permission callback: that plugin is already a dependency, already
 * drives this exact prompt for reminders, and already handles the Android 13+
 * POST_NOTIFICATIONS flow. Adding a second implementation would mean two code
 * paths to the same OS dialog.
 *
 * Re-checks natively afterwards instead of trusting the plugin's answer — the
 * permission can also be off because notifications are disabled for the app
 * wholesale, which the request cannot fix and does not report.
 */
export async function ensureNotificationPermission() {
  if (!isNative()) return false;
  if (await notificationsEnabled()) return true;
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications');
    await LocalNotifications.requestPermissions();
  } catch {
    /* Prompt unavailable — fall through to the re-check, which reports false
       and lets the caller point the user at system settings instead. */
  }
  // Invalidate the cached capabilities: `notifications` is now stale, and the
  // settings screen reads it to decide what to show.
  capsPromise = null;
  return notificationsEnabled();
}

/** End a focus block. Safe to call when nothing was started — the native side
 *  clears both halves unconditionally, which is what recovers a session that
 *  was interrupted by a crash rather than by the user. */
export async function stopFocus() {
  if (!isNative()) return { chipCleared: false, pinned: false };
  try {
    return await FocusMode.stop();
  } catch {
    return { chipCleared: false, pinned: false };
  }
}

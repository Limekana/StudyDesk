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

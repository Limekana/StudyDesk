// Where the soft keyboard actually is.
//
// §4 names the failure this exists to prevent, in the specific:
//
//   > "**Anchor to the visual viewport, not the layout viewport.** Read the
//      keyboard inset and offset the bar. A bar positioned against the layout
//      viewport sits *behind* the keyboard on Android — this is the exact
//      failure the brief names. On Capacitor, use the Keyboard plugin's
//      height events plus `visualViewport`; do not assume a fixed keyboard
//      height (it varies by IME, and by suggestion-strip visibility on the
//      same IME)."
//
// So: no constant, no guess, and two independent sources agreeing.
//
// ── Why `visualViewport` alone, and no Keyboard plugin ───────────────────
//
// The handoff says "the Keyboard plugin's height events PLUS visualViewport".
// This ships the second half only, deliberately, and the reason is concrete
// rather than a shortcut:
//
//   * `@capacitor/keyboard` is a native plugin. Adding one means a Gradle
//     sync and a rebuilt Android project, and this milestone is being taken
//     to a green PR by a cloud agent that cannot build or sign an APK. A
//     native dependency that nobody can compile here is a dependency added
//     blind.
//   * `visualViewport` is implemented in the Android WebView (Chromium 61+;
//     Capacitor 8 requires far newer) and reports the keyboard inset directly,
//     because the keyboard is exactly what shrinks the visual viewport.
//   * The plugin's value is that it fires slightly EARLIER in the show
//     animation. That buys smoother motion, not correctness — and the bar is
//     not animated.
//
// If the plugin is added later, `readInset` is the one function to change:
// take the larger of the two readings, since a plugin height of 0 during the
// show animation would otherwise yank the bar to the bottom mid-transition.
//
// ── Why the value goes into a CSS variable ───────────────────────────────
// The bar is `position: fixed; bottom: var(--nb-kb)`. Writing the number to a
// custom property on `<html>` rather than into React state means a keyboard
// resize repaints one property instead of re-rendering the editor — and the
// editor is a textarea the user is mid-composition in. Re-rendering that on
// every viewport resize event is a good way to reintroduce the IME problems
// the whole architecture is built to avoid.

import { useEffect } from 'react';

const VAR = '--nb-kb';

function readInset() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return 0;

  // How much of the layout viewport the visual viewport does not cover at the
  // bottom. `offsetTop` matters when the page is scrolled within a pinch-zoom
  // — without it the bar drifts up by the scroll offset on a zoomed page.
  const inset = window.innerHeight - vv.height - vv.offsetTop;

  // Clamp. A negative value means the visual viewport is TALLER than the
  // layout one, which happens transiently during URL-bar collapse on some
  // Android builds and would push the bar off the bottom of the screen.
  if (!Number.isFinite(inset) || inset < 0) return 0;

  // Below this, it is not a keyboard. Android reports small insets for the
  // gesture-navigation bar and for URL-bar show/hide, and treating those as a
  // keyboard makes the bar hop by 30px while scrolling. A soft keyboard is
  // never this short.
  if (inset < 80) return 0;

  return Math.round(inset);
}

/**
 * Keeps `--nb-kb` on <html> equal to the current keyboard inset.
 *
 * @param {boolean} active  false while the editor is unfocused, which resets
 *        the variable to 0 — §4: "The bar exists only while the editor has
 *        focus. Blur and it leaves with the keyboard, so a note being READ
 *        has no chrome over it at all."
 */
export function useKeyboardInset(active) {
  useEffect(() => {
    const root = document.documentElement;

    if (!active) {
      root.style.setProperty(VAR, '0px');
      return undefined;
    }

    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      // Coalesce to one write per frame. `resize` fires many times during the
      // keyboard show animation and each one would otherwise be a style write
      // plus a layout.
      raf = requestAnimationFrame(() => {
        root.style.setProperty(VAR, `${readInset()}px`);
      });
    };

    apply();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', apply);
      // `scroll` too: on Android the visual viewport scrolls independently
      // when the focused field is pushed up, and offsetTop changes without a
      // resize firing.
      vv.addEventListener('scroll', apply);
    }
    // The fallback matters on desktop and on any engine without
    // visualViewport: `readInset` returns 0 there, which is correct, and the
    // listener keeps that true across an orientation change.
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);

    return () => {
      cancelAnimationFrame(raf);
      if (vv) {
        vv.removeEventListener('resize', apply);
        vv.removeEventListener('scroll', apply);
      }
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      root.style.setProperty(VAR, '0px');
    };
  }, [active]);
}

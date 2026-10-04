// v1.17 (limecore#13, #18) — feature views and languages are separate chunks now.
//
// On the web edition, a tab opened before a deploy keeps running the old
// index, and the chunk names it asks for no longer exist on the new deploy.
// Vite reports that as `vite:preloadError`. Reloading picks up the new index
// and its chunks, so the user lands on the view instead of the error page.
//
// Web only. In the APK and the desktop build the chunks are local files that
// cannot go stale, and a reload loop in the Android WebView is how the shared
// refresh token was burned on 2026-08-07. At most one reload a minute, so a
// chunk that is genuinely missing surfaces as an error instead of a loop.
import { Capacitor } from '@capacitor/core';
import { IS_DESKTOP } from './desktop.js';

const KEY = 'studydesk.staleChunkReload';

export function installStaleChunkReload() {
  if (Capacitor.isNativePlatform() || IS_DESKTOP) return;
  window.addEventListener('vite:preloadError', (event) => {
    try {
      if (Date.now() - Number(sessionStorage.getItem(KEY) ?? 0) < 60_000) return;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {
      return; // no storage means no loop guard: let the error surface
    }
    event.preventDefault();
    window.location.reload();
  });
}

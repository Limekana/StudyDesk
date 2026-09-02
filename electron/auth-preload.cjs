// v1.12.1 — the only bridge the main window gets.
//
// Desktop sign-in used to navigate the app's OWN window to the OAuth provider
// (`window.location.href = data.url` in AuthGate). Supabase then bounced the
// browser to whichever redirect target it accepted, which for the desktop build
// is never `studydesk://app/` — that origin cannot be in the project's
// allow-list as a plain http URL, so Supabase fell back to the project's Site
// URL and the app's window ended up parked on the marketing site with no route
// home. The app was, literally, gone.
//
// The desktop flow is now the loopback flow RFC 8252 prescribes for native
// apps: the provider URL opens in the user's real browser, and the code comes
// back to a listener on 127.0.0.1 that hands it here over IPC. The PKCE code
// verifier never leaves the renderer, so the exchange has to happen there —
// which is exactly what `onCallback` exists to let it do.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const FLAG = '--studydesk-auth-redirect=';
const arg = process.argv.find((a) => a.startsWith(FLAG));

contextBridge.exposeInMainWorld('studydeskDesktop', {
  // The loopback callback URL this launch is listening on, or null if the
  // listener could not bind. The renderer uses it as Supabase's `redirectTo`.
  redirectUri: arg ? arg.slice(FLAG.length) : null,

  // Hand an https provider URL to the system browser. Returns false if the
  // main process refused it.
  beginOAuth: (url) => ipcRenderer.invoke('auth:begin', url),

  // Subscribe to the loopback callback. Returns an unsubscriber.
  onCallback: (fn) => {
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on('auth:callback', handler);
    return () => ipcRenderer.removeListener('auth:callback', handler);
  },
});

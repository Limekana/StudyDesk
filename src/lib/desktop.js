// v1.12.1 — the Electron shell's bridge, or null on every other platform.
//
// `electron/auth-preload.cjs` puts this on `window` before any page script
// runs, so reading it at module scope is safe. Everything that needs to know
// "am I the desktop build" asks here rather than sniffing the user agent, which
// is what `lib/appOpens.js` has to do for its own reasons and what nothing else
// should copy: a bridge that is present is a bridge that works.
export const desktop =
  (typeof window !== 'undefined' && window.studydeskDesktop) || null;

/** True only in the Electron desktop build. */
export const IS_DESKTOP = desktop !== null;

/** The loopback OAuth callback this launch is listening on, or null — either
 *  because this is not the desktop build, or because no candidate port was
 *  free. A null here means desktop OAuth is unavailable this launch; email
 *  sign-in needs no redirect and is unaffected. */
export const DESKTOP_REDIRECT_URL = desktop?.redirectUri || null;

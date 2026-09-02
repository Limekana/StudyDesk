// Electron shell for StudyDesk's desktop edition. Wraps the existing static
// Vite build (dist/) in a real installable Windows window rather than
// "download a zip, open index.html yourself." Kept in lockstep with
// Nexus-Dashboard's electron/main.cjs — same underlying problem (SPA served as
// a native window), same fix.
//
// ── Why a custom scheme and not http://127.0.0.1 (v1.11, forced-logout bug) ──
//
// This previously ran a local static server on `server.listen(0, ...)`, which
// asks the OS for a RANDOM free port, and loaded `http://127.0.0.1:<port>/`.
// The page therefore had a different ORIGIN on every single launch, and
// localStorage — where supabase-js persists the session on non-Capacitor
// platforms (src/lib/supabase.js passes `storage: undefined` off-native, i.e.
// the default) — is partitioned per origin. So every launch opened an empty
// storage bucket, the stored session was unreachable, and the user had to sign
// in again. It looked like "my session expired"; nothing had expired at all.
//
// NCC diagnosed and fixed this in v1.10; the fix was never ported here, so
// StudyDesk desktop kept the bug for a release longer. Confirmed on this
// machine before changing anything: NCC's Local Storage holds both an old
// `127.0.0.1:62320` bucket and the current `nexus://app` one, while
// StudyDesk's still holds only a random-port `127.0.0.1:62769`.
//
// A fixed port would restore a stable origin but reintroduces the same class
// of bug the moment that port is taken and the code falls back to another one.
// A registered scheme has no port to collide, so the origin is stable by
// construction. `secure: true` also keeps the page a secure context, which
// supabase-js's PKCE flow needs for crypto.subtle.
//
// Two consequences worth knowing:
//   - `studydesk://app/` is the app's web origin now. That is a stable origin
//     for storage, but it is NOT usable as an OAuth redirect target: Supabase's
//     allow-list takes http(s) URLs, so a custom scheme can never be entered
//     there. v1.12 shipped with `OAUTH_REDIRECT_URL` resolving to it anyway,
//     Supabase fell back to the project's Site URL, and desktop sign-in ended on
//     the marketing site inside the app's own window. v1.12.1 replaces that with
//     a fixed-port loopback listener (see `startAuthLoopback` below) and refuses
//     to let the window leave this origin at all (see `hardenNavigation`).
//   - The one-time cost of moving origin is that whatever sat in the old
//     random-port bucket is orphaned. Nothing is lost that wasn't already being
//     lost on every launch.
//
// The static server is gone entirely rather than kept alongside: it existed to
// provide SPA-fallback routing, and `resolveRequest` below does that directly.
'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, protocol, net, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const ICON_PATH = path.join(__dirname, '..', 'resources', 'icon.ico');
const WIDGET_PRELOAD = path.join(__dirname, 'widget-preload.cjs');
const AUTH_PRELOAD = path.join(__dirname, 'auth-preload.cjs');

const SCHEME = 'studydesk';
const APP_ORIGIN = `${SCHEME}://app`;

// Must run before app.whenReady(). `standard` gives the scheme normal URL
// parsing (host + path); `secure` grants secure-context powers (crypto.subtle,
// and storage that isn't treated as third-party).
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// File-based diagnostics — packaged GUI Electron apps have no attached
// console, so a launch failure is otherwise silently invisible. Carried over
// from the NCC shell after that exact failure mode showed up there during
// verification.
const LOG_PATH = path.join(app.getPath('userData'), 'main.log');
function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging must never be why the app fails to start.
  }
}
log(`app starting — __dirname=${__dirname} DIST_DIR=${DIST_DIR} exists=${fs.existsSync(DIST_DIR)}`);
process.on('uncaughtException', (err) => log(`UNCAUGHT EXCEPTION: ${err && err.stack}`));
process.on('unhandledRejection', (err) => log(`UNHANDLED REJECTION: ${err && err.stack}`));

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

// Resolve a request URL to a real file under dist/, with the same SPA fallback
// the old static server had: anything that isn't a real file serves index.html.
function resolveRequest(requestUrl) {
  const { pathname } = new URL(requestUrl);
  const filePath = path.join(DIST_DIR, decodeURIComponent(pathname));

  // Guard against path traversal escaping dist/. path.join has already
  // normalised away `..`, so this compares the resolved result.
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) return null;

  try {
    if (fs.statSync(filePath).isFile()) return filePath;
  } catch {
    // Falls through to the SPA entry point below.
  }
  return path.join(DIST_DIR, 'index.html');
}

function registerProtocolHandler() {
  protocol.handle(SCHEME, async (request) => {
    const filePath = resolveRequest(request.url);
    if (!filePath) return new Response('Forbidden', { status: 403 });

    const response = await net.fetch(pathToFileURL(filePath).toString());
    // Set Content-Type explicitly rather than trusting inference — a wrong or
    // missing type on the module scripts is a blank window with no error.
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
      },
    });
  });
}

let mainWindow = null;

// ── Off-origin navigation guard (v1.12.1, P0) ───────────────────────────────
//
// Nothing stopped the app's own window from navigating away from
// `studydesk://app`. Desktop sign-in did exactly that — `window.location.href =
// <provider url>` in AuthGate — and the redirect chain ended on the marketing
// site, in the window that used to be the app. There is no back button, no
// address bar and no menu, so that is a terminal state: the user's only move is
// to kill the process.
//
// A window that IS the application must never be used as a general-purpose
// browser. Anything that is not this app's own origin is cancelled here and
// handed to the real browser instead, which turns "the app is gone" into a new
// tab. That holds for the OAuth redirect, for a mis-built link in the renderer,
// and for whatever the next one turns out to be — the guard does not need to
// know why it was asked.
function isAppUrl(target) {
  try {
    const u = new URL(target);
    return u.protocol === `${SCHEME}:` && u.host === 'app';
  } catch {
    return false;
  }
}

// Only ever hand http(s) to the OS. `shell.openExternal` will happily launch
// other registered handlers, and a renderer bug that produced, say, a file:// or
// a custom-scheme URL should die quietly rather than start something.
function openExternally(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      log(`refused to open non-http external URL (${u.protocol})`);
      return false;
    }
    void shell.openExternal(target);
    return true;
  } catch {
    return false;
  }
}

function hardenNavigation(win) {
  const handoff = (event, target) => {
    if (isAppUrl(target)) return;
    event.preventDefault();
    log(`cancelled off-origin navigation: ${target}`);
    openExternally(target);
  };
  // `will-navigate` catches a link click or a location assignment; the
  // `will-redirect` pair catches a 30x issued part-way through a chain we did
  // allow. Neither fires for the SPA's own history.pushState routing.
  win.webContents.on('will-navigate', handoff);
  win.webContents.on('will-redirect', handoff);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' };
    openExternally(url);
    return { action: 'deny' };
  });
}

// ── Desktop OAuth callback (v1.12.1, P0) ────────────────────────────────────
//
// Android has a deep link (`com.studydesk.app://login-callback`) and the web
// build has its own origin. Desktop had neither, so `OAUTH_REDIRECT_URL`
// resolved to `studydesk://app/` — a URL Supabase cannot be asked to redirect
// to — and the provider bounced to the project's Site URL instead.
//
// A loopback listener is what RFC 8252 prescribes for a native app, and on
// Windows it is markedly more reliable than registering a custom URI scheme:
// scheme registration is a per-machine installer concern that a zip build never
// performs at all, whereas 127.0.0.1 needs no registration and no elevation.
//
// The port list is FIXED rather than `listen(0)`. Supabase matches redirect
// URLs against an allow-list, so a random port could never be allowlisted —
// that is precisely the mistake the top-of-file note records the v1.11 shell
// making with its random-port static server. Five candidates give headroom for
// a collision while keeping the owner's allow-list entry a short, closed set.
const AUTH_PORTS = [51837, 51838, 51839, 51840, 51841];
const AUTH_CALLBACK_PATH = '/callback';

let authRedirectUri = null;
// Only accept a callback while a sign-in this app started is outstanding. The
// listener is reachable by anything running as this user, and an unsolicited
// code is at best noise and at worst an attempt to plant someone else's
// session. Cheap to gate, so gate it.
let authPending = false;

const CALLBACK_PAGE = (ok) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>StudyDesk</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f5f2ed;color:#1a1814;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px;}
  h1{font-size:20px;margin:0 0 8px;} p{margin:0;color:#6b6560;font-size:14px;}
</style></head><body><div>
  <h1>${ok ? 'Signed in' : 'Sign-in failed'}</h1>
  <p>${ok ? 'You can close this tab and go back to StudyDesk.' : 'Close this tab and try again from StudyDesk.'}</p>
</div></body></html>`;

// The provider's error text is deliberately NOT echoed into the page — it is
// attacker-influenceable and this response is HTML. It goes to the renderer,
// which renders it as text through React.
function handleAuthCallback(req, res) {
  let url = null;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch {
    url = null;
  }
  if (!url || url.pathname !== AUTH_CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error_description') || url.searchParams.get('error');

  if (!authPending) {
    log('discarded an unsolicited auth callback');
    res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No sign-in is in progress');
    return;
  }
  authPending = false;

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(CALLBACK_PAGE(Boolean(code) && !error));

  if (mainWindow && !mainWindow.isDestroyed()) {
    // The renderer holds the PKCE code verifier, so it — not this process —
    // has to redeem the code.
    mainWindow.webContents.send('auth:callback', { code: code || null, error: error || null });
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    log('auth callback arrived with no main window to deliver it to');
  }
}

/** Bind the loopback listener, trying each candidate port in turn. Resolves to
 *  the redirect URI, or null if none of them was free — in which case desktop
 *  OAuth stays unavailable and email sign-in, which needs no redirect at all,
 *  still works. A missing listener must never stop the app from starting. */
function startAuthLoopback() {
  return new Promise((resolve) => {
    let i = 0;
    const server = http.createServer(handleAuthCallback);
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && i < AUTH_PORTS.length - 1) {
        i += 1;
        server.listen(AUTH_PORTS[i], '127.0.0.1');
        return;
      }
      log(`auth loopback could not listen: ${err && err.message}`);
      resolve(null);
    });
    server.on('listening', () => {
      authRedirectUri = `http://127.0.0.1:${AUTH_PORTS[i]}${AUTH_CALLBACK_PATH}`;
      log(`auth loopback listening on ${authRedirectUri}`);
      resolve(authRedirectUri);
    });
    server.listen(AUTH_PORTS[i], '127.0.0.1');
  });
}

function createWindow() {
  try {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      icon: ICON_PATH,
      autoHideMenuBar: true,
      // StudyDesk's --bg (src/styles/base.css). Was NCC's #0d1117 for as long
      // as this shell has existed — a copy-paste from the app it was ported
      // from, which flashed dark before a cream page on every launch.
      backgroundColor: '#f5f2ed',
      webPreferences: {
        // The bridge is three functions wide and adds no Node surface: a
        // sandboxed preload only gets contextBridge and ipcRenderer, which is
        // all `auth-preload.cjs` uses.
        preload: AUTH_PRELOAD,
        additionalArguments: authRedirectUri
          ? [`--studydesk-auth-redirect=${authRedirectUri}`]
          : [],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    hardenNavigation(mainWindow);

    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`did-fail-load: code=${code} desc=${desc} url=${url}`);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      log('did-finish-load — window rendered successfully');
    });
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      log(`render-process-gone: ${JSON.stringify(details)}`);
    });

    mainWindow.loadURL(`${APP_ORIGIN}/`);

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    log(`createWindow FAILED: ${err && err.stack}`);
  }
}

// ── glance widget (v1.11) ───────────────────────────────────────────────────
//
// A second, frameless, always-on-top window showing the next assignment due
// and what is left of today. It runs its own renderer and its own Supabase
// client rather than being fed over IPC, because the entire point is to be
// readable with the main window closed — an IPC-tethered widget only has data
// while the app is open, which is just the app in a smaller frame.
//
// That only works because both windows now share an origin (see the note at
// the top of this file). Under the old random-port server there was no stable
// origin, so the widget could never have seen the session at all.

const WIDGET_SIZE = { width: 320, height: 200 };
const BOUNDS_PATH = path.join(app.getPath('userData'), 'widget-bounds.json');

let widgetWindow = null;
let tray = null;

// Position is persisted rather than the window being kept alive hidden. A
// hidden window would leave the app running with nothing on screen, which is
// how a tray app becomes a process the user cannot account for; destroying it
// and remembering where it sat gets the same result with none of that.
function readBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(BOUNDS_PATH, 'utf8'));
    if (!Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return null;
    // A monitor that has since been unplugged would strand the widget
    // off-screen, where it is both invisible and un-draggable.
    const onScreen = screen.getAllDisplays().some((d) => {
      const w = d.workArea;
      return saved.x < w.x + w.width && saved.x + WIDGET_SIZE.width > w.x
        && saved.y < w.y + w.height && saved.y + WIDGET_SIZE.height > w.y;
    });
    return onScreen ? { x: saved.x, y: saved.y } : null;
  } catch {
    return null;   // absent or corrupt — fall back to the default corner
  }
}

function saveBounds() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  try {
    const [x, y] = widgetWindow.getPosition();
    fs.writeFileSync(BOUNDS_PATH, JSON.stringify({ x, y }));
  } catch (err) {
    log(`saveBounds failed: ${err && err.message}`);
  }
}

function defaultBounds() {
  // Bottom-right of the primary display's work area, inset by a comfortable
  // margin — out of the way of whatever is being worked on, which is where a
  // glance widget belongs.
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x + workArea.width - WIDGET_SIZE.width - 24,
    y: workArea.y + workArea.height - WIDGET_SIZE.height - 24,
  };
}

function createWidget() {
  const pos = readBounds() || defaultBounds();
  widgetWindow = new BrowserWindow({
    ...WIDGET_SIZE,
    ...pos,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,       // it is a widget, not a second app in the switcher
    icon: ICON_PATH,
    backgroundColor: '#faf8f4',   // --surface, so it opens as paper not white
    webPreferences: {
      preload: WIDGET_PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  hardenNavigation(widgetWindow);

  // 'floating' keeps it above ordinary windows without fighting full-screen
  // apps and system UI for the very top of the stack.
  widgetWindow.setAlwaysOnTop(true, 'floating');
  widgetWindow.on('moved', saveBounds);
  widgetWindow.on('close', saveBounds);
  widgetWindow.on('closed', () => { widgetWindow = null; refreshTrayMenu(); });
  widgetWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`widget did-fail-load: code=${code} desc=${desc} url=${url}`);
  });
  widgetWindow.webContents.on('did-finish-load', () => log('widget did-finish-load'));

  widgetWindow.loadURL(`${APP_ORIGIN}/widget.html`);
}

function toggleWidget() {
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.close();
    return;
  }
  createWidget();
  refreshTrayMenu();
}

function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  createWindow();
}

// NOTE: these labels are English-only. The renderer is fully localised in ten
// languages via i18next, but that lives in the renderer and the tray menu is
// built in the main process, which has no translator. Logged as a known gap
// rather than left to look intentional.
function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Glance widget',
      type: 'checkbox',
      checked: Boolean(widgetWindow && !widgetWindow.isDestroyed()),
      click: toggleWidget,
    },
    { label: 'Open StudyDesk', click: openMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray() {
  try {
    tray = new Tray(ICON_PATH);
    tray.setToolTip('StudyDesk');
    tray.on('double-click', openMainWindow);
    refreshTrayMenu();
  } catch (err) {
    // A missing tray is a degraded app, not a broken one — the main window
    // still works, so this must never take the launch down with it.
    log(`createTray failed: ${err && err.stack}`);
  }
}

ipcMain.on('widget:close', () => {
  if (widgetWindow && !widgetWindow.isDestroyed()) widgetWindow.close();
});

// Renderer asks for the provider URL to be opened in the real browser. This is
// the only way a sign-in starts on desktop now, and arming `authPending` here
// is what makes the loopback listener willing to accept the code that follows.
ipcMain.handle('auth:begin', (_event, url) => {
  // https only. `openExternally` tolerates http because ordinary links in the
  // renderer legitimately are http; an OAuth leg over plain http would not be.
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  const opened = openExternally(url);
  if (opened) authPending = true;
  return opened;
});

app.whenReady().then(async () => {
  log('app.whenReady resolved');
  registerProtocolHandler();
  log(`serving ${DIST_DIR} at ${APP_ORIGIN}/ (stable origin)`);
  // Before createWindow: the redirect URI is passed to the renderer as a
  // preload argument, which is fixed at window-construction time.
  await startAuthLoopback();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

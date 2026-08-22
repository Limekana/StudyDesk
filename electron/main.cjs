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
//   - `studydesk://app/` is the app's web origin now. Any Supabase redirect-URL
//     allowlist entry for the desktop build must use it — the old random-port
//     127.0.0.1 URLs could never have been allowlisted, which is why OAuth was
//     never usable here and email sign-in is the desktop path.
//   - The one-time cost of moving origin is that whatever sat in the old
//     random-port bucket is orphaned. Nothing is lost that wasn't already being
//     lost on every launch.
//
// The static server is gone entirely rather than kept alongside: it existed to
// provide SPA-fallback routing, and `resolveRequest` below does that directly.
'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const ICON_PATH = path.join(__dirname, '..', 'resources', 'icon.ico');
const WIDGET_PRELOAD = path.join(__dirname, 'widget-preload.cjs');

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
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

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

app.whenReady().then(() => {
  log('app.whenReady resolved');
  registerProtocolHandler();
  log(`serving ${DIST_DIR} at ${APP_ORIGIN}/ (stable origin)`);
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

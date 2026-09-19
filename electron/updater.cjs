// v1.15 (Item 12) — desktop updates: find, download, install.
//
// Built on electron-updater (NSIS). It reads `latest.yml` from the newest
// GitHub Release, downloads the Setup .exe (or only the changed blocks, via
// the `.blockmap`), checks it against the SHA-512 in `latest.yml`, and on
// "Restart to update" runs the installer silently over the existing install.
//
// RELEASE CONTRACT — this only works if every GitHub Release for this app
// carries, next to the Setup .exe, the `latest.yml` and `<Setup>.exe.blockmap`
// that electron-builder writes into `release/`. Forget them and the updater
// cannot see that release. See FDROID_RELEASE_CHECKLIST.md section B.
//
// Unsigned on purpose (owner call, 2026-09-18). With no `publisherName` in the
// build config, electron-updater skips the Authenticode check and the SHA-512
// from `latest.yml`, fetched over HTTPS from the repo's own release, is the
// integrity check.
//
// When the updater cannot run — an unpackaged dev launch, or a release that
// has no `latest.yml` — this falls back to update-check.cjs: say a newer
// release exists and open its page. The download never starts on its own;
// the user asks for it, since a full installer is ~120 MB.
'use strict';

const { app, ipcMain } = require('electron');
const { createUpdateChecker } = require('./update-check.cjs');

/**
 * @param {{
 *   repo: string,                        // "Owner/Name" on GitHub
 *   installerPrefix: string,             // Setup .exe name up to the version
 *   log: (line: string) => void,
 *   getWindow: () => Electron.BrowserWindow | null,
 *   openExternally: (url: string) => boolean,
 * }} opts
 */
function setupUpdates({ repo, installerPrefix, log, getWindow, openExternally }) {
  const fallback = createUpdateChecker({ repo, installerPrefix, log });
  const releasesPage = `https://github.com/${repo}/releases/latest`;

  let updater = null;
  if (app.isPackaged) {
    try {
      ({ autoUpdater: updater } = require('electron-updater'));
      updater.autoDownload = false;
      // A downloaded update installs on the next normal quit too, so it is
      // never lost just because the user closed the window instead.
      updater.autoInstallOnAppQuit = true;
      updater.logger = {
        info: (m) => log(`updater: ${m}`),
        warn: (m) => log(`updater warn: ${m}`),
        error: (m) => log(`updater error: ${m}`),
        debug: () => {},
      };
      updater.on('download-progress', (p) => {
        set({ percent: Math.floor(p.percent || 0) });
      });
    } catch (err) {
      log(`electron-updater unavailable: ${err && err.message}`);
      updater = null;
    }
  }

  // status: idle | checking | current | available | downloading | ready | error
  // canInstall: false means "notify only" — the button opens the release page.
  let state = {
    status: 'idle', current: app.getVersion(), latest: null, canInstall: false, percent: 0,
  };
  let checking = null;

  function set(patch) {
    state = { ...state, ...patch };
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update:state', state);
    return state;
  }

  async function runCheck(force) {
    set({ status: 'checking' });
    if (updater) {
      try {
        const res = await updater.checkForUpdates();
        if (!res || !res.updateInfo || !res.updateInfo.version) throw new Error('no update info');
        // The updater's own verdict, not a second comparison of ours: it is
        // what downloadUpdate() will hold us to, and it also weighs staged
        // rollouts and minimum OS versions.
        const newer = res.isUpdateAvailable === true;
        const latest = res.updateInfo.version;
        log(`update check (updater): current ${state.current}, latest ${latest}${newer ? ' — newer' : ''}`);
        return set({ status: newer ? 'available' : 'current', latest, canInstall: newer });
      } catch (err) {
        // Most often: the newest release has no latest.yml. Fall through to
        // the notice-only path rather than going quiet.
        log(`updater check failed, falling back to notice: ${err && err.message}`);
      }
    }
    const res = await fallback.check(force);
    return set({ status: res.status, latest: res.latest, canInstall: false });
  }

  function check(force) {
    // Never interrupt a download or a finished one waiting to install.
    if (state.status === 'downloading' || state.status === 'ready') return Promise.resolve(state);
    if (!checking || force) {
      checking = runCheck(force).finally(() => { checking = null; });
    }
    return checking;
  }

  async function download() {
    if (!updater || state.status !== 'available' || !state.canInstall) return false;
    set({ status: 'downloading', percent: 0 });
    try {
      await updater.downloadUpdate();
      log(`update ${state.latest} downloaded and verified`);
      set({ status: 'ready', percent: 100 });
      return true;
    } catch (err) {
      // Leave a working way out: the button turns into "open release page".
      log(`update download failed: ${err && err.message}`);
      set({ status: 'available', canInstall: false, percent: 0 });
      return false;
    }
  }

  function install() {
    if (!updater || state.status !== 'ready') return false;
    log(`installing ${state.latest}`);
    // Silent (the user already said yes, and NSIS reuses the existing install
    // directory), then relaunch the app. Deferred a tick so the IPC reply gets
    // out before the app starts shutting down.
    setImmediate(() => updater.quitAndInstall(true, true));
    return true;
  }

  ipcMain.handle('update:check', (_e, force) => check(force === true));
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:install', () => install());
  // Opens only a URL this process fetched and validated, or the repo's own
  // releases page. The renderer never supplies one.
  ipcMain.handle('update:open', () => openExternally(fallback.releaseUrl() || releasesPage));

  return { check };
}

module.exports = { setupUpdates };

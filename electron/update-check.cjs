// v1.15 (Item 12) — "is there a newer release?", and nothing more.
//
// The desktop edition had no update awareness at all: it ships as a GitHub
// Release asset, and the only way to learn about a new one was to go and look.
// Android does not have this gap — F-Droid's own client notices new tags — so
// this is desktop-only by construction.
//
// Deliberately check-and-notify, not an auto-updater. A silent installer
// (electron-updater) needs a `publish` block, `latest.yml` and blockmaps
// uploaded on every release — a release-pipeline change, untested against the
// manual `gh release create` flow — and it could only ever cover the NSIS
// install: the `.zip` edition has nothing for it to replace. Telling the user a
// release exists and opening its page works identically for both.
//
// The request runs here in the main process rather than the renderer, so the
// page's CSP stays untouched and the renderer never chooses what gets opened:
// `open()` only ever opens the release URL this module itself fetched and
// checked.
'use strict';

const { app, net } = require('electron');

const TIMEOUT_MS = 10_000;

// "v1.14.1" / "1.14.1" -> [1, 14, 1]. Anything else -> null, and a tag that
// does not parse is never reported as newer: a notice that fires on a typo'd
// tag is worse than no notice.
function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  for (let i = 0; i < 3; i++) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

/**
 * @param {{ repo: string, log: (line: string) => void }} opts
 *   repo — "Owner/Name" on GitHub.
 */
function createUpdateChecker({ repo, log }) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`;
  const pagePrefix = `https://github.com/${repo}/releases/`.toLowerCase();
  let pending = null;
  let releaseUrl = null;

  async function fetchLatest() {
    const current = app.getVersion();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await net.fetch(api, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `${app.getName()}/${current}`,
        },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const latest = parseVersion(body.tag_name);
      const cur = parseVersion(current);
      const url = typeof body.html_url === 'string' ? body.html_url : '';
      if (!latest || !cur || !url.toLowerCase().startsWith(pagePrefix)) {
        throw new Error(`unusable release payload (tag=${body.tag_name})`);
      }
      const available = isNewer(latest, cur);
      releaseUrl = available ? url : null;
      log(`update check: current ${current}, latest ${latest.join('.')}${available ? ' — newer' : ''}`);
      return { status: available ? 'available' : 'current', current, latest: latest.join('.') };
    } catch (err) {
      // Offline, rate-limited, GitHub down: say nothing to the user. A failed
      // check is not news, and the next launch tries again.
      log(`update check failed: ${err && err.message}`);
      return { status: 'error', current, latest: null };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** One network request per launch unless `force` (the manual check). */
    check(force) {
      if (force || !pending) pending = fetchLatest();
      return pending;
    },
    /** The URL handed to `openExternally` — null when nothing is newer. */
    releaseUrl: () => releaseUrl,
  };
}

module.exports = { createUpdateChecker, parseVersion, isNewer };

// Run electron-builder with a repo-local tool cache.
//
// WHY THIS EXISTS
//
// electron-builder downloads NSIS and a bundled 7-Zip into a cache directory,
// extracts each into `<name>.tmp/`, then renames that directory into place.
// On this machine that rename fails from Node with EXDEV — "cross-device link
// not permitted" — for every build, which kills `--win` before it can produce
// an installer.
//
// The name is a red herring: it is not actually crossing a device. Verified by
// experiment rather than assumed:
//
//   - Both paths are on C:, and nothing on the path is a junction or a
//     reparse point (checked each segment).
//   - PowerShell's Move-Item performs the identical rename successfully.
//   - A minimal Node script doing one `fs.renameSync` of a directory anywhere
//     under `%LOCALAPPDATA%\electron-builder\Cache` fails EXDEV, whether or
//     not the destination already exists.
//   - The same script against a directory on D: succeeds.
//
// So Node's MoveFileExW is being intercepted under that path — a filesystem
// filter, controlled-folder-access, or similar — and the only reliable fix is
// to put the cache somewhere else. `ELECTRON_BUILDER_CACHE` does exactly that.
//
// The cache goes inside the repo (and is gitignored) rather than at an
// absolute path, so it lands on the same volume as the checkout without this
// script needing to know which machine it is on. Deleting it is always safe;
// electron-builder re-downloads.
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.electron-cache');

fs.mkdirSync(CACHE, { recursive: true });

// Resolve electron-builder's own JS entry and run it on this Node, rather than
// going through `npx`. Node 20+ refuses to spawnSync a `.cmd` shim without
// `shell: true` (EINVAL), and turning the shell on just to reach a script we
// can address directly would put argument quoting between us and the build.
const cli = require.resolve('electron-builder/cli.js');

const result = spawnSync(
  process.execPath,
  [cli, ...process.argv.slice(2)],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_BUILDER_CACHE: CACHE },
  },
);

if (result.error) {
  console.error('[build] failed to launch electron-builder:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

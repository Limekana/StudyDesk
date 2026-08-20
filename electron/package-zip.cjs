// Wrap the NSIS installer in a single distributable zip.
//
// electron-builder already emits release/StudyDesk-Desktop-Setup-<v>.exe,
// which is the thing people actually install from. It does NOT emit a zip of
// that installer: its own `zip` target packages the *unpacked app directory*,
// which is a different artifact — a folder you run in place, not something you
// install. Shipping both would mean handing users two downloads that look
// interchangeable and are not.
//
// So this takes the one artifact worth distributing and zips it, giving a
// single file to attach to a GitHub Release. A zip rather than the bare .exe
// because browsers and mail gateways treat a downloaded .exe with suspicion,
// and because GitHub Release assets keep their name better inside an archive.
//
// PowerShell's Compress-Archive rather than a dependency: this only ever runs
// on Windows (electron-builder --win), it is present on every supported
// version, and adding an npm package to compress one file would be the larger
// change.
//
// Run: npm run electron:zip   (chained automatically by electron:build)
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const { version } = require(path.join(ROOT, 'package.json'));

const exeName = `StudyDesk-Desktop-Setup-${version}.exe`;
const exePath = path.join(RELEASE_DIR, exeName);
const zipPath = path.join(RELEASE_DIR, `StudyDesk-Desktop-${version}.zip`);

if (!fs.existsSync(exePath)) {
  console.error(`[zip] installer not found: ${exePath}`);
  console.error('[zip] run "npm run electron:build" first — electron-builder emits it.');
  process.exit(1);
}

// Compress-Archive refuses to overwrite without -Force, and a stale zip from a
// previous run would otherwise be silently shipped.
fs.rmSync(zipPath, { force: true });

execFileSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Compress-Archive -Path '${exePath}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
  ],
  { stdio: 'inherit' },
);

const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`[zip] ${path.basename(zipPath)}  (${mb} MB)  containing ${exeName}`);

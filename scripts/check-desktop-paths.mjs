#!/usr/bin/env node
// Assert that the packaged desktop app can be updated over: no mobile sources
// packed into it, and no installed path long enough to break the update.
//
// Run manually:  node scripts/check-desktop-paths.mjs
// Runs at the end of `npm run electron:build`, against release/win-unpacked.
//
// Why this exists (limecore#52). Desktop builds up to 1.16 packed every
// production dependency, Capacitor's Android sources and their Gradle build
// output included: ~6,000 files under resources\app.asar.unpacked, nested so
// deep that the longest sat at 254 characters once installed. An update runs
// the OLD version's uninstaller, which moves each file into
// %TEMP%\nsXXXX.tmp\old-install\ first and gives up if one move fails. Past
// 259 characters the move fails, so 1.15 -> 1.16 failed on every StudyDesk
// install ("Failed to uninstall old application files ...: 2"), and on NCC
// for any Windows username of 8 letters or more.
//
// The desktop app loads nothing from those sources: the renderer is bundled
// into dist/, and the main process needs only electron-updater. So the
// package must carry none of them, and every installed path must stay far
// enough under the limit to survive a long username and a long %TEMP%.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const UNPACKED = join(ROOT, 'release', 'win-unpacked');
// Installed under C:\Users\<name>\AppData\Local\Programs\<product>\ and moved
// to C:\Users\<name>\AppData\Local\Temp\nsXXXX.tmp\old-install\ on update:
// about 50 characters plus the username before this relative path starts.
// 160 leaves room for a 45-character username within Windows' 259.
const MAX_RELATIVE = 160;
const MOBILE = /[\\/]node_modules[\\/](?:.*[\\/])?(?:android|ios)[\\/]/;

function fail(msg) {
  console.error(`\n  DESKTOP PATH CHECK FAILED\n\n${msg}\n`);
  process.exit(1);
}

if (!existsSync(UNPACKED)) {
  fail(`    ${relative(ROOT, UNPACKED)} does not exist. Run \`npm run electron:build\` first.`);
}

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(relative(UNPACKED, p));
  }
})(UNPACKED);

const mobileOnDisk = files.filter((f) => MOBILE.test(sep + f));
if (mobileOnDisk.length) {
  fail(
    `    ${mobileOnDisk.length} Android/iOS files are installed loose, e.g.\n` +
    `      ${mobileOnDisk[0]}\n` +
    `    Exclude them in package.json \`build.files\`.`,
  );
}

const longest = files.reduce((a, b) => (b.length > a.length ? b : a), '');
if (longest.length > MAX_RELATIVE) {
  fail(
    `    The longest installed path is ${longest.length} characters (limit ${MAX_RELATIVE}):\n` +
    `      ${longest}\n` +
    `    The previous version's uninstaller cannot move a path this long, so\n` +
    `    updates over this build would fail.`,
  );
}

// Packed inside app.asar these cost no path length, but they are the same
// sources: if any are here, the exclusion in `build.files` has stopped working.
const asar = createRequire(import.meta.url)('@electron/asar');
const packed = asar.listPackage(join(UNPACKED, 'resources', 'app.asar'));
const mobilePacked = packed.filter((p) => MOBILE.test(p));
if (mobilePacked.length) {
  fail(
    `    app.asar carries ${mobilePacked.length} Android/iOS entries, e.g.\n` +
    `      ${mobilePacked[0]}\n` +
    `    Exclude them in package.json \`build.files\`.`,
  );
}

console.log(
  `Desktop path check passed: ${files.length} installed files, longest ${longest.length} characters ` +
  `(${longest}); no Android/iOS sources loose or in app.asar (${packed.length} entries).`,
);

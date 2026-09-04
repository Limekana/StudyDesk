#!/usr/bin/env node
// Assert that dist/ was actually produced by a build of the CURRENT source.
//
// Run manually:  node scripts/check-dist-fresh.mjs
// Run at release time, BEFORE `npx cap sync android` and before the
// stale-asset diff in the F-Droid checklist's Section B.
//
// Why this exists. On 2026-09-04 a release APK was produced that was 8 bytes
// different from v1.12.1 and contained none of the v1.13 code. The chain:
// `vite build` failed, so dist/ kept its 2026-09-02 contents; `npx cap sync
// android` copied that stale dist/ into the APK; `assembleRelease` succeeded.
// The stale-asset gate then compared the APK's assets against dist/, found
// them identical, and reported 10/10.
//
// The gate was not wrong about what it measured. It compares the APK to dist/
// and never asks whether dist/ is fresh, so a two-day-old dist/ passes it
// perfectly. That is the same hole the v1.7.0 incident was supposed to have
// closed. This check is the missing half: it establishes that dist/ is newer
// than the source it claims to be a build of, so the diff downstream of it
// means something.
//
// Ordering matters. Run this AFTER the build and BEFORE cap sync — a failing
// build leaves the old dist/ in place and exits non-zero, and the whole point
// of the incident is that nobody noticed the non-zero exit.

import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

// Everything that ends up in the web bundle. If a path here changes, dist/ is
// stale until the next build.
const SOURCE_PATHS = ['src', 'public', 'index.html', 'widget.html', 'vite.config.js', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.git']);

// The freshness signal is taken from the files Rollup EMITS, not from
// everything under dist/. Emitted files are rewritten from scratch on every
// successful build, so their mtime is unambiguously "when the build ran".
// Files copied verbatim out of public/ are excluded on purpose — see the note
// above oldest() for why that distinction is the one worth drawing.
const BUILT_PATHS = ['index.html', 'widget.html', 'assets'];

function newest(path, acc = { mtime: 0, file: null }) {
  if (!existsSync(path)) return acc;
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (SKIP_DIRS.has(entry)) continue;
      acc = newest(join(path, entry), acc);
    }
    return acc;
  }
  if (st.mtimeMs > acc.mtime) return { mtime: st.mtimeMs, file: relative(ROOT, path) };
  return acc;
}

function oldest(path, acc = { mtime: Infinity, file: null }) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) acc = oldest(join(path, entry), acc);
    return acc;
  }
  if (st.mtimeMs < acc.mtime) return { mtime: st.mtimeMs, file: relative(ROOT, path) };
  return acc;
}

// Two things this check has to get right, and they pull in opposite directions.
//
// 1. WHICH FILES. Only the build's own emitted output: dist/index.html,
//    dist/widget.html and dist/assets/**. Everything else under dist/ is
//    copied verbatim out of public/ (fonts, logos, vite.svg, robots.txt), and
//    a copied file's mtime is a property of the copy mechanism rather than of
//    the build. Whatever a given Vite version, filesystem or platform does
//    with timestamps on those copies, it cannot make this gate lie, because
//    the gate does not look at them.
//
//    On this tree Vite in fact stamps copies at copy time — verified by
//    stamping a source file into the past and rebuilding:
//
//      $ touch -d 2020-01-01T00:00:00Z public/vite.svg
//      $ rm -rf dist && npm run build
//      $ stat -c '%y  %n' public/vite.svg dist/vite.svg
//      2020-01-01 00:00:00  public/vite.svg
//      2026-09-04 20:47:20  dist/vite.svg      <- build time, not 2020
//
//    so scoping is not strictly required here today. It is still the right
//    scope: it is the assumption-free one, and a report of this gate
//    false-failing on a long-lived checkout is exactly what a copied-file
//    timestamp would look like if some environment did preserve it.
//
// 2. OLDEST, NOT NEWEST, among those files. They are not symmetric once
//    something is wrong:
//
//      * oldest -> fails unless EVERY emitted file is newer than the source.
//        A stray stale file is a false failure. Fail-safe.
//      * newest -> passes if ANY ONE emitted file is newer than the source.
//        A half-written dist/, or one file touched by hand, is a false PASS.
//        Fail-open.
//
//    Demonstrated on this tree: a stale dist/ plus `touch dist/index.html`
//    plus a newer source file passes under newest() and fails under oldest().
//
//    This gate exists because a fail-open shipped a v1.12.1 APK labelled
//    1.13.0. Its direction is not a detail to trade away for convenience.

const fail = (msg) => {
  console.error(`\nDist freshness check failed:\n\n  ✗ ${msg}\n`);
  console.error(
    'Do not sync or package this dist/. The stale-asset diff downstream compares\n' +
    'the APK to dist/ and will pass on a stale one — that is how a v1.12.1 APK\n' +
    'shipped labelled 1.13.0.\n',
  );
  process.exit(1);
};

if (!existsSync(DIST)) {
  fail('dist/ does not exist. Run `npm run build` first, and check its exit code.');
}

// A dist/ without an entry point is a half-written directory, not a build.
if (!existsSync(join(DIST, 'index.html'))) {
  fail('dist/index.html is missing — dist/ is not a complete build output.');
}

const src = SOURCE_PATHS.reduce(
  (acc, p) => newest(join(ROOT, p), acc),
  { mtime: 0, file: null },
);
const built = BUILT_PATHS.reduce(
  (acc, p) => (existsSync(join(DIST, p)) ? oldest(join(DIST, p), acc) : acc),
  { mtime: Infinity, file: null },
);

if (built.file === null) {
  fail('dist/ contains none of index.html, widget.html or assets/ — not a build output.');
}

if (built.mtime < src.mtime) {
  const ageMin = Math.round((src.mtime - built.mtime) / 60000);
  fail(
    `dist/ is older than the source it should have been built from.\n` +
    `    Newest source: ${src.file}\n` +
    `                   ${new Date(src.mtime).toISOString()}\n` +
    `    Oldest output: ${built.file}\n` +
    `                   ${new Date(built.mtime).toISOString()}\n` +
    `    At least one file the build emits predates that source change, so\n` +
    `    dist/ was not rebuilt after it — the build did not run, or it failed.\n` +
    `    dist/ lags source by ${ageMin} minute${ageMin === 1 ? '' : 's'}.\n` +
    `    Re-run \`npm run build\` and confirm it exits zero.`,
  );
}

const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
console.log(
  `Dist freshness check passed: dist/ (oldest emitted file ${new Date(built.mtime).toISOString()}) ` +
  `is newer than the newest source file, ${src.file}.\n` +
  `  Bundle is a build of package.json version ${version}.`,
);

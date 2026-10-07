#!/usr/bin/env node
// Fail when a shipped image is heavier than it needs to be.
//
// Run manually:  node scripts/check-assets.mjs
// Run in CI:     npm run check:assets
//
// Why this exists (v1.17, limecore#20). Weight crept in unnoticed: public/ was
// shipping four icon test renders and two logo variants nothing referenced
// (212 KB), on the website and inside every APK, and LimeLog and NCC carried
// multi-megabyte splash PNGs. Nothing looked at image sizes, so nothing
// stopped it.
//
// What is checked:
//   - public/: shipped in the web build and inside the APK.
//   - android/app/src/main/res/: shipped inside the APK.
// Any image over BUDGET_KB fails, unless it is listed in ALLOW with a reason.
// A resource that exists as both .png and .webp in one folder also fails:
// Android rejects the duplicate at build time, and this says why up front
// (an icon generator writing PNGs over the WebP splashes would cause it).
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_KB = 100;
// path (from the repo root) -> why it may be over budget. Empty today.
const ALLOW = new Map([]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['public', 'android/app/src/main/res'];
const IMAGE = /\.(png|webp|jpe?g|gif)$/i;

const files = [];
function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path);
    else if (IMAGE.test(e.name)) files.push(path);
  }
}
for (const d of DIRS) walk(join(ROOT, d));

const problems = [];
const byStem = new Map();
for (const path of files) {
  const rel = relative(ROOT, path).split('\\').join('/');
  const kb = statSync(path).size / 1024;
  if (kb > BUDGET_KB && !ALLOW.has(rel)) problems.push(`${rel}: ${kb.toFixed(1)} KB, over the ${BUDGET_KB} KB budget`);
  const stem = rel.slice(0, -extname(rel).length);
  if (rel.startsWith('android/')) byStem.set(stem, [...(byStem.get(stem) ?? []), extname(rel)]);
}
for (const [stem, exts] of byStem) {
  if (exts.length > 1) problems.push(`${stem}: exists as ${exts.join(' and ')}; Android allows one`);
}
for (const rel of ALLOW.keys()) {
  if (!files.some((p) => relative(ROOT, p).split('\\').join('/') === rel)) {
    problems.push(`${rel}: allow-listed but missing; remove it from ALLOW`);
  }
}

if (problems.length) {
  console.error(`check:assets failed (${files.length} images scanned):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('Re-export the image smaller (WebP for Android resources), or add it to ALLOW with a reason.');
  process.exit(1);
}
console.log(`check:assets passed: ${files.length} images, none over ${BUDGET_KB} KB outside the allow-list.`);

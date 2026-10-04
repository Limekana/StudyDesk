#!/usr/bin/env node
// Fail the build when the JavaScript a cold start has to load grows past its
// budget.
//
// Run manually:  npm run build && npm run check:bundle-size
// Run in CI:     after the build gate.
//
// Why this exists. Every launch downloads, parses and runs the startup chunks
// before the first screen can render, and on a low-end Android WebView that is
// most of the cold start. v1.17 (limecore#13, #18) cut them by moving the
// languages and every screen a launch does not open on into their own chunks.
// Nothing stops a later change from undoing that with one static import of a
// lazy screen or a heavy library, and the build gives no sign when it happens.
//
// What is measured. The scripts `dist/index.html` loads before anything else:
// its module entry and the chunks Vite modulepreloads for it, as on-disk bytes
// (the limecore#13 method, so the numbers match the release notes). Lazy
// chunks are not counted; they load when used.
//
// The budget only goes down. When a change shrinks startup, lower it in the
// same PR. Raising it is a decision to make on purpose, in a PR that says why.
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUDGET_KIB = 730; // measured 2026-10-04 after limecore#13: 698.0 KiB (base + main)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

let html;
try {
  html = readFileSync(join(DIST, 'index.html'), 'utf8');
} catch {
  console.error('check:bundle-size: dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

const tags = html.match(/<(script|link)\b[^>]*>/g) ?? [];
const files = [];
for (const tag of tags) {
  const isEntry = /^<script\b/.test(tag) && /type="module"/.test(tag);
  const isPreload = /^<link\b/.test(tag) && /rel="modulepreload"/.test(tag);
  if (!isEntry && !isPreload) continue;
  const ref = (tag.match(/\b(?:src|href)="([^"]+)"/) ?? [])[1];
  if (!ref || /^[a-z]+:/i.test(ref)) continue;
  files.push(ref.replace(/^\.?\//, ''));
}

if (files.length === 0) {
  console.error('check:bundle-size: no module scripts found in dist/index.html.');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const bytes = statSync(join(DIST, f)).size;
  total += bytes;
  console.log(`  ${f}  ${bytes} B`);
}
const kib = total / 1024;
const line = `startup JS ${total} B = ${kib.toFixed(1)} KiB, budget ${BUDGET_KIB} KiB`;
if (kib > BUDGET_KIB) {
  console.error(`check:bundle-size FAILED: ${line}.`);
  console.error('Something that used to load on demand is now in a startup chunk. Look for a new');
  console.error('static import of a lazy screen, view or language, or a heavy library imported');
  console.error('from code that runs at startup.');
  process.exit(1);
}
console.log(`check:bundle-size passed: ${line}.`);

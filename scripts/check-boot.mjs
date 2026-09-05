#!/usr/bin/env node
// Load the PRODUCTION bundle in a real browser and assert the app actually
// renders something.
//
// Run manually:  npm run build && npm run check:boot
// Run in CI:     after the build gate.
//
// ── Why this exists ───────────────────────────────────────────────────────
//
// v1.13 shipped an APK that cold-launched to a completely blank screen. Not
// slow, not a flash — `uiautomator dump` on the live view hierarchy showed
// `<div id="root">` present, full-screen, with ZERO children. React never
// committed anything.
//
// The cause was a temporal-dead-zone error: `session` was declared with
// `useState` partway down App.jsx, and effects ABOVE that line listed it in
// their dependency arrays. A dependency array is evaluated during render, so
// the first render read the binding before its `const` had run and threw
// `ReferenceError: Cannot access 'session' before initialization`. React
// unwound, nothing mounted, and the user saw the app's cream ground.
//
// The same bug shipped in v1.10. The fix that time was a comment asking the
// next author to keep their effect below the declaration; v1.13's notebook
// work added four more readers above it and blanked the app again.
//
// ── Why every existing gate missed it, twice ──────────────────────────────
//
//   * `npm run build` succeeds. This is valid JavaScript; the error is at
//     runtime, and Rollup has no reason to object.
//   * eslint is clean. `react-hooks/exhaustive-deps` checks WHICH values a
//     dependency array lists, not whether they are initialised when it runs.
//     No lint rule models TDZ across a function body.
//   * `npm run dev` does not reproduce it. The dev server serves unbundled
//     ESM, which evaluates module bindings differently from the production
//     chunk; the app boots fine.
//   * The Vercel preview reports Ready, because the BUILD succeeded. Nobody
//     had loaded the page.
//   * check-logic.mjs covers the pure layer and cannot mount a component.
//
// Every signal the project had was green while the app did not open at all.
// The only thing that catches this class is loading the built bundle in a
// browser, which is what this does. It found the v1.13 instance in one run.
//
// This deliberately asserts almost nothing about WHAT renders — that is the
// job of the app's other checks. It asserts the two things whose absence
// means the app is dead on arrival: no uncaught exception, and `#root` is
// not empty.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.BOOT_CHECK_PORT || 4179);
// Generous: a cold Chromium start plus module evaluation on a loaded CI runner.
// This is not a performance budget — it is "did the app ever render".
const SETTLE_MS = Number(process.env.BOOT_CHECK_SETTLE_MS || 8000);

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('\nBoot check failed:\n\n  ✗ dist/index.html is missing. Run `npm run build` first.\n');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// A tiny static server rather than `vite preview`, so this check does not
// depend on a dev server's own behaviour or leave a child process behind.
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    // normalize + prefix check: this serves only from dist/, even though it is
    // a local test server.
    let path = normalize(join(DIST, decodeURIComponent(url.pathname)));
    if (!path.startsWith(DIST)) { res.writeHead(403).end(); return; }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(DIST, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    '\nBoot check could not run:\n\n' +
    '  ✗ playwright is not installed.\n' +
    '    Install dev dependencies (`npm ci`) and a browser\n' +
    '    (`npx playwright install chromium`).\n\n' +
    '    This check is the only gate that catches a production-only render\n' +
    '    crash, so it fails rather than skipping — a skipped boot check is\n' +
    '    how a blank-screen build shipped twice.\n',
  );
  process.exit(1);
}

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(PORT, '127.0.0.1', resolve);
});

const problems = [];
let rootChildren = -1;
let browser;

try {
  // `BOOT_CHECK_CHROMIUM` lets an environment that already has a browser point
  // at it instead of requiring `npx playwright install` — a container image
  // with Chromium baked in, or a machine where the pinned Playwright's browser
  // build differs from the one on disk. Unset (the normal case, including CI
  // after `playwright install chromium`), Playwright resolves its own.
  const executablePath = process.env.BOOT_CHECK_CHROMIUM || undefined;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await (await browser.newContext()).newPage();

  page.on('pageerror', (e) => problems.push(`Uncaught exception:\n      ${(e.stack || e.message).split('\n').join('\n      ')}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(SETTLE_MS);

  rootChildren = await page.evaluate(() => {
    const el = document.getElementById('root');
    return el ? el.children.length : -1;
  });
} catch (e) {
  problems.push(`The browser could not load the app at all: ${e.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

if (rootChildren === -1) {
  problems.push('#root does not exist in the document — index.html is not the app shell.');
} else if (rootChildren === 0) {
  problems.push(
    '#root exists but has ZERO children — React mounted nothing.\n' +
    '      This is the exact signature of the v1.13 blank-screen blocker: the\n' +
    '      app shell is present and completely empty. If there is an uncaught\n' +
    '      exception above, that is the cause.',
  );
}

if (problems.length) {
  console.error(`\nBoot check FAILED (${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}):\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  console.error(
    'The production bundle does not render. Do not ship this build — it will\n' +
    'cold-launch to a blank screen on device, with no crash in logcat, because\n' +
    'WebView console output is not bridged in a release build.\n',
  );
  process.exit(1);
}

console.log(`Boot check passed: the production bundle rendered ${rootChildren} root ${rootChildren === 1 ? 'child' : 'children'} with no uncaught errors.`);

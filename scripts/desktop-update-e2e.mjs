#!/usr/bin/env node
// End-to-end test of a desktop update, driving the INSTALLED app's own
// electron-updater against a local feed: check, download, SHA-512 verify,
// silent install, relaunch. Windows only. Release gate for limecore#52.
//
//   node scripts/desktop-update-e2e.mjs --feed <dir>
//
// <dir> holds what one `electron:build` writes into release/: latest.yml, the
// Setup .exe and its .blockmap. Build it with a version above the installed
// one, e.g. `node electron/build.cjs --win --publish never
// -c.extraMetadata.version=1.16.91`, and copy the three files out, because
// the next build overwrites release/. Add the installed version's .blockmap
// to try a differential download first; this feed answers range requests
// with the whole file, so electron-updater falls back to a full download
// (GitHub serves ranges, so real updates usually go differential).
//
// The app must already be installed per-user (the default) and closed. The
// test points that install's resources\app-update.yml at the feed, so it
// replaces the real updater config until the update installs a new one. On a
// failure the original file is put back.
//
// Every process that touches the install, %APPDATA% or the registry is
// started through WMI (Win32_Process.Create). From a Claude session that
// matters: anything Claude starts runs inside its MSIX package, where
// %LOCALAPPDATA%, %APPDATA% and HKCU are virtualized, and an update launched
// from there installs into the package's private copy instead (the 2026-09-18
// incident). From an ordinary terminal WMI changes nothing.

import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const product = pkg.build.productName;
const exeName = `${product}.exe`;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
if (!args.feed) {
  console.error('usage: node scripts/desktop-update-e2e.mjs --feed <dir> [--port 47615] [--cdp 47616]');
  process.exit(2);
}
const FEED = resolve(args.feed);
const PORT = Number(args.port || 47615);
const CDP = Number(args.cdp || 47616);
const WORK = join(ROOT, 'release', 'e2e-work');
mkdirSync(WORK, { recursive: true });

const feedYml = readFileSync(join(FEED, 'latest.yml'), 'utf8');
const target = /^version:\s*(\S+)/m.exec(feedYml)[1];

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const step = (msg) => console.log(`${secs()}s  ${msg}`);
function fail(msg) {
  console.error(`\n  DESKTOP UPDATE E2E FAILED: ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
}

// Run a PowerShell script outside any package virtualization and wait for it.
let seq = 0;
async function outside(ps, timeoutMs = 60_000) {
  const id = `${process.pid}-${++seq}`;
  const script = join(WORK, `step-${id}.ps1`);
  const out = join(WORK, `step-${id}.out`);
  const done = `${out}.done`;
  writeFileSync(script, `$ErrorActionPreference='Continue'\n& {\n${ps}\n} *>&1 | Out-File -LiteralPath '${out}' -Encoding utf8\nSet-Content -LiteralPath '${done}' -Value 'x'\n`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${script}"' }; if ($r.ReturnValue -ne 0) { exit 1 }`]);
  const until = Date.now() + timeoutMs;
  while (!existsSync(done)) {
    if (Date.now() > until) fail(`outside step timed out: ${ps.split('\n')[0]}`);
    await sleep(250);
  }
  const text = existsSync(out) ? readFileSync(out, 'utf8').replace(/^﻿/, '').trim() : '';
  for (const f of [script, out, done]) rmSync(f, { force: true });
  return text;
}

async function installState() {
  const json = await outside(`
    $k = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '${product} *' } | Select-Object -First 1
    $dir = if ($k) { Split-Path ((($k.UninstallString -split '"')[1])) } else { '' }
    $exe = if ($dir) { Join-Path $dir '${exeName}' } else { '' }
    $ver = if ($exe -and (Test-Path $exe)) { (Get-Item $exe).VersionInfo.ProductVersion } else { '' }
    $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $dir -and $_.ExecutablePath.StartsWith($dir, 'CurrentCultureIgnoreCase') }).Count
    $setup = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*Setup*' -and $_.CommandLine -like '*--updated*' }).Count
    $unpacked = if ($dir) { Test-Path (Join-Path $dir 'resources\\app.asar.unpacked') } else { $false }
    [pscustomobject]@{ dir = $dir; version = $ver; running = $running; setup = $setup; unpacked = $unpacked } | ConvertTo-Json -Compress`);
  // Mid-install the old uninstaller has removed the registry key and the new
  // installer has not written it yet; read that as "not done yet".
  try { return JSON.parse(json.split('\n').pop()); } catch { return { dir: '', version: '', running: 0, setup: 1, unpacked: false }; }
}

// The feed: exactly the files electron-builder wrote, nothing synthesized.
const server = createServer((req, res) => {
  const file = join(FEED, basename(decodeURIComponent(req.url.split('?')[0])));
  if (!existsSync(file) || !statSync(file).isFile()) {
    step(`feed 404 ${req.url}`);
    res.writeHead(404).end();
    return;
  }
  step(`feed 200 ${req.url}`);
  res.writeHead(200, { 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
});

async function cdpEval(expression, timeoutMs = 300_000) {
  const pages = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && /^(?!devtools)[a-z]+:\/\/app\//.test(p.url) && !/widget/.test(p.url));
  if (!page) fail(`no app window over CDP (${pages.map((p) => p.url).join(', ')})`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, ko) => { ws.onopen = ok; ws.onerror = ko; });
  const reply = new Promise((ok, ko) => {
    const timer = setTimeout(() => ko(new Error(`CDP eval timed out: ${expression}`)), timeoutMs);
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { clearTimeout(timer); ok(d); } };
    ws.onclose = () => { clearTimeout(timer); ok({ closed: true }); };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  const d = await reply;
  ws.close();
  if (d.closed) return { closed: true };
  if (d.result?.exceptionDetails) fail(`renderer threw: ${d.result.exceptionDetails.text}`);
  return d.result?.result?.value;
}

let ymlPath = '';
let ymlOriginal = '';
let installRequested = false;
try {
  const before = await installState();
  if (!before.dir) fail(`${product} is not installed for this user`);
  if (before.running) fail(`${product} is running; close it first`);
  step(`installed ${before.version} at ${before.dir}${before.unpacked ? ' (has app.asar.unpacked)' : ''}; feed offers ${target}`);

  ymlPath = join(before.dir, 'resources', 'app-update.yml');
  ymlOriginal = await outside(`Get-Content -Raw -LiteralPath '${ymlPath}'`);
  const cacheDir = /updaterCacheDirName:\s*(\S+)/.exec(ymlOriginal)?.[1];
  const feedConfig = `provider: generic\nurl: http://127.0.0.1:${PORT}/\n${cacheDir ? `updaterCacheDirName: ${cacheDir}\n` : ''}`;
  await outside(`Set-Content -LiteralPath '${ymlPath}' -Value @'\n${feedConfig}'@ -NoNewline -Encoding ascii`);

  await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok));
  step(`feed on http://127.0.0.1:${PORT}/, app-update.yml pointed at it`);

  await outside(`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"${join(before.dir, exeName)}" --remote-debugging-port=${CDP}' } | Out-Null`);
  for (let i = 0; ; i++) {
    try { if ((await (await fetch(`http://127.0.0.1:${CDP}/json`)).json()).some((p) => /:\/\/app\//.test(p.url))) break; } catch { /* not up yet */ }
    if (i > 120) fail('the app did not open a window within 60 s');
    await sleep(500);
  }
  step(`launched ${before.version}`);

  const bridge = '(window.studydeskDesktop || window.nexusDesktop)';
  const check = await cdpEval(`${bridge}.checkForUpdate(true)`);
  step(`check: ${JSON.stringify(check)}`);
  if (check?.status !== 'available' || !check.canInstall || check.latest !== target) fail(`check did not offer an installable ${target}`);

  const downloaded = await cdpEval(`${bridge}.downloadUpdate()`);
  step(`download + verify: ${downloaded}`);
  if (downloaded !== true) fail('download or SHA-512 verification failed (see main.log)');

  await cdpEval(`${bridge}.installUpdate()`, 10_000);
  installRequested = true;
  step('install requested; the app quits and the installer runs silently');

  let after;
  for (let i = 0; ; i++) {
    await sleep(2000);
    after = await installState();
    if (after.version.startsWith(target) && after.running && !after.setup) break;
    if (i > 150) fail(`no relaunched ${target} within 5 min (state ${JSON.stringify(after)})`);
  }
  step(`relaunched ${after.version}${after.unpacked ? ' (app.asar.unpacked still present)' : ', no app.asar.unpacked'}`);
  ymlOriginal = '';
  console.log(`\nDesktop update e2e passed: ${before.version} -> ${after.version} through the installed app's own updater in ${secs().trim()} s.`);
} catch (err) {
  if (!process.exitCode) { console.error(err); process.exitCode = 1; }
} finally {
  server.close();
  // Once the installer has run it owns app-update.yml: a new install writes
  // its own. Put the original back only if the old version is still there.
  if (ymlOriginal && installRequested) {
    await sleep(5000);
    if ((await installState()).version.startsWith(target)) ymlOriginal = '';
  }
  if (ymlOriginal && ymlPath) {
    await outside(`Set-Content -LiteralPath '${ymlPath}' -Value @'\n${ymlOriginal}\n'@ -NoNewline -Encoding ascii`).catch(() => {});
    console.error('  app-update.yml restored.');
  }
}

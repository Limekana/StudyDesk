#!/usr/bin/env node
// Guard against CRLF reaching a release tag. Issue #53.
//
// F-Droid could not build StudyDesk. The reporter's read was "even parts of the
// files have different end-of-lines", and measured against tag v1.12.1 that was
// exactly right: eleven tracked files stored with CRLF, `.gitignore` stored with
// 70 of its 74 lines CRLF.
//
// The one that broke the build was `android/gradlew-quiet`, stored with a CRLF
// shebang. Linux hands the whole first line to the kernel, so `#!/bin/bash\r`
// makes it look for an interpreter literally named `/bin/bash\r` and fail with
// "bad interpreter: No such file or directory". CLAUDE.md documents
// `./gradlew-quiet` as this project's build command.
//
// ── Why this reads the INDEX, not the working tree ──────────────────────────
//
// `.gitattributes` now stores text as LF and checks `.bat` out as CRLF, so a
// Windows working tree legitimately holds CRLF and a Linux one does not. The
// only thing that is the same everywhere — and the only thing a tag actually
// carries — is the stored blob. So that is what gets checked.
//
// A file may hold CRLF on purpose. `.bat` and `.cmd` are mis-parsed by cmd.exe
// with LF endings, so they are stored CRLF deliberately and are exempt here.

import { execFileSync } from 'node:child_process';

const EXEMPT = /\.(bat|cmd)$/i;

// Binary files are skipped by testing the bytes for NUL below rather than by
// asking git: a .jar or .png whose bytes happen to contain 0d 0a is not a
// line-ending problem, and "normalising" one corrupts it. gradle-wrapper.jar
// scans as three CRLF "lines" for exactly this reason.

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const offenders = [];
for (const file of files) {
  if (EXEMPT.test(file)) continue;
  let buf;
  try {
    buf = execFileSync('git', ['show', `HEAD:${file}`], {
      maxBuffer: 64 * 1024 * 1024,
      // A file added but not yet committed is not in HEAD and is not tagged
      // either, so it is not this gate's problem. git says so on stderr; that
      // is expected here, not a failure worth printing.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    continue;
  }
  if (buf.includes(0)) continue; // binary
  const text = buf.toString('utf8');
  const total = text.split('\n').length - 1;
  const crlf = (text.match(/\r\n/g) || []).length;
  if (crlf > 0) offenders.push({ file, crlf, total });
}

if (offenders.length === 0) {
  console.log(`Line-ending check passed: ${files.length} tracked files, no CRLF in any stored text blob.`);
  process.exit(0);
}

console.error(`\nLine-ending check FAILED (${offenders.length} file${offenders.length === 1 ? '' : 's'}):\n`);
for (const { file, crlf, total } of offenders) {
  const partial = crlf < total ? '  <- MIXED, part of the file only' : '';
  console.error(`  ✗ ${file} — ${crlf}/${total} lines CRLF${partial}`);
  if (/gradlew|\.sh$/.test(file)) {
    console.error('    This one is executed. A CRLF shebang makes the kernel look for');
    console.error('    an interpreter with a carriage return in its name, and the build dies.');
  }
}
console.error(`
Fix:  git add --renormalize . && git commit

.gitattributes stores text as LF; these blobs predate it or were committed with
it bypassed. A tag carrying these is a tag F-Droid cannot build — see issue #53.
`);
process.exit(1);

#!/usr/bin/env node
// Fail the build when a hook dependency array names a value that is declared
// LATER in the same component.
//
// Run manually:  node scripts/check-dep-tdz.mjs
// Run in CI:     npm run check:dep-tdz  (part of `npm run lint`)
//
// ── Why ───────────────────────────────────────────────────────────────────
//
// A dependency array is evaluated DURING RENDER, and `const` bindings are in
// their temporal dead zone until their own line executes. So this:
//
//     useEffect(() => { ... }, [courseId]);      // line 133
//     ...
//     const [courseId, setCourseId] = useState('');   // line 247
//
// throws `ReferenceError: Cannot access 'courseId' before initialization` on
// the first render. React unwinds, commits nothing, and the user gets an empty
// `#root` — a blank screen, with no crash and, in a release WebView, no console
// output either.
//
// This has now shipped THREE times:
//
//   v1.10  App.jsx           the account-onboarding effect above `session`
//   v1.13  App.jsx           four notebook effects above `session` (item G)
//   v1.13  TimerView.jsx     `courseId` in the persist effect, ~110 lines
//                            above its useState — opening the Timer tab
//                            blanked the whole app
//
// The response to the first was a comment asking the next author to remember.
// Two more shipped anyway. Nothing else catches it: it is valid JavaScript so
// the build succeeds, no eslint rule models TDZ (react-hooks/exhaustive-deps
// checks WHICH values are listed, not whether they are initialised), and
// `npm run dev` does not reproduce it because unbundled ESM evaluates
// differently from the production chunk.
//
// `scripts/check-boot.mjs` catches these too, but only on screens it actually
// visits — it did not catch the TimerView one, because the timer is behind a
// tab. This check reads every component instead.
//
// ── Scope ─────────────────────────────────────────────────────────────────
//
// Deliberately narrow, because a false positive here blocks the build. It
// flags one thing only: an identifier in a dependency array that the SAME
// COMPONENT later binds with a React hook (`useState`, `useReducer`, `useRef`,
// `useMemo`, `useCallback`). Props, imports and module constants are never
// hook-bound, so they cannot be flagged.
//
// Component scoping is not optional. A first pass compared per FILE and
// immediately false-positived on AnalyticsView.jsx, where `GradeTrend` takes a
// `series` PROP and the separate `AnalyticsView` component further down
// happens to declare a `series` useMemo. Two different bindings, same name, one
// file. Scopes are split on top-level declarations — a `function` or `const`
// at column 0 — which is how every component in this codebase is written.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.jsx'].includes(extname(p))) out.push(p);
  }
  return out;
}

// `const [a, setA] = useState(...)` / `const a = useRef(...)` and friends.
const DESTRUCTURED = /^\s*const\s*\[\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*\s*)?\]\s*=\s*(useState|useReducer)\s*\(/;
const SIMPLE = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(useState|useReducer|useRef|useMemo|useCallback)\s*\(/;

// The closing line of a hook call: `}, [a, b, c]);`
const DEPS_LINE = /^\s*\}\s*,\s*\[([^\]]*)\]\s*\)\s*;?\s*$/;

// A declaration at column 0 — the start of a new top-level scope.
const TOP_LEVEL = /^(?:export\s+default\s+)?(?:export\s+)?(?:async\s+)?(?:function\s+[A-Za-z_$][\w$]*|const\s+[A-Za-z_$][\w$]*\s*=)/;

const failures = [];

for (const file of walk(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const rel = file.slice(ROOT.length + 1);

  // Split into top-level scopes. Anything declared at column 0 starts a new
  // one, which in this codebase means a new component or helper function.
  const scopeStarts = [0];
  lines.forEach((line, i) => {
    if (TOP_LEVEL.test(line)) scopeStarts.push(i);
  });
  const scopeOf = (idx) => {
    let s = 0;
    for (const start of scopeStarts) { if (start <= idx) s = start; else break; }
    return s;
  };

  // Where each hook-bound name is declared, per scope: `${scope}::${name}`.
  const declaredAt = new Map();
  lines.forEach((line, i) => {
    const m = DESTRUCTURED.exec(line) || SIMPLE.exec(line);
    if (!m) return;
    const key = `${scopeOf(i)}::${m[1]}`;
    if (!declaredAt.has(key)) declaredAt.set(key, i + 1);
  });

  lines.forEach((line, i) => {
    const m = DEPS_LINE.exec(line);
    if (!m) return;
    const lineNo = i + 1;
    const scope = scopeOf(i);
    for (const raw of m[1].split(',')) {
      // Only bare identifiers. `a.b`, `a?.current` and literals are not TDZ
      // hazards in the way this checks for, and parsing them properly is not
      // what this narrow check is for.
      const name = raw.trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const declLine = declaredAt.get(`${scope}::${name}`);
      if (declLine && declLine > lineNo) {
        failures.push(
          `${rel}:${lineNo}: dependency array names \`${name}\`, which is declared at line ${declLine}.\n` +
          `    A dependency array is evaluated during render, so this reads \`${name}\` inside its\n` +
          `    temporal dead zone and throws "Cannot access '${name}' before initialization".\n` +
          `    React commits nothing and the screen goes blank.\n` +
          `    Fix: move the declaration above line ${lineNo}.`,
        );
      }
    }
  });
}

if (failures.length) {
  console.error(`\nDependency-array TDZ check failed (${failures.length} ${failures.length === 1 ? 'issue' : 'issues'}):\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(
    'Each of these blanks the app at runtime while the build and eslint stay green.\n' +
    'This exact bug has shipped three times — see the notes at the top of this file.\n',
  );
  process.exitCode = 1;
} else {
  console.log('Dependency-array TDZ check passed: every dependency is declared before the hook that lists it.');
}

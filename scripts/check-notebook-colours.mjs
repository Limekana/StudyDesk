// §8 Trap 1, as a gate.
//
// The design handoff asks for this specifically, and asks for it in this
// place:
//
//   > Gate: `grep -nE '#[0-9a-fA-F]{3,6}|rgba?\(' src/features/notebook
//     src/styles/notebook.css` must return nothing.
//     **Put it in CI, not in review.**
//
// The reasoning is the `phaseColor` incident. One literal hex drove both a
// fill and a stroke, so on the theme where it was wrong the whole element
// vanished rather than one part of it looking off — and it shipped, because a
// colour literal in a component file is invisible to every theme and to every
// reviewer who is not specifically hunting for it. Four things in this design
// would take a literal if nobody stopped them: the highlight swatches, the
// checkbox stroke, the caret, and the margin rule.
//
// Also checks the second of notebook.css's two rules, which the handoff
// states as acceptance check 2: no `[data-theme]` or `[data-mode]` selector
// inside notebook.css. A theme difference belongs in a token value, and a
// selector here means the token set is wrong.
//
// Comments are stripped before scanning. The files under this gate document
// their own token values in prose — the header of notebook.css names
// `--nb-rule: none` and the token tables cite hexes — and a gate that fired
// on its own documentation would be turned off within a week.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TARGETS = ['src/features/notebook', 'src/styles/notebook.css'];

function walk(p, out = []) {
  const abs = join(ROOT, p);
  let st;
  try { st = statSync(abs); } catch { return out; }
  if (st.isDirectory()) {
    for (const entry of readdirSync(abs)) walk(join(p, entry), out);
  } else if (/\.(js|jsx|css)$/.test(p)) {
    out.push(p);
  }
  return out;
}

// Block comments in CSS and JS, plus JS line comments. Replaced with a space
// so nothing is glued together across a stripped comment.
function stripComments(src, isCss) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!isCss) {
    // Line comments only outside strings. A naive strip would eat the `//` in
    // a URL; there are none in this feature, but the guard is cheap and the
    // failure mode of getting it wrong is a false PASS, which is the bad
    // direction for a gate.
    out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
  }
  return out;
}

const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(|\bcolor-mix\s*\(/;
const THEME_SELECTOR = /\[data-(theme|mode)\s*[=\]]/;

let failures = 0;
let scanned = 0;

const files = TARGETS.flatMap((t) => walk(t));

if (!files.length) {
  console.error('check-notebook-colours: no files matched. The gate is not watching anything — check TARGETS.');
  process.exit(1);
}

for (const file of files) {
  const raw = readFileSync(join(ROOT, file), 'utf8');
  const isCss = file.endsWith('.css');
  const body = stripComments(raw, isCss);
  scanned++;

  body.split('\n').forEach((line, i) => {
    if (COLOUR.test(line)) {
      failures++;
      console.error(`${relative('.', file)}:${i + 1}  colour literal — use a --nb-* token`);
      console.error(`    ${line.trim().slice(0, 100)}`);
    }
    if (isCss && THEME_SELECTOR.test(line)) {
      failures++;
      console.error(`${relative('.', file)}:${i + 1}  theme selector in notebook.css — express it as a token value`);
      console.error(`    ${line.trim().slice(0, 100)}`);
    }
  });
}

console.log(`notebook colour gate: ${scanned} file(s) scanned.`);

if (failures) {
  console.error(`\n${failures} violation(s). See §8 Trap 1 in the design handoff — and the phaseColor incident it names.`);
  process.exit(1);
}
console.log('No colour literals and no theme selectors in the notebook feature.');

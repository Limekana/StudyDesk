// Chemistry: element tokenising, and the balance tally that goes in the
// margin gutter.
//
// §11 calls this "small and self-contained… worth building rather than
// buying — the tally is the differentiating half and no library does it."
// That is the right read. Rendering `H2O` as H₂O is a nice touch; telling a
// student that their equation has 4 hydrogens on the left and 6 on the right
// is the thing they are actually trying to find out at 11pm.
//
// The gutter already exists to hold list markers, so the tally costs no
// layout (§11 design move 2). It is stacked — symbol over `have·need` — at
// 8.5px because the phone gutter is only ~20px wide and an inline `Mn 1·1`
// measures 30px. Widening the gutter when a chem line is active was rejected:
// it reflows the text column as the caret enters, and a page that shifts
// under you while you type is worse than a small tally.
//
// Pure. No DOM. Every function here is assertable, which matters because
// "the tally is wrong" is a worse failure than "the tally is missing".

// Two-letter symbols must be tried before one-letter ones or `Co` (cobalt)
// tokenises as C+o and `Cl` as C+l. The full table is not needed — only the
// ambiguity is — but a partial list would mis-tokenise whatever it omits, so
// this is complete for the 118 named elements.
const ELEMENTS = new Set([
  'H','He','Li','Be','B','C','N','O','F','Ne','Na','Mg','Al','Si','P','S','Cl','Ar',
  'K','Ca','Sc','Ti','V','Cr','Mn','Fe','Co','Ni','Cu','Zn','Ga','Ge','As','Se','Br','Kr',
  'Rb','Sr','Y','Zr','Nb','Mo','Tc','Ru','Rh','Pd','Ag','Cd','In','Sn','Sb','Te','I','Xe',
  'Cs','Ba','La','Ce','Pr','Nd','Pm','Sm','Eu','Gd','Tb','Dy','Ho','Er','Tm','Yb','Lu',
  'Hf','Ta','W','Re','Os','Ir','Pt','Au','Hg','Tl','Pb','Bi','Po','At','Rn',
  'Fr','Ra','Ac','Th','Pa','U','Np','Pu','Am','Cm','Bk','Cf','Es','Fm','Md','No','Lr',
  'Rf','Db','Sg','Bh','Hs','Mt','Ds','Rg','Cn','Nh','Fl','Mc','Lv','Ts','Og',
]);

// State labels are never subscripted (§11). They look exactly like a formula
// in parentheses, so they are matched first and passed through as roman.
const STATES = new Set(['aq', 's', 'g', 'l']);

const SUB = { 0:'₀',1:'₁',2:'₂',3:'₃',4:'₄',5:'₅',6:'₆',7:'₇',8:'₈',9:'₉' };
const SUP = { 0:'⁰',1:'¹',2:'²',3:'³',4:'⁴',5:'⁵',6:'⁶',7:'⁷',8:'⁸',9:'⁹','+':'⁺','-':'⁻' };

export function toSubscript(digits) {
  return String(digits).split('').map((c) => SUB[c] ?? c).join('');
}
export function toSuperscript(chars) {
  return String(chars).split('').map((c) => SUP[c] ?? c).join('');
}

/**
 * Tokenise one chemical species (no coefficients, no arrows).
 *
 * @returns {null | Array<{kind, text}>}  null when the input is not chemistry
 *
 * Returning null rather than a best effort is the point: `In` is indium and
 * also the English word "in", and a tokeniser that renders every sentence
 * containing "In" as a chemical formula is worse than one that renders
 * nothing. The caller only reaches this for text already inside a `$$…$$`
 * chem span, so ambiguity is resolved by the user's own delimiter.
 */
export function tokeniseSpecies(input) {
  const src = String(input ?? '').trim();
  if (!src) return null;

  const out = [];
  let i = 0;

  while (i < src.length) {
    // State label — `(aq)`, `(s)`, `(g)`, `(l)`.
    const state = /^\(([a-z]{1,2})\)/.exec(src.slice(i));
    if (state && STATES.has(state[1])) {
      out.push({ kind: 'state', text: state[0] });
      i += state[0].length;
      continue;
    }

    // A group: `(SO4)3`, `[Cu(NH3)4]2+`. Recursion handles the inside; the
    // multiplier after the bracket subscripts like any other count.
    const open = src[i];
    if (open === '(' || open === '[') {
      const close = open === '(' ? ')' : ']';
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === open) depth++;
        else if (src[j] === close) { depth--; if (depth === 0) break; }
      }
      if (j >= src.length) return null; // unbalanced — not chemistry
      const innerSrc = src.slice(i + 1, j);
      const inner = tokeniseSpecies(innerSrc);
      if (!inner) return null;
      out.push({ kind: 'open', text: open });
      out.push(...inner);
      out.push({ kind: 'close', text: close });
      i = j + 1;
      const mult = /^(\d+)/.exec(src.slice(i));
      if (mult) {
        out.push({ kind: 'count', text: toSubscript(mult[1]), value: Number(mult[1]) });
        i += mult[1].length;
      }
      continue;
    }

    // Trailing charge: `2+`, `+`, `3-`. Only valid at the very end.
    const charge = /^(\d*)([+-])$/.exec(src.slice(i));
    if (charge) {
      out.push({
        kind: 'charge',
        text: toSuperscript(`${charge[1]}${charge[2]}`),
        value: (charge[1] ? Number(charge[1]) : 1) * (charge[2] === '+' ? 1 : -1),
      });
      i = src.length;
      continue;
    }

    // `^` forces a superscript, per §11 — `SO4^2-`.
    if (src[i] === '^') {
      const forced = /^\^(\d*[+-]?)/.exec(src.slice(i));
      if (!forced || !forced[1]) return null;
      const sign = /[+-]$/.exec(forced[1]);
      const mag = forced[1].replace(/[+-]$/, '');
      out.push({
        kind: 'charge',
        text: toSuperscript(forced[1]),
        value: sign ? (mag ? Number(mag) : 1) * (sign[0] === '+' ? 1 : -1) : 0,
      });
      i += forced[0].length;
      continue;
    }

    // An element symbol: two letters then one, never the other way round.
    const two = src.slice(i, i + 2);
    const one = src.slice(i, i + 1);
    let sym = null;
    if (two.length === 2 && ELEMENTS.has(two)) sym = two;
    else if (ELEMENTS.has(one)) sym = one;
    if (!sym) return null;

    out.push({ kind: 'element', text: sym });
    i += sym.length;

    // Digits after a symbol are a SUBSCRIPT — unless a sign follows them at
    // the very end, in which case they are the magnitude of a CHARGE.
    //
    // §11's own table settles this: `Mn2+` renders as Mn²⁺, one manganese ion
    // with a 2+ charge, not two manganese atoms with a stray plus. Taking the
    // digits greedily as a count read `Fe2+` as two iron atoms and then
    // tallied a +1 charge, which is wrong twice over and silently — the
    // equation would simply refuse to balance and the student would go looking
    // for their own mistake.
    const trailingCharge = /^(\d+)([+-])$/.exec(src.slice(i));
    if (trailingCharge) {
      out.push({
        kind: 'charge',
        text: toSuperscript(`${trailingCharge[1]}${trailingCharge[2]}`),
        value: Number(trailingCharge[1]) * (trailingCharge[2] === '+' ? 1 : -1),
      });
      i = src.length;
      continue;
    }

    const count = /^(\d+)/.exec(src.slice(i));
    if (count) {
      out.push({ kind: 'count', text: toSubscript(count[1]), value: Number(count[1]) });
      i += count[1].length;
    }
    continue;
  }

  return out.length ? out : null;
}

/**
 * Atom counts and total charge for one species, times a coefficient.
 *
 * Walks the token list with a multiplier stack so `Ca(OH)2` counts 2 oxygen
 * and 2 hydrogen rather than 1 and 1 — group multipliers are exactly where a
 * hand-counted tally goes wrong, which is why the feature earns its place.
 */
export function countSpecies(tokens, coefficient = 1) {
  const atoms = new Map();
  let charge = 0;

  // Each open bracket pushes a frame; its multiplier applies on close.
  const stack = [];
  let frame = new Map();

  const add = (target, sym, n) => target.set(sym, (target.get(sym) || 0) + n);

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.kind === 'open') {
      stack.push(frame);
      frame = new Map();
      continue;
    }
    if (tk.kind === 'close') {
      const mult = tokens[i + 1]?.kind === 'count' ? tokens[i + 1].value : 1;
      const parent = stack.pop() || new Map();
      for (const [sym, n] of frame) add(parent, sym, n * mult);
      frame = parent;
      if (tokens[i + 1]?.kind === 'count') i++;
      continue;
    }
    if (tk.kind === 'element') {
      const n = tokens[i + 1]?.kind === 'count' ? tokens[i + 1].value : 1;
      add(frame, tk.text, n);
      if (tokens[i + 1]?.kind === 'count') i++;
      continue;
    }
    if (tk.kind === 'charge') charge += tk.value || 0;
  }

  // Unwind anything left open. Only reachable on malformed input, which
  // `tokeniseSpecies` already rejects — belt and braces so a future caller
  // cannot produce a silently short count.
  while (stack.length) {
    const parent = stack.pop();
    for (const [sym, n] of frame) add(parent, sym, n);
    frame = parent;
  }

  for (const [sym, n] of frame) add(atoms, sym, n * coefficient);
  return { atoms, charge: charge * coefficient };
}

/**
 * Parse a full equation: `2H2 + O2 -> 2H2O`.
 *
 * @returns {null | {sides, arrow, tally}}
 *
 * `tally` is what the gutter draws: one row per element that appears
 * anywhere, with left and right counts and whether they match. Charge is a
 * row too — an equation can balance its atoms and not its charge, and in
 * redox that is the whole exercise.
 */
export function parseEquation(input) {
  const src = String(input ?? '').trim();
  if (!src) return null;

  // `<->` before `->`, longest first, same rule as everywhere else here.
  const arrowMatch = /(<->|<=>|->|=>)/.exec(src);
  if (!arrowMatch) return null;

  const arrow = arrowMatch[1] === '->' || arrowMatch[1] === '=>' ? '→' : '⇌';
  const left = src.slice(0, arrowMatch.index);
  const right = src.slice(arrowMatch.index + arrowMatch[1].length);

  const parseSide = (side) => {
    // Split on a SPACED plus, not a bare one. `+` is both the species
    // separator and the sign of a positive charge, and splitting on the bare
    // character tore `Fe2+ + Ag+` into `Fe2`, `Ag` and two empties — so every
    // ionic equation lost its charges and then failed to balance for reasons
    // the student could not see.
    //
    // The whitespace is what disambiguates, and it is not a convention this
    // invents: a charge is written tight to its symbol (`Fe2+`) and a
    // separator is written with spaces around it (`A + B`), in every textbook
    // and every exam paper. A user who writes `H2+O2` without spaces gets a
    // single unparseable species and keeps their literal source, which is the
    // documented error state rather than a wrong tally.
    const parts = side.split(/\s\+\s|\s\+$|^\+\s/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const species = [];
    for (const part of parts) {
      // A leading coefficient stays full-size (§11). It is not a subscript
      // and rendering it as one would change what the equation says.
      const co = /^(\d+)\s*(.+)$/.exec(part);
      const coefficient = co ? Number(co[1]) : 1;
      const body = co ? co[2] : part;
      const tokens = tokeniseSpecies(body);
      if (!tokens) return null;
      species.push({ coefficient, tokens, source: part });
    }
    return species;
  };

  const leftSide = parseSide(left);
  const rightSide = parseSide(right);
  if (!leftSide || !rightSide) return null;

  const sum = (side) => {
    const atoms = new Map();
    let charge = 0;
    for (const sp of side) {
      const c = countSpecies(sp.tokens, sp.coefficient);
      for (const [sym, n] of c.atoms) atoms.set(sym, (atoms.get(sym) || 0) + n);
      charge += c.charge;
    }
    return { atoms, charge };
  };

  const l = sum(leftSide);
  const r = sum(rightSide);

  // Stable order: the sequence elements first appear on the left, then
  // anything that only appears on the right. Sorting alphabetically would
  // reorder the tally as the user types, which is exactly the kind of motion
  // §11 rejects for the gutter.
  const order = [];
  for (const sym of l.atoms.keys()) if (!order.includes(sym)) order.push(sym);
  for (const sym of r.atoms.keys()) if (!order.includes(sym)) order.push(sym);

  const tally = order.map((sym) => ({
    symbol: sym,
    have: l.atoms.get(sym) || 0,
    need: r.atoms.get(sym) || 0,
    ok: (l.atoms.get(sym) || 0) === (r.atoms.get(sym) || 0),
  }));

  if (l.charge !== 0 || r.charge !== 0) {
    tally.push({ symbol: 'q', have: l.charge, need: r.charge, ok: l.charge === r.charge, isCharge: true });
  }

  return {
    sides: { left: leftSide, right: rightSide },
    arrow,
    tally,
    balanced: tally.every((row) => row.ok),
  };
}

/**
 * The one entry point the renderer calls.
 *
 * Tries a full equation, then a single species. Returns null when it is
 * neither — and null means the caller keeps the literal source visible in
 * `--nb-src`, per §11's error contract: "A span that fails to parse stays as
 * its literal source and never discards what you typed. That is the entire
 * error state. No red squiggle, no modal, no validation message."
 */
export function renderChem(input) {
  const eq = parseEquation(input);
  if (eq) return { kind: 'equation', ...eq };

  const tokens = tokeniseSpecies(input);
  if (tokens) return { kind: 'species', tokens, tally: [] };

  return null;
}

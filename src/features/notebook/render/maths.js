// Maths: a deliberately small LaTeX-shaped subset.
//
// §11 is blunt about the risk here: "The largest piece, and the one to buy
// rather than write: a LaTeX-subset renderer. **Constrain the subset at the
// parser, not in documentation**, or it grows into the out-of-scope list on
// its own."
//
// So it is constrained at the parser. `COMMANDS` below is an allow-list. A
// command that is not in it does not render — it is not "unsupported for
// now", it is not in the grammar, and adding one is an edit to this file with
// whatever review that deserves. That is the mechanism §11 asks for, and it
// is the only thing standing between "revision notes" and "someone asks for
// `\begin{align}` and it seems rude to say no".
//
// ── Why not buy one ──────────────────────────────────────────────────────
// §11 says buy, and for a general renderer that is right. It is not right
// here, for reasons specific to this app rather than to maths:
//
//   * KaTeX is ~280 kB of JS plus its own font files. This bundle is already
//     shipping a 795 kB chunk and gets flagged by the build; the app is
//     offline-first on F-Droid, where every byte is downloaded over whatever
//     connection a student has.
//   * A general renderer accepts the whole language, which is precisely what
//     §11 says not to allow. Constraining KaTeX back down to this subset
//     means writing a validating parser anyway — and then shipping both.
//   * The output here is Unicode text set in the note's own font, so it sits
//     on the 28px baseline grid with everything else and inherits all five
//     themes for free. A renderer with its own fonts and its own line boxes
//     is the one thing guaranteed to break the ruling alignment that §1 and
//     acceptance check 3 exist to protect.
//
// The honest cost: no radicals with real overbars, no integral limits set
// above and below the sign, no multi-line derivations. All three are out of
// scope in §11 anyway. If that changes, this file is the place the decision
// gets made rather than a config flag somewhere.
//
// Pure, total, and null-returning. Null means the caller keeps the literal
// source visible — §11's entire error state.

const SUP = {
  0:'⁰',1:'¹',2:'²',3:'³',4:'⁴',5:'⁵',6:'⁶',7:'⁷',8:'⁸',9:'⁹',
  '+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ','x':'ˣ','a':'ᵃ','b':'ᵇ','c':'ᶜ',
  'd':'ᵈ','e':'ᵉ','f':'ᶠ','g':'ᵍ','h':'ʰ','j':'ʲ','k':'ᵏ','l':'ˡ','m':'ᵐ','o':'ᵒ',
  'p':'ᵖ','r':'ʳ','s':'ˢ','t':'ᵗ','u':'ᵘ','v':'ᵛ','w':'ʷ','y':'ʸ','z':'ᶻ',
};
const SUB = {
  0:'₀',1:'₁',2:'₂',3:'₃',4:'₄',5:'₅',6:'₆',7:'₇',8:'₈',9:'₉',
  '+':'₊','-':'₋','=':'₌','(':'₍',')':'₎',
  'a':'ₐ','e':'ₑ','h':'ₕ','i':'ᵢ','j':'ⱼ','k':'ₖ','l':'ₗ','m':'ₘ','n':'ₙ','o':'ₒ',
  'p':'ₚ','r':'ᵣ','s':'ₛ','t':'ₜ','u':'ᵤ','v':'ᵥ','x':'ₓ',
};

// The allow-list. Greek by name plus the operator subset §11 names:
// "integrals, roots, sums, limits, trig, logs".
const COMMANDS = {
  // Greek — lower
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', zeta:'ζ', eta:'η',
  theta:'θ', iota:'ι', kappa:'κ', lambda:'λ', mu:'μ', nu:'ν', xi:'ξ', pi:'π',
  rho:'ρ', sigma:'σ', tau:'τ', upsilon:'υ', phi:'φ', chi:'χ', psi:'ψ', omega:'ω',
  // Greek — upper
  Gamma:'Γ', Delta:'Δ', Theta:'Θ', Lambda:'Λ', Xi:'Ξ', Pi:'Π', Sigma:'Σ',
  Upsilon:'Υ', Phi:'Φ', Psi:'Ψ', Omega:'Ω',
  // Operators and relations
  int:'∫', iint:'∬', oint:'∮', sum:'∑', prod:'∏', sqrt:'√', cbrt:'∛',
  infty:'∞', partial:'∂', nabla:'∇', pm:'±', mp:'∓', times:'×', cdot:'·',
  div:'÷', neq:'≠', leq:'≤', geq:'≥', approx:'≈', equiv:'≡', propto:'∝',
  to:'→', gets:'←', iff:'⇔', implies:'⇒', in:'∈', notin:'∉', subset:'⊂',
  cup:'∪', cap:'∩', forall:'∀', exists:'∃', therefore:'∴', because:'∵',
  angle:'∠', degree:'°', perp:'⊥', parallel:'∥', ldots:'…', cdots:'⋯',
  // Named functions — set roman, which is what distinguishes sin(x) from s·i·n·x
  sin:'sin', cos:'cos', tan:'tan', sec:'sec', csc:'csc', cot:'cot',
  arcsin:'arcsin', arccos:'arccos', arctan:'arctan',
  sinh:'sinh', cosh:'cosh', tanh:'tanh',
  log:'log', ln:'ln', lg:'lg', exp:'exp', lim:'lim', max:'max', min:'min',
  det:'det', dim:'dim', ker:'ker', deg:'deg', gcd:'gcd', mod:'mod',
};

// Commands that take one braced argument.
const UNARY = new Set(['sqrt', 'cbrt', 'overline', 'vec', 'hat', 'bar']);
// Commands that take two.
const BINARY = new Set(['frac', 'tfrac', 'dfrac', 'binom']);

function mapAll(str, table) {
  const out = [];
  for (const ch of String(str)) {
    const m = table[ch];
    if (!m) return null; // one unmappable character fails the whole run
    out.push(m);
  }
  return out.join('');
}

// Read a `{...}` group, or a single character if there are no braces —
// `x^2` and `x^{n+1}` are both valid, per §11.
function readArg(src, i) {
  if (src[i] === '{') {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) return { body: src.slice(i + 1, j), next: j + 1 };
      }
    }
    return null; // unbalanced
  }
  if (i < src.length) return { body: src[i], next: i + 1 };
  return null;
}

/**
 * Parse a maths span into a node list.
 *
 * @returns {null | Array<node>}
 *   node = {t:'text',v} | {t:'sup'|'sub',v} | {t:'frac',num,den} | {t:'root',body}
 *
 * Fractions and roots stay STRUCTURED rather than being flattened to
 * characters, because §11 asks for "a stacked fraction rendered with a real
 * rule, on the 28px baseline" — the renderer draws those; everything else is
 * Unicode text.
 */
export function parseMaths(input) {
  const src = String(input ?? '');
  if (!src.trim()) return null;

  const nodes = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\') {
      const cmd = /^\\([A-Za-z]+)/.exec(src.slice(i));
      // A backslash not followed by an allow-listed name fails the span. The
      // alternative — dropping it silently — would render `\foo{x}` as `x`
      // and quietly change what a note says.
      if (!cmd) return null;
      const name = cmd[1];
      i += cmd[0].length;

      if (BINARY.has(name)) {
        const a = readArg(src, i); if (!a) return null;
        const b = readArg(src, a.next); if (!b) return null;
        const num = parseMaths(a.body);
        const den = parseMaths(b.body);
        if (!num || !den) return null;
        flush();
        nodes.push({ t: name === 'binom' ? 'binom' : 'frac', num, den });
        i = b.next;
        continue;
      }

      if (UNARY.has(name)) {
        const a = readArg(src, i); if (!a) return null;
        const body = parseMaths(a.body);
        if (!body) return null;
        flush();
        nodes.push({ t: name === 'sqrt' || name === 'cbrt' ? 'root' : 'accent', kind: name, body });
        i = a.next;
        continue;
      }

      const glyph = COMMANDS[name];
      if (!glyph) return null; // NOT in the grammar. This is the constraint.
      // A named function needs a hair of space after it so `\sin x` does not
      // read as one identifier.
      // U+2009 THIN SPACE, written as an escape rather than as the literal
      // character: a bare thin space in source is invisible in every diff and
      // every editor, and eslint's no-irregular-whitespace is right to refuse
      // it. The space itself is deliberate — `\sin x` must not read as one
      // identifier — so it is kept and made visible.
      buf += /^[a-z]{2,}$/.test(glyph) ? `${glyph}\u2009` : glyph;
      continue;
    }

    if (ch === '^' || ch === '_') {
      const a = readArg(src, i + 1);
      if (!a) return null;
      const mapped = mapAll(a.body, ch === '^' ? SUP : SUB);
      // A character with no Unicode super/subscript form fails the span
      // rather than being silently dropped or left inline — `x^{α}` has no
      // honest rendering here and pretending otherwise loses information.
      if (mapped == null) return null;
      buf += mapped;
      i = a.next;
      continue;
    }

    // Braces outside a command are grouping and carry no meaning of their own.
    if (ch === '{' || ch === '}') { i++; continue; }

    buf += ch;
    i++;
  }

  flush();
  return nodes.length ? nodes : null;
}

/** True when the whole span reduces to plain characters — lets the renderer
 *  skip the structured path for the common `x^2 + \alpha` case. */
export function isFlat(nodes) {
  return Array.isArray(nodes) && nodes.every((n) => n.t === 'text');
}

/** Flatten to a string. Only valid when `isFlat`; used for accessible labels
 *  and for the tree excerpt. */
export function flatten(nodes) {
  if (!Array.isArray(nodes)) return '';
  return nodes.map((n) => {
    if (n.t === 'text') return n.v;
    if (n.t === 'frac' || n.t === 'binom') return `(${flatten(n.num)}/${flatten(n.den)})`;
    if (n.t === 'root') return `√(${flatten(n.body)})`;
    if (n.t === 'accent') return flatten(n.body);
    return '';
  }).join('');
}

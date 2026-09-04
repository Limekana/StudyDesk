// Inline marks: bold, italic, underline, highlight — and nothing else.
//
// Returns a TOKEN LIST, never an HTML string. Two reasons, and the first is
// not negotiable:
//
//   1. **Nothing here may produce markup that reaches `dangerouslySetInnerHTML`.**
//      The content is user-typed and, once a note syncs, it has crossed a
//      network. Building an HTML string is how an editor grows an XSS hole.
//      React renders these tokens as elements; a `<` a student typed in a
//      chemistry note stays a `<`.
//   2. §11 needs the same token stream for maths, chemistry and diagrams, and
//      a string would have to be re-parsed to get it back.
//
// ── Trap 2, and why the format cannot violate it ─────────────────────────
//
// A highlight is stored as its ROLE:
//
//     ==text==        role 1  (mark / important)
//     =2=text=2=      role 2  (query / unsure)
//     =3=text=3=      role 3  (settled / confirmed)
//
// There is no syntax for a colour. Not "we choose not to write one" — the
// grammar has no production for it. §8 calls a stored hex "the one decision
// here that is unrecoverable later", because it strands a light-mode yellow
// on a black page forever. A format that cannot express a hex cannot lose
// that argument later, to anyone, including us.
//
// Roles 2 and 3 are toolbar long-press only on mobile and have no shortcut,
// per §5 — three chords for three colours is more than this earns. The syntax
// exists so a note typed on desktop round-trips, not as a documented feature.

/** Mark names. `hl` carries a role number; the others carry nothing. */
export const MARK = {
  BOLD: 'b',
  ITALIC: 'i',
  UNDERLINE: 'u',
  HL: 'hl',
};

// Ordered longest-delimiter-first. `**` has to be tried before `*`, and
// `=2=` before `==`, or the shorter rule eats the opening of the longer one.
//
// Every pattern requires a non-empty body: `****` is four asterisks somebody
// typed, not two empty bolds, and a maths note contains runs of asterisks
// often enough that this matters.
const RULES = [
  { re: /\*\*([\s\S]+?)\*\*/g, mark: MARK.BOLD },
  { re: /__([\s\S]+?)__/g, mark: MARK.UNDERLINE },
  { re: /=([23])=([\s\S]+?)=\1=/g, mark: MARK.HL, roleFrom: 1, bodyAt: 2 },
  { re: /==([\s\S]+?)==/g, mark: MARK.HL, role: 1 },
  // The two single-character delimiters need a guard the regex cannot carry.
  // `****` is four asterisks somebody typed — a maths note produces runs of
  // them — and without `solo` the italic rule matched `***` with a body of
  // `*`, rendering four literal asterisks as an italic one followed by a
  // stray. Lookbehind would express it more tidily and is deliberately
  // avoided: this ships to Android WebViews whose version we do not control,
  // and a regex that throws at PARSE time takes the whole module with it,
  // which would be a blank app rather than a mis-rendered line.
  { re: /\*([\s\S]+?)\*/g, mark: MARK.ITALIC, solo: '*' },
  { re: /_([\s\S]+?)_/g, mark: MARK.ITALIC, solo: '_' },
];

// A single-delimiter match is only real when it is not part of a longer run
// of the same character — neither side of the match, nor either end of the
// body, may be that character.
function soloOk(rule, src, m) {
  if (!rule.solo) return true;
  const d = rule.solo;
  const body = m[1];
  if (body.startsWith(d) || body.endsWith(d)) return false;
  if (src[m.index - 1] === d) return false;
  if (src[m.index + m[0].length] === d) return false;
  return true;
}

/**
 * Text → tokens.
 *
 * @returns {Array<{text: string, marks: string[], role?: number}>}
 *
 * Marks nest, so `**bold with *italic* inside**` yields three tokens and the
 * middle one carries both. Implemented by recursion on the body rather than a
 * stack machine: the nesting depth here is bounded by how many distinct marks
 * exist (four), so the simple version cannot run away.
 */
export function renderInline(text, marks = []) {
  const src = String(text ?? '');
  if (!src) return [];

  // Earliest VALID match wins, so the marks a reader sees follow the order
  // they were typed rather than the order this array happens to list. Each
  // rule is scanned rather than probed once, because a rejected solo match
  // must not stop a later real one on the same line: in `**a** *b*` the
  // italic rule's first hit is inside the bold run and has to be skipped.
  let best = null;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      if (!soloOk(rule, src, m)) {
        // Advance by one so a rejected match cannot loop forever on a
        // zero-width-ish result, and so the next candidate starts inside the
        // run rather than at the same index.
        rule.re.lastIndex = m.index + 1;
        continue;
      }
      if (!best || m.index < best.m.index) best = { m, rule };
      break;
    }
  }

  if (!best) return [{ text: src, marks }];

  const { m, rule } = best;
  const body = rule.bodyAt ? m[rule.bodyAt] : m[1];
  const role = rule.roleFrom ? Number(m[rule.roleFrom]) : rule.role;

  const before = src.slice(0, m.index);
  const after = src.slice(m.index + m[0].length);

  const nextMarks = marks.includes(rule.mark) ? marks : [...marks, rule.mark];
  const inner = renderInline(body, nextMarks).map((tok) => (
    rule.mark === MARK.HL ? { ...tok, role: tok.role ?? role } : tok
  ));

  return [
    ...(before ? renderInline(before, marks) : []),
    ...inner,
    ...(after ? renderInline(after, marks) : []),
  ];
}

/** Strip every inline mark. Used for the tree excerpt and for search. */
export function plainText(text) {
  return renderInline(text).map((t) => t.text).join('');
}

// ── Applying a mark to a selection ────────────────────────────────────────
//
// Operates on the SOURCE string and a selection range, because that is what
// the focused block actually is — a textarea. Returns the new source and
// where the selection should land, so the caret does not jump to the end of
// the line every time somebody presses Ctrl+B.

const DELIMS = {
  [MARK.BOLD]: ['**', '**'],
  [MARK.ITALIC]: ['*', '*'],
  [MARK.UNDERLINE]: ['__', '__'],
};

function delimsFor(mark, role = 1) {
  if (mark === MARK.HL) return role === 1 ? ['==', '=='] : [`=${role}=`, `=${role}=`];
  return DELIMS[mark] || ['', ''];
}

/**
 * Toggle a mark over `[start, end)` of `source`.
 *
 * Toggling OFF is the half that is usually skipped and is the half people
 * notice: pressing Ctrl+B twice must give back what you started with, not
 * `****text****`. Detected by looking just outside the selection for the
 * delimiters, which is where they are when the user selected the word rather
 * than the word-plus-markers.
 */
export function toggleMark(source, start, end, mark, role = 1) {
  const src = String(source ?? '');
  const [open, close] = delimsFor(mark, role);
  if (!open) return { source: src, start, end };

  const selected = src.slice(start, end);

  // Already wrapped, markers OUTSIDE the selection.
  const outerBefore = src.slice(Math.max(0, start - open.length), start);
  const outerAfter = src.slice(end, end + close.length);
  if (outerBefore === open && outerAfter === close) {
    const next = src.slice(0, start - open.length) + selected + src.slice(end + close.length);
    return { source: next, start: start - open.length, end: end - open.length };
  }

  // Already wrapped, markers INSIDE the selection.
  if (selected.startsWith(open) && selected.endsWith(close) && selected.length > open.length + close.length) {
    const bare = selected.slice(open.length, selected.length - close.length);
    const next = src.slice(0, start) + bare + src.slice(end);
    return { source: next, start, end: start + bare.length };
  }

  // Nothing selected: insert the pair and put the caret between them, so the
  // shortcut is usable BEFORE typing rather than only after.
  if (start === end) {
    const next = src.slice(0, start) + open + close + src.slice(end);
    return { source: next, start: start + open.length, end: start + open.length };
  }

  const next = src.slice(0, start) + open + selected + close + src.slice(end);
  return { source: next, start: start + open.length, end: end + open.length };
}

/**
 * Strip every inline mark from a selection — `Ctrl+\` in §5.
 *
 * Character formats only. The block type is deliberately untouched: "clear
 * formatting" on a checklist item should not silently turn it into a
 * paragraph and lose the checkbox.
 */
export function clearMarks(source, start, end) {
  const src = String(source ?? '');
  const selected = src.slice(start, end);
  if (!selected) return { source: src, start, end };
  const bare = plainText(selected);
  return { source: src.slice(0, start) + bare + src.slice(end), start, end: start + bare.length };
}

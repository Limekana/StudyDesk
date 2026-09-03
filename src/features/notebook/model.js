// The notebook document model.
//
// ── The one architectural decision, stated up front ──────────────────────
//
// **A note is markdown source. Every line renders except the one the caret is
// in.** Block-level live preview, not a WYSIWYG document tree.
//
// The handoff asks for reveal-on-caret-entry at SPAN level: "a rendered span
// reverts to its source when the caret enters it and re-renders on exit."
// This implements the same contract one level coarser — the whole BLOCK
// reveals, not the individual formula inside it. That is a deliberate
// deviation, and it is worth being explicit about why, because the handoff
// names the thing it protects against:
//
//   > "Riskiest: THE CARET. Reveal-on-enter must survive an Android IME's
//      composition and autocorrect state. Prototype that one interaction on a
//      real device before committing to the rest."
//
// Span-level reveal means rewriting the DOM *inside the element the user is
// typing into*, while an IME may be holding an open composition over a range
// of that same text. Gboard and Samsung's keyboard both keep composing
// regions across several characters, and replacing nodes under an active
// composition is how editors get dropped characters, a caret that jumps to
// position 0, and autocorrect that silently reverts a word. There is no
// device in this environment to prototype on, which is exactly the condition
// under which the handoff says not to commit to it.
//
// Block-level reveal removes the hazard rather than managing it: the focused
// block is a plain `<textarea>` holding literal source, and NOTHING rewrites
// it while it has focus. Rendering only ever happens to blocks the caret is
// not in. The IME gets an ordinary text field, which is the one thing every
// IME is guaranteed to handle correctly.
//
// It also costs less than it looks. §11's own principle is "everything on
// this page is text that renders", the mobile path in §5 is markdown input
// rules rather than chords, and the reveal is still one tap away on exactly
// the line you want to edit. What is lost is seeing a rendered fraction on
// the line you are currently typing — and on a phone, that line is behind the
// keyboard about as often as not.
//
// If a device prototype later shows span-level reveal is safe, this model is
// the right base to build it on: blocks already carry their source, and
// `renderInline` already returns a token list rather than a string.
//
// ── Storage ──────────────────────────────────────────────────────────────
//
// `notebook_entries.content` holds the SOURCE, verbatim, as one string. Not a
// serialised block tree. Three reasons, in order of how much they matter:
//
//   1. **A highlight is stored as its role, never a hex** (§8 Trap 2). In
//      source that is `==text==` / `=2=text=2=` — a role name, structurally
//      incapable of carrying a colour. The handoff calls a stored hex "the one
//      decision here that is unrecoverable later"; this format cannot express
//      one.
//   2. Nothing can corrupt into an unopenable note. A parse that fails yields
//      a paragraph containing the literal characters the user typed, which is
//      the same escape hatch §11 specifies for a bad formula, applied to the
//      whole document.
//   3. It is diffable, greppable, and exportable as-is. `downloadExport`
//      already ships JSON; a note inside it is readable text rather than an
//      opaque tree.

/** Block types. Two heading levels and no more, per §9. */
export const BLOCK = {
  P: 'p',
  H1: 'h1',
  H2: 'h2',
  BULLET: 'bullet',
  NUMBER: 'number',
  CHECK: 'check',
  PHOTO: 'photo',
};

/** Nesting is capped at two levels — the same cap the tree diagram uses. */
export const MAX_INDENT = 1;

// A photo is a line of its own: `![assetId]` plus an optional caption. Written
// by the import flow, never typed, but it lives in the same source stream so
// that one string is genuinely the whole note.
const PHOTO_RE = /^!\[([A-Za-z0-9._/-]+)\](?:\s+(.*))?$/;

// Leading indentation is TABS, one per level. Spaces would collide with the
// `- ` and `1. ` markers the input rules key on, and a note typed on a phone
// picks up stray spaces constantly.
function splitIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === '\t') i++;
  return { indent: Math.min(i, MAX_INDENT), rest: line.slice(i) };
}

/**
 * Source string → blocks.
 *
 * Total: every line becomes exactly one block, so a round trip through
 * `serialize` is lossless for anything this app produced and merely
 * uninterpreted for anything it did not. There is no error path because there
 * is no such thing as an unparseable note.
 */
export function parse(source) {
  const lines = String(source ?? '').split('\n');
  return lines.map((line, i) => {
    const { indent, rest } = splitIndent(line);

    const photo = PHOTO_RE.exec(rest);
    if (photo) {
      return { id: i, type: BLOCK.PHOTO, indent: 0, asset: photo[1], text: photo[2] || '', checked: false };
    }
    if (rest.startsWith('## ')) {
      return { id: i, type: BLOCK.H2, indent: 0, text: rest.slice(3), checked: false };
    }
    if (rest.startsWith('# ')) {
      return { id: i, type: BLOCK.H1, indent: 0, text: rest.slice(2), checked: false };
    }
    // `[x] ` before the bullet check: `- [ ] foo` is a checklist item in every
    // editor people have used, and treating it as a bullet whose text happens
    // to start with a bracket would be technically defensible and wrong.
    const check = /^(?:- )?\[([ xX]?)\] ?(.*)$/.exec(rest);
    if (check) {
      return { id: i, type: BLOCK.CHECK, indent, text: check[2], checked: /[xX]/.test(check[1]) };
    }
    if (/^[-*+] /.test(rest)) {
      return { id: i, type: BLOCK.BULLET, indent, text: rest.slice(2), checked: false };
    }
    const num = /^(\d+)\. (.*)$/.exec(rest);
    if (num) {
      return { id: i, type: BLOCK.NUMBER, indent, text: num[2], start: Number(num[1]), checked: false };
    }
    return { id: i, type: BLOCK.P, indent, text: rest, checked: false };
  });
}

/** One block → its source line. The exact inverse of the branch above. */
export function serializeBlock(b) {
  const pad = '\t'.repeat(Math.min(b.indent || 0, MAX_INDENT));
  switch (b.type) {
    case BLOCK.H1: return `# ${b.text}`;
    case BLOCK.H2: return `## ${b.text}`;
    case BLOCK.BULLET: return `${pad}- ${b.text}`;
    // The number is stored so `3. ` starts at three, per §5. Display
    // numbering is computed from position at render time; this is the seed,
    // not the label.
    case BLOCK.NUMBER: return `${pad}${b.start ?? 1}. ${b.text}`;
    case BLOCK.CHECK: return `${pad}[${b.checked ? 'x' : ' '}] ${b.text}`;
    case BLOCK.PHOTO: return b.text ? `![${b.asset}] ${b.text}` : `![${b.asset}]`;
    default: return `${pad}${b.text}`;
  }
}

export function serialize(blocks) {
  return blocks.map(serializeBlock).join('\n');
}

/**
 * Display numbers for an ordered list.
 *
 * Numbering restarts whenever the run of NUMBER blocks at a given indent is
 * broken by anything else, and an explicit `start` on the first item of a run
 * seeds it. Computed rather than stored so deleting the second of five items
 * renumbers the rest instead of leaving a gap — which is the entire reason
 * people expect ordered lists to be a list type and not typed digits.
 */
export function numbering(blocks) {
  const out = new Map();
  const counters = [];
  let prevIndent = -1;

  blocks.forEach((b, i) => {
    if (b.type !== BLOCK.NUMBER) {
      counters.length = 0;
      prevIndent = -1;
      return;
    }
    const lvl = b.indent || 0;
    // Going shallower ends the deeper runs, so a nested list that returns to
    // the outer level continues the outer count rather than restarting it.
    if (lvl < prevIndent) counters.length = lvl + 1;
    if (counters[lvl] == null) counters[lvl] = (b.start ?? 1) - 1;
    counters[lvl] += 1;
    out.set(i, counters[lvl]);
    prevIndent = lvl;
  });

  return out;
}

/** An empty note is one empty paragraph, never zero blocks — the editor
 *  always needs somewhere for the caret to be. */
export function emptyNote() {
  return '';
}

/**
 * A short preview for the tree, taken from the first line with any content.
 *
 * Strips block markers and inline marks so a note titled with `## ` does not
 * show its hashes in a sidebar 216px wide. Deliberately not the title: a note
 * has a `title` column, and this is what fills the row when that is blank.
 */
export function excerpt(source, max = 60) {
  const blocks = parse(source);
  const first = blocks.find((b) => b.type !== BLOCK.PHOTO && b.text.trim());
  if (!first) return '';
  const flat = first.text
    .replace(/=([123])=(.*?)=\1=/g, '$2')
    .replace(/==(.*?)==/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

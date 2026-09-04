// Diagrams: three primitives, and refusing the fourth.
//
// §11: "Diagrams are three primitives, not a canvas. Chain, axes, branch —
// one typed line each. They cover what revision diagrams are: a process, a
// shape, a classification." And on cost: "Three fixed layouts drawing to
// inline SVG from a one-line parse. Genuinely small; the discipline is
// refusing the fourth primitive when someone asks."
//
// So there are three, this comment is where the refusal is written down, and
// the parser has no extension point. The moment a diagram can be positioned
// it needs alignment tools and this becomes a drawing app.
//
//   a -> b -> c                    chain    a process
//   graph: x=t y=v, up-curve       axes     a shape, never data
//   tree:                          branch   a classification
//     Mammals
//       Cats
//
// This module returns LAYOUT DATA, not SVG. The renderer draws it, so stroke
// widths and colours come from tokens (`--nb-check-line`, `--nb-stroke-w`)
// rather than being baked in here — §8's Trap 1 applies to a diagram exactly
// as it applies to a checkbox, and a hex in this file would be invisible to
// all five themes.

/**
 * `a -> b -> c`, with a trailing `->` closing it into a cycle.
 *
 * Wrapping is the renderer's job — it knows the measure. This just says what
 * the nodes are and whether the last one loops back.
 */
export function parseChain(input) {
  const src = String(input ?? '').trim();
  if (!src.includes('->')) return null;

  const cycle = /->\s*$/.test(src);
  const body = cycle ? src.replace(/->\s*$/, '') : src;
  const nodes = body.split('->').map((s) => s.trim()).filter(Boolean);

  // One node is not a chain, it is a word with an arrow after it.
  if (nodes.length < 2) return null;
  return { kind: 'chain', nodes, cycle };
}

// The shapes, as normalised sample points in a unit box (0,0 bottom-left to
// 1,1 top-right). Fixed rather than computed because §11 is explicit: "Shape
// only — never data." A student sketching "concentration decays" is making a
// qualitative claim, and letting them supply points would turn a revision
// aid into a plotting tool with no axes worth trusting.
const SHAPES = {
  linear:      [[0, 0], [1, 1]],
  'up-curve':  [[0, 0], [0.35, 0.12], [0.65, 0.38], [0.85, 0.66], [1, 1]],
  'down-curve':[[0, 1], [0.15, 0.66], [0.35, 0.38], [0.65, 0.12], [1, 0]],
  's-curve':   [[0, 0.02], [0.2, 0.06], [0.4, 0.25], [0.5, 0.5], [0.6, 0.75], [0.8, 0.94], [1, 0.98]],
  peak:        [[0, 0.05], [0.25, 0.45], [0.5, 0.95], [0.75, 0.45], [1, 0.05]],
  decay:       [[0, 1], [0.15, 0.62], [0.3, 0.4], [0.5, 0.22], [0.75, 0.09], [1, 0.04]],
  step:        [[0, 0.05], [0.45, 0.05], [0.5, 0.9], [1, 0.9]],
};

export const SHAPE_NAMES = Object.keys(SHAPES);

/**
 * `graph: x=t y=v, up-curve` — optionally `, plateau` to flatten the tail.
 *
 * Axis labels are optional; the shape is not. A `graph:` with no recognised
 * shape returns null rather than defaulting to linear, because guessing which
 * curve somebody meant is the one thing worse than not drawing it.
 */
export function parseAxes(input) {
  const src = String(input ?? '').trim();
  const head = /^graph:\s*(.*)$/i.exec(src);
  if (!head) return null;

  const parts = head[1].split(',').map((s) => s.trim()).filter(Boolean);
  let x = null;
  let y = null;
  let shape = null;
  let plateau = false;

  for (const part of parts) {
    const ax = /^([xy])\s*=\s*(.+)$/i.exec(part);
    if (ax) {
      // `x=t y=v` arrives as one comma-free part, so split on whitespace and
      // re-read. Handles both `x=t y=v` and `x=t, y=v`.
      for (const piece of part.split(/\s+/)) {
        const one = /^([xy])\s*=\s*(.+)$/i.exec(piece);
        if (!one) continue;
        if (one[1].toLowerCase() === 'x') x = one[2];
        else y = one[2];
      }
      continue;
    }
    const key = part.toLowerCase();
    if (key === 'plateau') { plateau = true; continue; }
    if (SHAPES[key]) { shape = key; continue; }
  }

  if (!shape) return null;

  let points = SHAPES[shape];
  if (plateau) {
    // Flatten the last third to the value it had reached. Applied here rather
    // than as a seventh shape so `peak, plateau` and `s-curve, plateau` both
    // work without doubling the table.
    const at = points[Math.floor(points.length * 0.66)];
    points = points.map(([px, py]) => (px > at[0] ? [px, at[1]] : [px, py]));
  }

  return { kind: 'axes', x, y, shape, plateau, points };
}

/**
 * `tree:` followed by indented lines. Two levels, matching the list nesting
 * limit — one nesting rule for the whole feature (§5, §11).
 *
 * @param {string[]} lines  the `tree:` line and everything indented under it
 */
export function parseTree(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  if (!/^tree:\s*$/i.test((arr[0] || '').trim()) && !/^tree:/i.test((arr[0] || '').trim())) return null;

  // A root may sit on the `tree:` line itself.
  const inlineRoot = /^tree:\s*(.+)$/i.exec(arr[0].trim());
  const roots = [];
  if (inlineRoot) roots.push({ label: inlineRoot[1].trim(), children: [] });

  for (const raw of arr.slice(1)) {
    if (!raw.trim()) continue;
    // Indent by tabs or by pairs of spaces; a note typed on a phone gets
    // whichever the keyboard felt like.
    const tabs = /^\t+/.exec(raw);
    const spaces = /^ +/.exec(raw);
    const depth = tabs ? tabs[0].length : spaces ? Math.floor(spaces[0].length / 2) : 0;
    const label = raw.trim();

    if (depth <= 0 || !roots.length) {
      roots.push({ label, children: [] });
    } else {
      // Depth is clamped at one: anything deeper joins the level above rather
      // than being dropped, so a third level of typing still shows up.
      roots[roots.length - 1].children.push({ label });
    }
  }

  if (!roots.length) return null;
  return { kind: 'tree', roots };
}

/**
 * The single entry point. Chain, then axes — tree is handled by the caller
 * because it spans several lines and this is per-line.
 *
 * Returns null for anything that is not one of the three, which keeps the
 * literal source visible per §11's error contract.
 */
export function renderDiagram(input) {
  return parseAxes(input) || parseChain(input);
}

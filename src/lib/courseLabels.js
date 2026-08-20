// Course display labels for space-constrained surfaces.
//
// Deliberately free of imports. It is pure string work, and keeping it that
// way means a plain `node` script can assert it without pulling the i18n
// bundle in through `dates.js`.

/**
 * Distinguishing short labels for a set of course names.
 *
 * The problem this solves is real and specific. A phone fits seven day columns
 * at roughly 55px each, which is about eight characters of a course name. The
 * owner takes an entire year of Pre-IB courses, so every block on the grid
 * truncated to the same three letters: "Pre". Eight characters of a name is
 * plenty to identify a course — unless all of them start the same way, at
 * which point the visible part carries literally zero information.
 *
 * So: strip the leading words that EVERY name shares, but strip as few as
 * possible. The rule is "drop the fewest common leading words such that the
 * first `visible` characters are distinct":
 *
 *   Pre-IB Mathematics / Pre-IB Physics   -> Mathematics / Physics   (drop 1)
 *   Pre-IB Math HL     / Pre-IB Math SL   -> Math HL     / Math SL   (drop 1)
 *
 * The second case is why "shortest strip that works" rather than "strip the
 * whole common prefix" — the greedy version would drop "Math" too and leave
 * bare "HL" and "SL", which is technically distinct and useless to read.
 *
 * Only words shared by ALL names are ever removed, so nothing that
 * distinguishes one course from another can be stripped. A name is never
 * reduced to nothing: the guard stops one word short of the shortest name.
 *
 * @param {string[]} names
 * @param {number} visible  characters the caller expects to actually fit
 * @returns {Map<string, string>} full name -> label (identity when nothing applies)
 */
export function shortenLabels(names, visible = 8) {
  const list = [...new Set((names || []).map((n) => (n || '').trim()).filter(Boolean))];
  const map = new Map(list.map((n) => [n, n]));
  // One course cannot collide with anything, so there is nothing to strip and
  // the full name is the most informative thing to show.
  if (list.length < 2) return map;

  const words = list.map((n) => n.split(/\s+/));
  const shortest = Math.min(...words.map((w) => w.length));

  let common = 0;
  while (common < shortest - 1) {
    const w = words[0][common].toLowerCase();
    if (!words.every((ws) => ws[common].toLowerCase() === w)) break;
    common++;
  }
  if (!common) return map;

  const apply = (drop) => {
    list.forEach((n, i) => map.set(n, words[i].slice(drop).join(' ')));
    return map;
  };
  for (let drop = 1; drop <= common; drop++) {
    const keys = words.map((ws) => ws.slice(drop).join(' ').slice(0, visible).toLowerCase());
    if (new Set(keys).size === keys.length) return apply(drop);
  }
  // Nothing separates them inside `visible` characters even at the full strip
  // — two courses genuinely named alike. Strip it anyway: the shared prefix was
  // not telling them apart either, and the extra room helps whatever follows.
  return apply(common);
}

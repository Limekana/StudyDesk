import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// v1.17 (#99) — every literal key passed to `t()` must exist in en.json.
// A missing key prints itself in every language: the exam title input was
// read out by screen readers as "sv.fTitle". A default (`t(key, '—')`) hides
// the gap rather than closing it, so it does not count as present. Keys built
// at runtime (`t(`gv.${x}`)`) are out of reach of a static scan.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(join(SRC, 'i18n/locales/en.json'), 'utf8'));
const KEY = /\bt\(\s*(['"])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g;

function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(path);
  }
  return out;
}

const lookup = (key) =>
  key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en);

// A plural key is called by its base name and stored as `_one`/`_other`.
const exists = (key) =>
  lookup(key) !== undefined || lookup(`${key}_one`) !== undefined || lookup(`${key}_other`) !== undefined;

describe('i18n keys', () => {
  it('every literal t() key resolves in en.json', () => {
    const missing = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
        seen++;
        if (!exists(match[2])) missing.push(`${match[2]} (${file.slice(SRC.length + 1)})`);
      }
    }
    // Guards the scan itself: a regex that silently matched nothing would pass.
    expect(seen).toBeGreaterThan(900);
    expect(missing).toEqual([]);
  });
});

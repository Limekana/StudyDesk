// StudyDesk#86 - the Lock In inputs must out-specify the global input rule.
//
// forms.css styles every text/number input with `input[type=text]` /
// `input[type=number]` (specificity 0,1,1). The Lock In takeover's inputs used
// bare class selectors (0,1,0), so every property both rules set came from the
// global rule: a cream box with an invisible cream placeholder, and a
// custom-minutes pill stretched to 100% width. Nothing failed until a screen
// recording showed it. This test reads the real stylesheets and fails if a
// Lock In input rule ever drops back to or below the global rule.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = (name) => readFileSync(join(here, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every selector (comma-split) of every rule in a stylesheet. */
function selectors(source) {
  const out = [];
  for (const m of source.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const s of m[1].split(',')) out.push(s.trim());
  }
  return out.filter(Boolean);
}

/** CSS specificity as [ids, classes/attributes/pseudo-classes, types/pseudo-elements]. */
function specificity(selector) {
  let s = selector;
  const pseudoElements = (s.match(/::[\w-]+/g) || []).length;
  s = s.replace(/::[\w-]+/g, ' ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  s = s.replace(/#[\w-]+/g, ' ');
  const classLike = /\.[\w-]+|\[[^\]]*\]|:[\w-]+(\([^)]*\))?/g;
  const classes = (s.match(classLike) || []).length;
  s = s.replace(classLike, ' ');
  const types = (s.match(/[a-zA-Z][\w-]*/g) || []).length + pseudoElements;
  return [ids, classes, types];
}

const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

describe('Lock In input specificity (#86)', () => {
  const globalInput = specificity('input[type=text]');
  const timer = selectors(css('timer.css'));

  it('the helper scores the selectors involved correctly', () => {
    expect(specificity('input[type=text]')).toEqual([0, 1, 1]);
    expect(specificity('.lockin-task-input')).toEqual([0, 1, 0]);
    expect(specificity('.lockin-wrap input.lockin-task-input')).toEqual([0, 2, 1]);
  });

  for (const cls of ['lockin-task-input', 'lockin-preset-input']) {
    it(`every base rule for .${cls} beats the global input rule`, () => {
      // Base rules only: pseudo-elements like ::placeholder and the spin
      // buttons are not contested by forms.css.
      const rules = timer.filter((s) => s.includes(`.${cls}`) && !s.includes('::'));
      expect(rules.length).toBeGreaterThan(0);
      for (const s of rules) {
        expect(beats(specificity(s), globalInput), `${s} must out-specify input[type=…]`).toBe(true);
      }
    });
  }

  it('the global rule still exists, so this test is still guarding something real', () => {
    const forms = selectors(css('forms.css'));
    expect(forms).toContain('input[type=text]');
    expect(forms).toContain('input[type=number]');
  });
});

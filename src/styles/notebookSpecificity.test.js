// StudyDesk#126 - the notebook's editor line and course picker must out-specify
// the app-wide field rules.
//
// forms.css gives every textarea `min-height: 80px` (and every select a box),
// and themes.css restyles fields as `html[data-theme] :where(input, textarea,
// select)`, specificity (0,1,1). The notebook's single-class rules (0,1,0) lost
// to both: a tapped 28px line opened as an 80px editor and pushed the page off
// its ruling, and Stacks/Slate drew the line as a form field. Same pattern as
// lockinSpecificity.test.js, which caught the Lock In version of this (#86).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = (name) => readFileSync(join(here, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as { selector, body }, selectors comma-split, outside @media too. */
function rules(source) {
  const out = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const s of m[1].split(',')) out.push({ selector: s.trim(), body: m[2] });
  }
  return out;
}

/** [ids, classes/attributes, types] for the simple selectors used here. */
function specificity(selector) {
  const s = selector.replace(/:where\([^)]*\)/g, ' '); // :where() counts for nothing
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes = (s.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) || []).length;
  const types = (s.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+|#[\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length;
  return [ids, classes, types];
}
const beats = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
const decl = (body, prop) => new RegExp(`(^|;|\\s)${prop}\\s*:\\s*([^;]+)`).exec(body)?.[2].trim();

describe('notebook field resets out-specify the app-wide field rules (#126)', () => {
  const nb = rules(css('notebook.css'));
  const themeField = specificity('html[data-theme="stacks"] :where(input, textarea, select)');

  it('the helper scores the selectors involved correctly', () => {
    expect(themeField).toEqual([0, 1, 1]);
    expect(specificity('textarea')).toEqual([0, 0, 1]);
    expect(specificity('.nb .nb-input')).toEqual([0, 2, 0]);
  });

  it('the editor line resets min-height, border and background above both rules', () => {
    const r = nb.find((x) => x.selector === '.nb .nb-input');
    expect(r, '.nb .nb-input rule').toBeTruthy();
    expect(beats(specificity(r.selector), themeField)).toBe(true);
    expect(decl(r.body, 'min-height')).toBe('0');
    expect(decl(r.body, 'border')).toBe('0');
    expect(decl(r.body, 'background')).toBe('transparent');
  });

  it('the course picker resets border and background above both rules', () => {
    const r = nb.find((x) => x.selector === '.nb .nb-head-course-select');
    expect(r, '.nb .nb-head-course-select rule').toBeTruthy();
    expect(beats(specificity(r.selector), themeField)).toBe(true);
    expect(decl(r.body, 'border')).toBe('0');
    expect(decl(r.body, 'background')).toBe('none');
  });

  it('the rules being beaten still exist, so this test still guards something', () => {
    expect(css('forms.css')).toMatch(/textarea\{[^}]*min-height:80px/);
    expect(css('themes.css')).toMatch(/:where\(input, textarea, select\)/);
  });
});

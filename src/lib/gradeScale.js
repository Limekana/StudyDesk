// Grade scales — SD-F4.
//
// Until now `gradeMode` was `'us' | 'ib'`, which left a student on the Finnish
// 4–10 scale with no correct option, and the same is true across most of
// Europe. This adds a third mode whose bounds the user defines.
//
// Almost none of this needed new maths. `calculateGPA(courses, 'ib')` is a
// straight weighted mean, which is already correct for any "higher is better"
// numeric scale, Finnish 4–10 included; and `grades.grade` is `numeric` in
// Postgres storing the raw value, so a scale is purely interpretation and no
// migration is involved. What was missing was somewhere to say what the numbers
// mean.
//
// `direction` is here because several European scales run the other way —
// German and Czech 1–5/1–6 have 1 as best. It costs one comparison, and leaving
// it out means revisiting all of this the first time a German user asks.

const GRADE_MODES = ['ib', 'us', 'custom'];

/** Suggested when "Custom" is first picked: the Finnish scale that prompted
 *  the request, which also makes the feature self-explanatory. */
export const DEFAULT_CUSTOM_SCALE = { min: 4, max: 10, passMark: 5, direction: 'up', name: '' };

// v1.14 Item 2 (#47) — one-tap starting points for the Custom editor.
//
//   > "Is there a grade scale of 20? […] or would I need to manually customize
//      this"    (issue #47, a French user)
//
// Nothing was broken: Custom already expresses /20 exactly, and always has.
// What the question shows is someone looking at four empty number fields and
// not being sure the app knows what they mean. So the fix is discoverability,
// not capability — a chip that fills the fields in and lets them see the answer
// rather than construct it.
//
// These are STARTING POINTS, not locked presets: tapping one writes the four
// numbers into the same draft the fields edit, and every one stays editable
// afterwards. There is deliberately no "which preset am I on" state to keep in
// sync with the numbers — the numbers are the truth.
//
// `name` is NOT set by a preset. It is a stored, user-visible string, and
// writing a country into it would freeze one language into the saved scale for
// exactly the reason `normalizeScale` gives below. The chip's own label is
// translated; the field underneath stays the user's to fill in.
//
// Two entries, both with evidence behind them: /20 is this issue, and 4–10 is
// the Finnish scale that prompted the Custom mode in the first place (it is
// already DEFAULT_CUSTOM_SCALE — the chip only gives it a name). More can be
// added when more are actually asked for; a full country picker on the strength
// of one request would be building a menu for an audience we have not met.
export const SCALE_PRESETS = [
  { id: 'fr20', labelKey: 'settings.scalePresetFr', scale: { min: 0, max: 20, passMark: 10, direction: 'up' } },
  { id: 'fi410', labelKey: 'settings.scalePresetFi', scale: { min: 4, max: 10, passMark: 5, direction: 'up' } },
];

// Built-in scales, expressed in the same shape as a custom one so every
// consumer can read bounds without caring which mode is active.
const BUILTIN = {
  ib: { min: 1, max: 7, passMark: 4, direction: 'up' },
  us: { min: 0, max: 100, passMark: 60, direction: 'up' },
};

export function isGradeMode(mode) {
  return GRADE_MODES.includes(mode);
}

/**
 * Coerce anything persisted or user-typed into a usable scale.
 *
 * Deliberately total: it always returns a valid scale rather than throwing or
 * returning null, because the callers are render paths and a half-typed value
 * in the Settings form must not blank the Grades screen. Invalid pieces fall
 * back to the default one at a time, so clearing `max` while editing does not
 * also reset `min`.
 */
export function normalizeScale(raw) {
  const d = DEFAULT_CUSTOM_SCALE;
  const num = (v, fallback) => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : fallback;
  };

  let min = num(raw?.min, d.min);
  let max = num(raw?.max, d.max);
  // A user typing a range backwards means the range, not an error — swapping is
  // friendlier than refusing, and `direction` already carries which end is good.
  if (min > max) [min, max] = [max, min];
  // Degenerate range would make every hint read "5–5"; nudge rather than reject.
  if (min === max) max = min + 1;

  const passMark = Math.min(max, Math.max(min, num(raw?.passMark, d.passMark)));
  const direction = raw?.direction === 'down' ? 'down' : 'up';
  // What the user calls this scale. Empty means "no name given" and every
  // consumer falls back to a translated default — storing the translated word
  // instead would freeze one language into the saved scale and then show a
  // Finnish user's label to them after they switch the app to English.
  // Capped because it is rendered into a fixed-height hero line, and trimmed
  // so a stray space does not count as a name and defeat the fallback.
  const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 24) : '';
  return { min, max, passMark, direction, name };
}

/** The active scale's bounds, whichever mode is in play. */
export function scaleFor(mode, custom) {
  if (mode === 'custom') return normalizeScale(custom);
  return BUILTIN[mode] ?? BUILTIN.ib;
}

// A pass/fail marker on each grade row is the obvious next use of `passMark`
// and `direction`, and the one comparison it needs is
// `direction === 'down' ? n <= passMark : n >= passMark`. Not written yet:
// there is no pass/fail display anywhere in the app, and an unused helper is
// exactly what the rest of this pass has been deleting. Both fields still earn
// their place today — they are visible in the scale summary, and they are what
// a German or Czech 1-6 user needs the app to have stored when that marker
// does land.

/** "4–10 · pass 5 · 10 best" — the one place min, max, passMark and direction
 *  are all visible, so no stored field is write-only. */
export function describeScale(scale, t) {
  const best = scale.direction === 'down' ? scale.min : scale.max;
  return t('gv.scaleSummary', {
    min: scale.min,
    max: scale.max,
    pass: scale.passMark,
    best,
  });
}

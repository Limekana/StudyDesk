// Course colour picker — SD-5.
//
// Was three near-identical inline blocks (add-course modal, onboarding step 2,
// edit-course modal) over a closed set of eight hex values. A student with nine
// courses had to reuse one, which defeats the point of colour-coding the
// calendar and the card accents.
//
// Two of the three tracked the selection as an *index* into COURSE_COLORS,
// which cannot express a colour outside the list at all — so the escape hatch
// needed them converted to value-based first. They are now, and all three share
// this component, which is why the diff removes more than it adds.
//
// The custom control is a native <input type="color">. On Android WebView that
// opens the system colour picker, so there is no wheel to build, nothing to
// translate, and no dependency. The eight presets stay first because they are
// the fast path and they are chosen to stay legible on the cream-paper
// background — a free picker lets someone choose near-white, which is their
// call, but it should not be the easy one.
//
// COURSE_COLORS lives in ./courseColors.js — see the note there.
//
// v1.14 Item 1 — the calendar's blocker editor asked for the same escape hatch
// (issue #47: "I want to pick my own colour for a blocker"), and it had its own
// near-identical swatch row, closed over the same eight values. That is the
// fourth copy this component exists to prevent, so it is folded in here rather
// than given a free picker of its own. The one thing it needs that a course
// does not is NO colour: a course is always colour-coded, a blocker may just be
// a grey block on the grid. Hence `allowNone`, off by default so the three
// course call sites are unchanged.

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { COURSE_COLORS } from './courseColors.js';

const css = `
.cp-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.cp-swatch{width:24px;height:24px;border-radius:50%;cursor:pointer;padding:0;border:none;outline-offset:2px;}
.cp-custom{position:relative;width:24px;height:24px;border-radius:50%;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
  /* Conic wheel so the control reads as "any colour" before it is opened. */
  background:conic-gradient(#c0392b,#d4860a,#2e7d52,#1e7d7d,#1a5c9e,#6d3fa0,#8b4a62,#c0392b);}
.cp-custom input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;padding:0;border:none;}
.cp-custom-dot{width:9px;height:9px;border-radius:50%;background:var(--surface);pointer-events:none;}
/* "No colour" reads as an empty slot rather than as white, which on cream
   would look like a colour someone deliberately picked. Same treatment the
   blocker editor's own swatch used, moved here with it. */
.cp-none{width:24px;height:24px;border-radius:50%;cursor:pointer;padding:0;border:1px solid var(--border2);outline-offset:2px;
  background:linear-gradient(45deg,transparent 45%,var(--border2) 45%,var(--border2) 55%,transparent 55%);}
`;

/**
 * @param {string}   value      currently selected hex, or '' for none
 * @param {Function} onChange   called with the new hex, or '' when cleared
 * @param {boolean}  allowNone  offer a "no colour" slot first (blockers)
 */
export default function CoursePicker({ value, onChange, allowNone = false }) {
  const { t } = useTranslation();
  const inputId = useId();
  const isPreset = COURSE_COLORS.includes(value);

  return (
    <>
      <style>{css}</style>
      <div className="cp-row">
        {/* First, so clearing a colour is the same gesture as picking one and
            does not hide behind the wheel at the end of the row. */}
        {allowNone && (
          <button
            type="button"
            className="cp-none"
            style={{ outline: value ? '2px solid transparent' : '3px solid var(--text)' }}
            onClick={() => onChange('')}
            aria-label={t('course.colorNone')}
            title={t('course.colorNone')}
            aria-pressed={!value}
          />
        )}
        {COURSE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className="cp-swatch"
            style={{ background: c, outline: value === c ? `3px solid ${c}` : '2px solid transparent' }}
            onClick={() => onChange(c)}
            aria-label={t('course.colorSwatch', { hex: c })}
            aria-pressed={value === c}
          />
        ))}
        {/* Sits last so tabbing reaches the eight presets first. When a custom
            colour is active the wheel is outlined in it, so the current choice
            is visible without opening the picker. */}
        <label
          className="cp-custom"
          htmlFor={inputId}
          style={{ outline: !isPreset && value ? `3px solid ${value}` : '2px solid transparent' }}
          title={t('course.colorCustom')}
        >
          <span className="cp-custom-dot" style={!isPreset && value ? { background: value } : undefined} />
          <input
            id={inputId}
            type="color"
            value={value || '#2e7d52'}
            onChange={(e) => onChange(e.target.value)}
            aria-label={t('course.colorCustom')}
          />
        </label>
      </div>
    </>
  );
}

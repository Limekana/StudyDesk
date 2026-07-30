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
`;

/**
 * @param {string}   value     currently selected hex
 * @param {Function} onChange  called with the new hex
 */
export default function CoursePicker({ value, onChange }) {
  const { t } = useTranslation();
  const inputId = useId();
  const isPreset = COURSE_COLORS.includes(value);

  return (
    <>
      <style>{css}</style>
      <div className="cp-row">
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

// The docked format bar. §4.
//
// One row, 44px, pinned to the top of the keyboard inset. The decisions worth
// restating because they are the ones that get argued back:
//
// **Docked, not selection-triggered.** Two reasons, both decisive. Most
// mobile formatting here STARTS a block — a list, a checkbox, a heading —
// with nothing selected, and a selection popover cannot be reached for the
// common case. And on Android it fights the platform's own cut/copy/paste bar
// for the same space above the same selection; whichever wins, the user loses
// the other.
//
// **One row, not two.** On a 360×800 phone with the keyboard up, roughly
// 340px of writing area remains. This bar takes 44px — 13%, about one and a
// half ruled lines. A two-row bar takes 26% and is rejected on that basis
// alone.
//
// **Order: B I U ▨ | H1 H2 | • 1. ☐ | ＋.** Character formats first because
// they are used mid-sentence, so the thumb reaches them while reading the
// line; then blocks; then insert.
//
// **Eleven controls across 360px is 32px each**, under the 44px minimum. Each
// control's HIT AREA spans the full 44px bar height with a smaller glyph
// centred in it. The full-height strip is what makes the target real.
//
// **Active state is the glyph going to --nb-ink from --nb-ink-muted.** No
// pills, no fills — the bar has to sit quietly under a paper page.
//
// **On desktop (StudyDesk#113) the same bar sits in the format row** under
// the note header, portalled there by the editor that holds the caret
// (formatSlot.js). `inline` restyles it for that row; `idle` is the copy the
// row shows while nothing is being edited, so the controls can be found
// before clicking in. Every control's tooltip names its shortcut, and "?"
// opens the sheet that lists them all (ShortcutSheet.jsx).

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BLOCK } from './model.js';
import { MARK } from './inline.js';
import { shortcutFor } from './shortcuts.js';

const LONG_PRESS_MS = 450;

// `onMouseDown`/`onTouchStart` preventDefault on every control, so pressing
// one never moves focus out of the textarea. Losing focus dismisses the
// keyboard, and the bar leaves with it — the control would vanish from under
// the finger pressing it.
const hold = (e) => e.preventDefault();

// Declared at module scope, not inside the component. A component defined
// during render is a NEW type on every render, so React unmounts and remounts
// every button each time — which on this bar means losing the active press
// mid-tap.
function Btn({ label, on, onPress, aria, title }) {
  return (
    <button
      type="button"
      className={`nb-bar-btn${on ? ' is-on' : ''}`}
      onMouseDown={hold}
      onTouchStart={hold}
      onClick={onPress}
      aria-pressed={on || undefined}
      aria-label={aria}
      title={title}
    >
      {label}
    </button>
  );
}

export default function FormatBar({
  activeType, swatchesOpen, onSwatches, onAction, canInsertPhoto = false,
  inline = false, idle = false, onHelp,
}) {
  const { t } = useTranslation();
  // "Bold (Ctrl+B)". The chord comes from shortcuts.js, which a test holds
  // to what the keys actually do.
  const tip = (id, labelKey) => {
    const keys = shortcutFor(id);
    return keys ? `${t(labelKey)} (${keys})` : t(labelKey);
  };
  // The idle copy is a preview of the controls: visible, labelled, inert.
  const act = idle ? () => {} : onAction;
  const timer = useRef(0);
  const longFired = useRef(false);
  // §4: "one tap applies the LAST-USED role; long-press opens the three-swatch
  // popover." Remembering the role is what makes the single tap worth having —
  // a user marking a page in rose should not reopen the popover every line.
  const lastRole = useRef(1);

  const startHl = () => {
    if (idle) return;
    longFired.current = false;
    timer.current = window.setTimeout(() => {
      longFired.current = true;
      onSwatches(true);
    }, LONG_PRESS_MS);
  };
  const endHl = () => {
    window.clearTimeout(timer.current);
    if (longFired.current) return;
    act('mark', { mark: MARK.HL, role: lastRole.current });
  };

  const bar = (
    <>
      {swatchesOpen && (
        <div className="nb-swatches" role="group" aria-label={t('nb.highlightRoles')}>
          {[1, 2, 3].map((role) => (
            <button
              key={role}
              type="button"
              className="nb-swatch"
              data-role={role}
              onMouseDown={hold}
              onClick={() => {
                lastRole.current = role;
                onAction('mark', { mark: MARK.HL, role });
                onSwatches(false);
              }}
              aria-label={t(`nb.hlRole.${role}`)}
            />
          ))}
        </div>
      )}

      <div
        className={`nb-bar${inline ? ' is-inline' : ''}${idle ? ' is-idle' : ''}`}
        role="toolbar"
        aria-label={t('nb.formatBar')}
        aria-disabled={idle || undefined}
      >
        <Btn label="B" aria={t('nb.bold')} title={tip('bold', 'nb.bold')} onPress={() => act('mark', { mark: MARK.BOLD })} />
        <Btn label="I" aria={t('nb.italic')} title={tip('italic', 'nb.italic')} onPress={() => act('mark', { mark: MARK.ITALIC })} />
        <Btn label="U" aria={t('nb.underline')} title={tip('underline', 'nb.underline')} onPress={() => act('mark', { mark: MARK.UNDERLINE })} />
        {/* Highlight: tap applies the last role, long-press opens the three
            swatches. No free colour picker (§4) — and no fourth swatch. */}
        <button
          type="button"
          className="nb-bar-btn"
          onMouseDown={(e) => { hold(e); startHl(); }}
          onMouseUp={endHl}
          onMouseLeave={() => window.clearTimeout(timer.current)}
          onTouchStart={(e) => { hold(e); startHl(); }}
          onTouchEnd={endHl}
          aria-label={t('nb.highlight')}
          title={tip('highlight', 'nb.highlight')}
        >
          ▨
        </button>

        <span className="nb-bar-sep" aria-hidden="true" />

        <Btn label="H1" aria={t('nb.h1')} title={tip('h1', 'nb.h1')} on={activeType === BLOCK.H1} onPress={() => act('block', BLOCK.H1)} />
        <Btn label="H2" aria={t('nb.h2')} title={tip('h2', 'nb.h2')} on={activeType === BLOCK.H2} onPress={() => act('block', BLOCK.H2)} />

        <span className="nb-bar-sep" aria-hidden="true" />

        <Btn label="•" aria={t('nb.bullet')} title={tip('bullet', 'nb.bullet')} on={activeType === BLOCK.BULLET} onPress={() => act('block', BLOCK.BULLET)} />
        <Btn label="1." aria={t('nb.numbered')} title={tip('numbered', 'nb.numbered')} on={activeType === BLOCK.NUMBER} onPress={() => act('block', BLOCK.NUMBER)} />
        <Btn label="☐" aria={t('nb.checklist')} title={tip('checklist', 'nb.checklist')} on={activeType === BLOCK.CHECK} onPress={() => act('block', BLOCK.CHECK)} />

        <span className="nb-bar-sep" aria-hidden="true" />

        {/* Only when a host actually wired the callback. Photo insertion is
            not built yet, and NotebookView passes no `onInsertPhoto`, so this
            rendered a button that did nothing at all — the worst kind of
            affordance. It comes back by itself the day the prop is passed. */}
        {canInsertPhoto && (
          <Btn label="＋" aria={t('nb.insertPhoto')} onPress={() => act('photo')} />
        )}

        {/* The way to find out what all of this is, and what the keys are. */}
        {onHelp && <Btn label="?" aria={t('nb.helpOpen')} title={t('nb.helpOpen')} onPress={onHelp} />}
      </div>
    </>
  );

  // In the desktop row the swatches hang from the bar, not from the bottom of
  // the window, so they need a positioned wrapper.
  return inline ? <div className="nb-format-inline">{bar}</div> : bar;
}

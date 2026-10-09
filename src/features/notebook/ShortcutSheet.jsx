// The "?" sheet (StudyDesk#113): every keyboard shortcut and every bit of
// markdown the editor understands, read from shortcuts.js so it is exactly
// what works. The keyboard section shows only where there is a fine pointer,
// since a phone has no modifier keys (inputRules.js); the typing rules are the
// phone's primary path and show everywhere.
//
// The app's own modal (forms.css), so it looks like every other dialog here.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { SHORTCUTS, TYPE_RULES, chord, isMac } from './shortcuts.js';
import { useMediaQuery } from './formatSlot.js';

// A trailing space is what fires a line-start rule, so it is shown.
const shown = (typed) => typed.replace(/ $/, '␣');

export default function ShortcutSheet({ onClose }) {
  const { t } = useTranslation();
  const keyboard = useMediaQuery('(pointer: fine)');
  const mac = isMac();
  const closeRef = useRef(null);

  // Focus into the dialog so Esc and Tab work from the keyboard, without the
  // scroll that autoFocus does: the sheet opened scrolled to its last row.
  useEffect(() => { closeRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="nb-help-title" onClick={onClose}>
      <div className={`modal nb-help${keyboard ? ' has-keys' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title" id="nb-help-title">{t('nb.helpTitle')}</div>

        {/* Two columns where there is a keyboard and room: shortcuts beside the
            typing rules, so the whole sheet reads without scrolling. */}
        <div className="nb-help-cols">
        {keyboard && (
          <section className="nb-help-section">
            <h3 className="nb-help-h">{t('nb.helpKeys')}</h3>
            <dl className="nb-help-list">
              {SHORTCUTS.map((s) => (
                <div key={s.id} className="nb-help-row">
                  <dt>{t(s.label)}</dt>
                  <dd><kbd dir="ltr">{chord(s.keys, mac)}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <div>
        <section className="nb-help-section">
          <h3 className="nb-help-h">{t('nb.helpLineStart')}</h3>
          <dl className="nb-help-list">
            {TYPE_RULES.lineStart.map(([typed, label]) => (
              <div key={typed} className="nb-help-row">
                <dt>{t(label)}</dt>
                <dd><code dir="ltr">{shown(typed)}</code></dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="nb-help-section">
          <h3 className="nb-help-h">{t('nb.helpAround')}</h3>
          <dl className="nb-help-list">
            {TYPE_RULES.around.map(([typed, label]) => (
              <div key={typed} className="nb-help-row">
                <dt>{t(label)}</dt>
                <dd><code dir="ltr">{typed}</code></dd>
              </div>
            ))}
          </dl>
        </section>
        </div>
        </div>

        <div className="nb-help-actions">
          <button type="button" className="btn-outline" ref={closeRef} onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  );
}

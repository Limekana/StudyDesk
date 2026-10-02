// v1.16 (#67) — the "newer StudyDesk on F-Droid" note. The logic, and why it
// is shaped the way it is, lives in src/lib/fdroidUpdate.js.
//
// Inline at the top of the page, not a corner card and never a modal. An
// update is news, not an emergency: it should be seen on whatever screen the
// user opens, sit above their work rather than over it, and cost one tap to
// put away. A corner card would also collide with the referral prompt, which
// uses that corner for new accounts.
//
// Written like a margin correction in the notebook: the old version struck
// through, the new one beside it.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FDROID_PAGE, checkFdroidUpdate, dismissUpdate, useFdroidUpdate } from '../../lib/fdroidUpdate.js';

// After first paint and the initial pull, so it never competes with startup.
const CHECK_DELAY_MS = 4000;

export default function FdroidUpdateNote() {
  const { t } = useTranslation();
  const { available } = useFdroidUpdate();

  useEffect(() => {
    const id = setTimeout(() => { void checkFdroidUpdate(); }, CHECK_DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  if (!available) return null;
  const { current, latest } = available;
  const latestLabel = latest.name || `#${latest.code}`;

  return (
    <aside className="upd-note" aria-label={t('update.eyebrow')}>
      <div className="upd-note-eyebrow">{t('update.eyebrow')}</div>
      <div className="upd-note-title">{t('update.title', { version: latestLabel })}</div>
      <div className="upd-note-versions" aria-label={t('update.versions', { current: current.name, latest: latestLabel })}>
        <s>{current.name}</s>
        <span aria-hidden="true">→</span>
        <span className="upd-note-new">{latestLabel}</span>
      </div>
      <div className="upd-note-actions">
        <a className="btn" href={FDROID_PAGE} target="_blank" rel="noopener noreferrer">
          {t('update.open')}
        </a>
        <button type="button" className="upd-note-later" onClick={dismissUpdate}>
          {t('update.later')}
        </button>
      </div>
    </aside>
  );
}

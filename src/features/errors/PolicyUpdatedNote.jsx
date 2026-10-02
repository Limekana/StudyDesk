// v1.16 (limecore#16, NCC#50) — the one-time "privacy policy updated" note.
// Who sees it, and why, is in lib/policyNotice.js. Pinned to the top edge,
// clear of the referral card and the flash toast, and gone for good on either
// action.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { POLICY_URL, acknowledgePolicy, policyNoticeDue } from '../../lib/policyNotice.js';
import '../../styles/errors.css';

export default function PolicyUpdatedNote() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(policyNoticeDue);
  if (!open) return null;
  const close = () => {
    acknowledgePolicy();
    setOpen(false);
  };
  return (
    <aside className="pol-note" aria-label={t('policy.eyebrow')}>
      <div className="pol-note-eyebrow">{t('policy.eyebrow')}</div>
      <p className="pol-note-body">{t('policy.body')}</p>
      <div className="pol-note-actions">
        <a className="btn-outline" href={POLICY_URL} target="_blank" rel="noopener noreferrer" onClick={close}>
          {t('policy.read')}
        </a>
        <button type="button" className="pol-note-ok" onClick={close}>{t('policy.ok')}</button>
      </div>
    </aside>
  );
}

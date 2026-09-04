// The banner that turns silent data loss into a decision the user gets to make.
//
// It renders nothing at all until a CRITICAL local write fails. When one does,
// the app is in a specific and dangerous state: the data is still correct in
// memory, still on screen, still being added to — and none of it will exist
// after the next relaunch. That window is the only chance to save it, and
// until v1.13 the app spent that window saying nothing.
//
// ── Why a blocking-ish banner rather than a toast ────────────────────────
// A toast is right for "that didn't send, we'll retry". This is not that.
// Nothing is going to retry successfully, the loss is total for everything
// since the last good write, and the only actions that help are ones the user
// has to take. A toast that disappears after 2.2 seconds — which is what
// `showFlash` does — would be the same silence with extra steps.
//
// It is dismissible, because an undismissable banner in a study app during an
// exam week is its own harm, and because a user who has just exported their
// data has genuinely dealt with it. Dismissal is per-app-run: the state is not
// persisted, which is deliberate, since persisting it would require the very
// write that is failing.
//
// ── Why Export is the primary action ─────────────────────────────────────
// It is the only one that actually preserves the data without depending on
// anything that is currently broken. Signing in helps only if the network is
// up and only for the tables that sync; freeing space helps only if the user
// can find something to delete. Export writes a file, now, from memory.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { storageFailure, onStorageHealth, approximateUsage } from '../../lib/localStore.js';

function formatKB(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  return `${Math.round(bytes / 1024).toLocaleString()} kB`;
}

export default function StorageAlert({ onExport }) {
  const { t } = useTranslation();
  const [failure, setFailure] = useState(() => storageFailure());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => onStorageHealth((next) => {
    setFailure(next);
    // A recovery un-dismisses, so a SECOND failure after a successful write
    // is announced again rather than being hidden by an old dismissal. The
    // user dismissed one event, not the category.
    if (!next) setDismissed(false);
  }), []);

  if (!failure || dismissed) return null;

  const usage = approximateUsage();

  return (
    <div className="storage-alert" role="alert">
      <div className="storage-alert-head">{t('storage.title')}</div>
      <p className="storage-alert-body">
        {failure.reason === 'quota' ? t('storage.quotaBody') : t('storage.blockedBody')}
      </p>
      <p className="storage-alert-body storage-alert-stakes">{t('storage.stakes')}</p>
      {usage && (
        <div className="storage-alert-usage">
          {t('storage.usage', { ours: formatKB(usage.ours), total: formatKB(usage.total) })}
        </div>
      )}
      <div className="storage-alert-actions">
        <button className="btn" onClick={onExport}>{t('storage.export')}</button>
        <button className="btn-outline" onClick={() => setDismissed(true)}>
          {t('storage.dismiss')}
        </button>
      </div>
    </div>
  );
}

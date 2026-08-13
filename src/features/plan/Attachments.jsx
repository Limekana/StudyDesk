// v1.10 — assignment file attachments.
//
// The build plan flagged this as "real scope, not UI polish: needs a Supabase
// Storage bucket, upload flow, and RLS policy", and that is exactly what it
// turned out to be. The bucket is private, capped at 10 MB per object with a
// MIME allowlist, and its policies read path segment 1 as the owning user id —
// so `<user_id>/<assignment_id>/<file>` is a security boundary rather than a
// tidy convention. `sync.js` builds the path; nothing here invents one.
//
// Uploads do NOT go through the offline outbox. That queue persists as JSON in
// localStorage and a File cannot survive the round-trip — it would serialise to
// `{}` and a retry would push an empty object under the user's filename. So an
// upload needs connectivity and says so when it does not have it. Deletes DO
// queue, because they carry only ids.
//
// The drop-target hook lives in `useAttachmentDrop.js` — a module exporting
// both a component and a hook loses React Fast Refresh.

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Paperclip, Trash2, Download, Loader } from 'lucide-react';
import * as sync from '../../lib/sync.js';
import * as outbox from '../../lib/outbox.js';
import '../../styles/attachments.css';

function sizeLabel(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The list itself, shown under an assignment once it is expanded. */
export default function AttachmentList({ attachments, dispatch, session, showFlash, uploadFiles, busy }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const [opening, setOpening] = useState(null);

  const open = async (a) => {
    if (!session) { showFlash?.(t('at.needAccount')); return; }
    setOpening(a.id);
    try {
      const url = await sync.signedAttachmentUrl(a.storagePath);
      // `noopener` is not optional here: the URL is signed and short-lived,
      // and a window opened without it keeps a handle on this one.
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else showFlash?.(t('at.openFailed'));
    } catch (e) {
      showFlash?.(t('at.openFailedMsg', { msg: (e && e.message) || String(e) }));
    } finally {
      setOpening(null);
    }
  };

  const remove = (a) => {
    dispatch({ type: 'DELETE_ATTACHMENT', id: a.id });
    // Queued rather than awaited: the row and the object both go, and a
    // failure retries rather than leaving the user staring at a spinner.
    if (session) outbox.enqueue('delete_attachment', { id: a.id, storagePath: a.storagePath });
    showFlash?.(t('at.deleted'));
  };

  return (
    <div className="at-panel">
      <div className="at-head">
        <span className="at-head-label">
          <Paperclip size={12} strokeWidth={1.75} /> {t('at.title')}
        </span>
        <button
          type="button"
          className="btn-outline btn-sm"
          onClick={() => inputRef.current?.click()}
          disabled={!session}
          title={session ? t('at.addHint') : t('at.needAccount')}
        >
          {t('at.add')}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="at-input"
          onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {!session && <div className="at-note">{t('at.needAccount')}</div>}

      {attachments.length === 0 && busy === 0 && (
        <div className="at-empty">{t('at.empty')}</div>
      )}

      {attachments.map((a) => (
        <div key={a.id} className="at-row">
          <Paperclip size={12} strokeWidth={1.75} className="at-row-icon" />
          <span className="at-row-name" title={a.fileName}>{a.fileName}</span>
          <span className="at-row-size">{sizeLabel(a.sizeBytes)}</span>
          <button type="button" className="at-row-btn" onClick={() => open(a)} title={t('at.open')} disabled={opening === a.id}>
            {opening === a.id
              ? <Loader size={12} strokeWidth={1.75} className="at-spin" />
              : <Download size={12} strokeWidth={1.75} />}
          </button>
          <button type="button" className="at-row-btn danger" onClick={() => remove(a)} title={t('common.delete')}>
            <Trash2 size={12} strokeWidth={1.75} />
          </button>
        </div>
      ))}

      {busy > 0 && (
        <div className="at-row at-busy">
          <Loader size={12} strokeWidth={1.75} className="at-spin" />
          <span className="at-row-name">{t('at.uploading', { n: busy })}</span>
        </div>
      )}
    </div>
  );
}

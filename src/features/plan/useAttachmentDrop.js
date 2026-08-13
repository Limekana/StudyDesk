// Drop-target plumbing for one assignment's attachments.
//
// Lives in its own module rather than beside `AttachmentList` because a file
// that exports both a component and a hook loses React Fast Refresh — the
// lint rule that caught it is right, and the split costs nothing.
//
// Uploads do NOT go through the offline outbox: that queue is persisted as
// JSON in localStorage and a `File` does not survive the round-trip, so a
// retry would push an empty object under the user's filename. An upload needs
// connectivity and reports its own failure. Deletes DO queue — they carry only
// ids. See `uploadAttachment` in `lib/sync.js`.

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as sync from '../../lib/sync.js';

export function useAttachmentDrop({ assignmentId, dispatch, session, showFlash }) {
  const { t } = useTranslation();
  // `depth` rather than a boolean: dragging across a child element fires
  // dragleave on the parent, so a boolean flickers the highlight off and on at
  // every internal boundary the pointer crosses. Counting enter/leave pairs is
  // the standard fix and the only one that stays correct for nested markup.
  const [depth, setDepth] = useState(0);
  const [busy, setBusy] = useState(0);

  const uploadFiles = useCallback(async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (!session) { showFlash?.(t('at.needAccount')); return; }
    setBusy((n) => n + list.length);
    for (const file of list) {
      try {
        const row = await sync.uploadAttachment({ assignmentId, file });
        dispatch({ type: 'ADD_ATTACHMENT', attachment: row });
      } catch (e) {
        // Named failures get a sentence; anything else reports the real
        // message rather than a generic "upload failed", because the two
        // causes a user can act on (too big, wrong type) are both in it.
        if (e?.code === 'too-large') showFlash?.(t('at.tooLarge', { name: file.name }));
        else showFlash?.(t('at.uploadFailed', { name: file.name, msg: (e && e.message) || String(e) }));
      } finally {
        setBusy((n) => Math.max(0, n - 1));
      }
    }
  }, [assignmentId, dispatch, session, showFlash, t]);

  const dropProps = {
    onDragEnter: (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDepth((d) => d + 1); } },
    onDragOver: (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: () => setDepth((d) => Math.max(0, d - 1)),
    onDrop: (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      setDepth(0);
      void uploadFiles(e.dataTransfer.files);
    },
  };

  return { dropProps, isOver: depth > 0, busy, uploadFiles };
}

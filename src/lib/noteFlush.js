// v1.18.1 (StudyDesk#161) — ask the note editor's sync to push its debounced
// edits now. A note edit waits 1.5 s before it is queued (useNoteSync.js), so
// a count of unsent changes taken inside that window missed it: sign-out said
// nothing would be lost while an edit was. Listeners run synchronously, so
// the edit is in the outbox when dispatch returns.
export const FLUSH_NOTE_EDITS_EVENT = 'studydesk:flush-note-edits';

export function requestNoteFlush() {
  try {
    window.dispatchEvent(new CustomEvent(FLUSH_NOTE_EDITS_EVENT));
  } catch { /* no window (tests, SSR): nothing is debounced there */ }
}

/** The message shown when a different account signs in and the previous
 *  one's local data is cleared: with the count of changes that never synced,
 *  when there were any. */
export function otherAccountClearedMessage(t, unsent) {
  return unsent > 0
    ? t('settings.otherAccountClearedUnsent', { count: unsent })
    : t('settings.otherAccountCleared');
}

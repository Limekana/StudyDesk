// GDPR data-subject rights — Article 20 (portability) and Article 17 (erasure).
//
// Both are exposed as buttons in Settings rather than as a "contact us" address,
// so a user never has to ask and we never have to service a request by hand.
//
// Export works signed in or as a guest: a guest's data lives only on the device,
// and it is still their data. Deletion only means anything when there is a
// server-side account to delete.

import { supabase } from './supabase.js';

const EXPORT_SCHEMA_VERSION = 1;

/**
 * Everything we hold about the user, as a plain object.
 *
 * Built from local state rather than by re-reading the server: local state is
 * the union of what synced down and what has not synced up yet, so it is the
 * more complete picture. Article 20 asks for "structured, commonly used and
 * machine-readable" — JSON qualifies, and unlike CSV it can carry the nested
 * shape without inventing a flattening the user then has to undo.
 *
 * Soft-deleted rows are included, and flagged. They still exist in the
 * database, so omitting them would make the export a misleading account of what
 * we hold.
 */
export function buildExport(state, session) {
  const courses = Object.values(state.courses || {});
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    application: 'StudyDesk',
    account: session
      ? {
          email: session.user?.email ?? null,
          userId: session.user?.id ?? null,
          signInProvider: session.user?.app_metadata?.provider ?? null,
          createdAt: session.user?.created_at ?? null,
        }
      : { mode: 'guest', note: 'No account — this data has never left the device.' },
    counts: {
      courses: courses.length,
      grades: (state.grades || []).length,
      studySessions: (state.studySessions || []).length,
      assignments: (state.assignments || []).length,
      exams: (state.exams || []).length,
    },
    courses,
    grades: state.grades || [],
    studySessions: state.studySessions || [],
    assignments: state.assignments || [],
    exams: state.exams || [],
    settings: {
      gradeMode: state.gradeMode ?? null,
      customScale: state.customScale ?? null,
      language: (() => {
        try { return localStorage.getItem('limecore_lang'); } catch { return null; }
      })(),
    },
  };
}

/** Trigger a download of the export as a .json file. Returns the filename. */
export function downloadExport(state, session) {
  const payload = buildExport(state, session);
  const json = JSON.stringify(payload, null, 2);
  const name = `studydesk-export-${new Date().toISOString().slice(0, 10)}.json`;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download
  // on some Android WebView versions before it has started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

/**
 * Erase the account and everything attached to it.
 *
 * Deleting the auth user is sufficient: every user-owned table declares
 * `REFERENCES auth.users(id) ON DELETE CASCADE`, so profiles, subjects, grades
 * and study_sessions all go with it. Verified against the live schema rather
 * than assumed — a soft delete would not satisfy Article 17.
 *
 * The deletion itself runs in the `delete-account` Edge Function because
 * `auth.admin.deleteUser` needs the service-role key, which must never ship in
 * a client bundle. The function authenticates the caller by their own JWT and
 * deletes only that user, so it cannot be aimed at anyone else.
 *
 * Local data is cleared regardless of what the server says. A user who asked to
 * be deleted should not find their coursework still on the device afterwards.
 */
export async function deleteAccount({ clearLocal }) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    // Guest: there is no server-side account. Clearing the device is the whole
    // of the erasure.
    await clearLocal();
    return { deleted: 'local' };
  }

  const { error } = await supabase.functions.invoke('delete-account', {
    body: { confirm: true },
  });
  if (error) throw new Error(error.message || 'Account deletion failed');

  try {
    await supabase.auth.signOut();
  } catch {
    // The user row is already gone, so the sign-out call may fail. Not fatal.
  }
  await clearLocal();
  return { deleted: 'account' };
}

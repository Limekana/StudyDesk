// Initials for the account avatar. Split from avatar.jsx because
// react-refresh/only-export-components rejects a module exporting both a
// component and a plain function, and StudyDesk lints at --max-warnings 0.
//
// Was duplicated verbatim in App.jsx and SettingsView.jsx, both returning "·"
// for a guest. Roughly half the user base never signs in, so that interpunct
// was the first thing they saw on every screen — SD-F3.

/** Initials for the account avatar, or null when there is no session — the
 *  caller renders <GuestAvatar/> in that case.
 *
 *  Prefers the name the identity provider gave us and only falls back to the
 *  email. It used to read the email and nothing else, so a Google account whose
 *  profile said "Emil" still rendered the first two letters of the address —
 *  "LI" for limebusiness3@. NCC has always derived from the name; matching it
 *  here is what makes the avatar agree across the suite. Keep the two rules in
 *  step: NCC `userInitials` (store/useSessionStore.ts), LimeLog
 *  `profileInitials` (components/Layout.tsx). */
export function avatarInitials(session) {
  const user = session?.user;
  if (!user) return null;

  const meta = user.user_metadata ?? {};
  const name = String(meta.full_name || meta.name || '').trim();
  if (name) return initialsFromWords(name.split(/\s+/).filter(Boolean));

  const local = (user.email || '').split('@')[0] || '';
  if (!local) return null;
  // Addresses separate words with punctuation rather than spaces.
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  return initialsFromWords(parts) || local.slice(0, 2).toUpperCase() || null;
}

/** Two words → first letter of each. One word → its first two letters. */
function initialsFromWords(parts) {
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

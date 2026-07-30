// Initials for the account avatar. Split from avatar.jsx because
// react-refresh/only-export-components rejects a module exporting both a
// component and a plain function, and StudyDesk lints at --max-warnings 0.
//
// Was duplicated verbatim in App.jsx and SettingsView.jsx, both returning "·"
// for a guest. Roughly half the user base never signs in, so that interpunct
// was the first thing they saw on every screen — SD-F3.

/** Initials for the account avatar, or null when there is no session — the
 *  caller renders <GuestAvatar/> in that case. */
export function avatarInitials(session) {
  const email = session?.user?.email;
  if (!email) return null;
  const local = email.split('@')[0] || '';
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || null;
}

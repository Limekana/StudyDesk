// The avatar shown in the topbar and at the top of Settings.
//
// Was duplicated: identical `avatarInitials` in App.jsx and SettingsView.jsx,
// both returning "·" for a guest. Roughly half the user base never signs in, so
// that interpunct was the first thing they saw on every screen — SD-F3.
//
// Guests now get a silhouette instead. Inline SVG rather than an asset: no
// fetch, no new dependency, and it inherits `currentColor` so it picks up the
// cream-paper palette wherever it is placed, at whatever size the container
// sets.
//
// avatarInitials lives in ./avatarInitials.js — see the note there.

/** Anonymous-profile silhouette. Deliberately not the stock circle-on-a-hump:
 *  the shoulders are cut square and a little wide, which reads as drawn rather
 *  than as a missing image. Sized in `em` so one component serves the 52px
 *  Settings avatar and the smaller topbar button without a size prop. */
export function GuestAvatar({ title }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width="1.15em"
      height="1.15em"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title && <title>{title}</title>}
      <circle cx="16" cy="11.5" r="5.5" />
      <path d="M6.5 26.5v-1.8c0-3.1 2.5-5.6 5.6-5.6h7.8c3.1 0 5.6 2.5 5.6 5.6v1.8" />
    </svg>
  );
}

/**
 * The account avatar, wherever it is drawn.
 *
 * Renders image -> glyph -> initials -> guest silhouette, in that order, from
 * whatever `useAccountAvatar` could actually honour. Takes the resolved value
 * as a prop rather than resolving internally so the topbar and the Settings
 * preview cannot disagree, and so this file keeps exporting only components
 * (react-refresh/only-export-components).
 */
export function AccountAvatar({ avatar, session, className = '' }) {
  const a = avatar || {};
  if (!session) return <GuestAvatar />;
  if (a.kind === 'image' && a.url) {
    return <img src={a.url} alt="" className={`avatar-img ${className}`.trim()} />;
  }
  if (a.kind === 'glyph' && a.glyph) {
    // line-height:1 because the decorative glyphs sit low on their own baseline
    // and the flex centring above them cannot see that - they rendered a couple
    // of pixels under the circle's centre line.
    return <span className="avatar-glyph" aria-hidden="true">{a.glyph}</span>;
  }
  return a.initials ?? <GuestAvatar />;
}

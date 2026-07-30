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

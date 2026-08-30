import { useEffect, useRef, useState } from 'react';

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
    return <GlyphMark glyph={a.glyph} />;
  }
  return a.initials ?? <GuestAvatar />;
}

/**
 * A glyph, optically centred in its circle.
 *
 * Flex centring centres the LINE BOX, and these symbols are not in Playfair
 * Display, so every platform falls back to a different font whose ink sits a
 * different distance from that box's centre. Two CSS-only attempts failed - a
 * `line-height:1` that changed nothing visible, then a constant nudge measured
 * in desktop Chrome, where the glyphs were ALREADY centred to a fifth of a
 * pixel, so the constant simply pushed them a pixel high.
 *
 * So: measure the font that actually rendered, and correct for that. Canvas
 * reports ink extents (`actualBoundingBox*`) and line-box extents
 * (`fontBoundingBox*`) for the same string in the same font; the difference
 * between their midpoints is exactly the error, whatever font the platform
 * chose. Self-correcting on desktop and on an Android WebView alike, with no
 * magic number to go stale.
 */
function GlyphMark({ glyph }) {
  const ref = useRef(null);
  const [dy, setDy] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    // Deferred a frame so the webfont has settled; a measurement taken against
    // a fallback that is about to be replaced would correct for the wrong font.
    const id = requestAnimationFrame(() => {
      try {
        const cs = getComputedStyle(el);
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) return;
        ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
        const m = ctx.measureText(glyph);
        const inkMid = (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
        const boxMid = (m.fontBoundingBoxDescent - m.fontBoundingBoxAscent) / 2;
        const offset = inkMid - boxMid;
        // Sub-pixel corrections are invisible and would only cause a re-render.
        if (!cancelled && Number.isFinite(offset) && Math.abs(offset) >= 0.5) setDy(-offset);
      } catch { /* measurement is an enhancement; an uncentred glyph still renders */ }
    });
    return () => { cancelled = true; cancelAnimationFrame(id); };
  }, [glyph]);

  return (
    <span
      ref={ref}
      className="avatar-glyph"
      aria-hidden="true"
      style={dy ? { transform: `translateY(${dy.toFixed(2)}px)` } : undefined}
    >
      {glyph}
    </span>
  );
}

// v1.9 Item 14, Phase 1 — the desktop shell's tier model.
//
// StudyDesk had exactly one breakpoint (768px): below it a fixed bottom tab
// bar, above it a 240px sidebar and a `.content` column capped at 900px. That
// cap is why a 1920px window rendered the phone layout's information density
// stranded in the middle of the screen with ~500px of dead space on each side.
//
// Three tiers now:
//   phone    < 769px   untouched — bottom tab bar, sidebar display:none
//   tablet   769–1200  sidebar collapses to a 64px icon rail, one content pane
//   desktop  > 1200px  full sidebar, content cap lifts, room for multi-pane
//
// The tier is resolved here in JS rather than left entirely to media queries
// because the desktop surfaces this shell exists to carry — the calendar
// month/week grid, the 3-pane course layout — need to *render* differently per
// tier, not merely restyle, and a media query cannot change what React mounts.
// Resolving it once also keeps base.css free of duplicated
// `@media(tablet) .x, .app.is-rail .x` selector pairs.

import { useCallback, useEffect, useState } from "react";

const TABLET = "(min-width: 769px) and (max-width: 1200px)";
const DESKTOP = "(min-width: 1201px)";

// Keep in sync with base.css. The 768/769 boundary is the app's existing one
// and is deliberately not moved — every mobile rule already keys off it.
function readTier() {
  // Defaults to the phone tier if matchMedia is somehow unavailable: this app
  // ships as an Android WebView first, so the phone layout is the safe render.
  if (typeof window === "undefined" || !window.matchMedia) return "phone";
  if (window.matchMedia(DESKTOP).matches) return "desktop";
  if (window.matchMedia(TABLET).matches) return "tablet";
  return "phone";
}

export function useShellTier() {
  const [tier, setTier] = useState(readTier);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const lists = [window.matchMedia(TABLET), window.matchMedia(DESKTOP)];
    const onChange = () => setTier(readTier());
    lists.forEach((l) => l.addEventListener("change", onChange));
    // A resize that crossed a boundary between first paint and this effect
    // would otherwise leave the initial tier stale, so re-read once on mount.
    onChange();
    return () => lists.forEach((l) => l.removeEventListener("change", onChange));
  }, []);
  return tier;
}

// "rail" | "full" — absent means "follow the tier", which is the default for
// everyone who has never touched the toggle.
const RAIL_KEY = "studydesk-sidebar";

export function useSidebarRail(tier) {
  const [pref, setPref] = useState(() => {
    try {
      const v = localStorage.getItem(RAIL_KEY);
      return v === "rail" || v === "full" ? v : null;
    } catch {
      return null;
    }
  });

  // Auto until the user says otherwise: 768–1200px cannot hold a 240px
  // sidebar and a usable content column at once; above 1200px it can.
  // On phone the sidebar is display:none, so this value is inert there.
  const rail = pref ? pref === "rail" : tier === "tablet";

  const toggleRail = useCallback(() => {
    const next = rail ? "full" : "rail";
    try {
      localStorage.setItem(RAIL_KEY, next);
    } catch {
      /* private mode / quota — the toggle still works for this session */
    }
    setPref(next);
  }, [rail]);

  return [rail, toggleRail];
}

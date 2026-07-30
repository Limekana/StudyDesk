// v1.8 / ACT-6 — keep the active option visible inside a scroll-capped list.
//
// The language grids are capped at ~3.5 rows so a ten-language list can't push
// surrounding controls below the fold. That cap creates a trap: with the list
// scrolled to the top, a user whose device already resolved to (say) Hindi opens
// the picker, sees English/Suomi/Français, and concludes their language isn't
// offered. Scrolling the selected option into view on mount removes it.
//
// Attach the returned ref to the scrolling container. Options must carry
// `aria-pressed="true"` on the active one, which the pickers already do.
//
// Why not `scrollIntoView({ block: 'nearest' })`: it was measured leaving the
// last row ~10px short. The effect runs before the self-hosted display font has
// swapped in, rows then grow, and the scroll position it computed is stale.
// So we do the math against live rects and re-apply after layout settles —
// once on the next frame, and again when fonts finish loading.

import { useEffect, useRef } from 'react';

export function useScrollSelectedIntoView() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reveal = () => {
      const selected = el.querySelector('[aria-pressed="true"]');
      if (!selected) return;
      const box = el.getBoundingClientRect();
      const target = selected.getBoundingClientRect();
      // Container-relative, so it never scrolls the page.
      if (target.bottom > box.bottom) el.scrollTop += target.bottom - box.bottom;
      else if (target.top < box.top) el.scrollTop -= box.top - target.top;
    };

    reveal();
    const raf = requestAnimationFrame(reveal);
    // Fonts change row height; re-run once they're in. Guarded — jsdom and
    // older WebViews don't implement document.fonts.
    void document.fonts?.ready.then(reveal).catch(() => {});

    return () => cancelAnimationFrame(raf);
  }, []);

  return ref;
}

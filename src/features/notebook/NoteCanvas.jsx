// The page as a surface you can put boxes on.
//
// Asked for directly: "the text boxes should be placeable where I want".
// Before this a note was one column pinned at the margin rule, which is the
// right shape for prose and the wrong one for the thing people actually do in
// a maths or physics notebook — a worked example on the left, a definition
// beside it, a diagram's labels off to the side.
//
// ── What this file owns, and what it deliberately does not ───────────────
//
// It owns the PAGE: the ruling, the scroll, where boxes sit, and the gestures
// that move and size them. It owns no text. Inside every box is the existing
// `NoteEditor`, unchanged in every respect that matters — the same markdown
// blocks, the same single-textarea reveal, the same IME guards. That split is
// the point: the editor is the part of this feature that is genuinely
// dangerous to touch (Android composition state, caret position, autocorrect)
// and it is the part this feature does not need to change.
//
// ── Gestures ─────────────────────────────────────────────────────────────
//
// Pointer events throughout, not mouse events, because the primary device is
// a phone. `setPointerCapture` so a fast drag that leaves the handle does not
// drop the box mid-move, and `touch-action: none` on the grips so dragging a
// box sideways does not scroll the page underneath it.
//
// A drag previews in local state and commits once on release. Committing on
// every move would push a note revision through the reducer, the persist
// effect and the sync outbox sixty times a second.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import NoteEditor from './NoteEditor.jsx';
import { GRID, MIN_W, MAX_W, DEFAULT_W, TRAILING_ROWS, makeBox, snapY, pageHeight } from './layout.js';

/** The element that scrolls the page. The notebook does not scroll itself; an
 *  app-level container (or the document) does, and which one depends on the
 *  shell, so it is found rather than assumed. */
function scrollParent(el) {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
  }
  return document.documentElement;
}

export default function NoteCanvas({
  boxes,
  onChange,
  onInsertPhoto,
  photoUrls,
  onOpenPhoto,
}) {
  const { t } = useTranslation();
  const pageRef = useRef(null);

  // The box to autofocus once, right after it is created by a tap. Held in a
  // ref as well as state: the ref is what the render reads, the state is only
  // there to trigger the render that mounts the box.
  const [createdId, setCreatedId] = useState(null);

  // A move or resize in flight. Local so the drag is smooth; `onChange` fires
  // once, on release.
  const [drag, setDrag] = useState(null);

  // Which box holds the caret. Handles are hidden on it while typing — a grip
  // sitting under a thumb that is reaching for the text is the fastest way to
  // move a box by accident.
  const [typingIn, setTypingIn] = useState(null);

  const pageWidth = () => pageRef.current?.getBoundingClientRect().width || 1;

  // ── The endless sheet (StudyDesk#111) ───────────────────────────────────
  //
  // The writable area has to reach well below the lowest box's BOTTOM, and
  // fill the paper in the window. Boxes are absolutely positioned, so the page
  // cannot learn their heights from layout; they are measured instead.
  const [heights, setHeights] = useState({});
  const [paper, setPaper] = useState({ fill: 0, trailing: TRAILING_ROWS * GRID });
  const resizeObs = useRef(null);
  const boxEls = useRef(new Set());

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next = prev;
        for (const entry of entries) {
          const id = entry.target.dataset.boxId;
          const h = Math.round(entry.target.getBoundingClientRect().height);
          if (id && prev[id] !== h) {
            if (next === prev) next = { ...prev };
            next[id] = h;
          }
        }
        return next;
      });
    });
    resizeObs.current = ro;
    for (const el of boxEls.current) ro.observe(el);
    return () => { ro.disconnect(); resizeObs.current = null; };
  }, []);

  // Stable, so React attaches it once per box rather than on every render;
  // the returned cleanup (React 19) runs when the box unmounts.
  const observeBox = useCallback((el) => {
    if (!el) return undefined;
    boxEls.current.add(el);
    resizeObs.current?.observe(el);
    return () => {
      boxEls.current.delete(el);
      resizeObs.current?.unobserve(el);
    };
  }, []);

  useEffect(() => {
    const area = pageRef.current;
    if (!area) return undefined;
    const scroller = scrollParent(area);
    const isDoc = scroller === document.documentElement;
    const measure = () => {
      const viewH = isDoc ? window.innerHeight : scroller.clientHeight;
      // The area's offset inside the scrolled content, independent of how far
      // it is scrolled right now.
      const top = area.getBoundingClientRect().top
        - (isDoc ? 0 : scroller.getBoundingClientRect().top)
        + (isDoc ? window.scrollY : scroller.scrollTop);
      const fill = Math.max(0, Math.round(viewH - top));
      const trailing = Math.max(TRAILING_ROWS * GRID, Math.round(window.innerHeight * 0.4));
      setPaper((p) => (Math.abs(p.fill - fill) > 1 || p.trailing !== trailing ? { fill, trailing } : p));
    };
    const raf = requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(scroller);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, []);

  const commit = useCallback((next) => { onChange(next); }, [onChange]);

  const patchBox = useCallback((id, patch) => {
    commit(boxes.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, [boxes, commit]);

  const setText = useCallback((id, text) => {
    commit(boxes.map((b) => (b.id === id ? { ...b, text } : b)));
  }, [boxes, commit]);

  // ── Creating ────────────────────────────────────────────────────────────
  //
  // Only a press that lands on the page ITSELF, not on a box. `preventDefault`
  // for the reason Block.jsx gives: without it the browser's default focus
  // handling blurs the textarea we are about to mount, and the new box closes
  // inside the same tap that opened it.
  const onPagePointerDown = useCallback((e) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const w = rect.width || 1;
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top + e.currentTarget.scrollTop;
    // Placed so the tap is the box's TOP-LEFT, which is where a person expects
    // the caret to appear. Clamped so a tap near the right edge still yields a
    // box wide enough to type in rather than a sliver.
    const x = Math.min(Math.max(px / w, 0), 1 - MIN_W);
    const width = Math.min(DEFAULT_W, MAX_W - x);
    const box = makeBox({ x, y: py, w: width });
    setCreatedId(box.id);
    commit([...boxes, box]);
  }, [boxes, commit]);

  // ── Moving and resizing ─────────────────────────────────────────────────

  const startDrag = useCallback((e, id, mode) => {
    e.preventDefault();
    e.stopPropagation();
    const box = boxes.find((b) => b.id === id);
    if (!box) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older WebView */ }
    setDrag({
      id, mode,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: box.x,
      originY: box.y,
      originW: box.w,
      x: box.x, y: box.y, w: box.w,
    });
  }, [boxes]);

  const onDragMove = useCallback((e) => {
    setDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d;
      const w = pageWidth();
      const dx = (e.clientX - d.startX) / w;
      const dy = e.clientY - d.startY;
      if (d.mode === 'resize') {
        // The left edge stays put, so the width can grow only as far as the
        // page edge.
        const next = Math.min(Math.max(d.originW + dx, MIN_W), MAX_W - d.originX);
        return { ...d, w: next };
      }
      const nx = Math.min(Math.max(d.originX + dx, 0), MAX_W - d.originW);
      return { ...d, x: nx, y: snapY(d.originY + dy) };
    });
  }, []);

  const endDrag = useCallback((e) => {
    setDrag((d) => {
      if (!d || d.pointerId !== e.pointerId) return d;
      if (d.mode === 'resize') patchBox(d.id, { w: d.w });
      else patchBox(d.id, { x: d.x, y: d.y });
      return null;
    });
  }, [patchBox]);

  // ── Litter ──────────────────────────────────────────────────────────────
  //
  // A box tapped open and then abandoned with nothing typed in it is not a
  // box the user wants; it is a mis-tap. Swept when the caret leaves it, never
  // while it still has focus, and never the last one — a note with no box at
  // all has nowhere to put the caret back.
  const sweep = useCallback((id) => {
    const box = boxes.find((b) => b.id === id);
    if (!box || box.text.trim() !== '' || boxes.length < 2) return;
    commit(boxes.filter((b) => b.id !== id));
  }, [boxes, commit]);

  // Consumed once. Without clearing it, every later re-render would re-assert
  // autoFocus on a box the user may have long since left.
  useEffect(() => {
    if (!createdId) return;
    const id = window.setTimeout(() => setCreatedId(null), 0);
    return () => window.clearTimeout(id);
  }, [createdId]);

  // The box being dragged counts where it is being dragged TO, so the page
  // grows under it and it can be carried below the current end.
  const placed = drag ? boxes.map((b) => (b.id === drag.id ? { ...b, y: drag.y } : b)) : boxes;
  const minHeight = pageHeight(placed, heights, paper);

  return (
    <div className="nb-page-wrap">
      <div className="nb-canvas nb-page">
      {/* The writable area starts AT the margin rule, and `x` is a fraction of
          it rather than of the whole page. Two reasons, both about not
          breaking what already works: a note written before free placement
          sits at x=0 and must keep landing exactly where it always did, right
          of the rule — otherwise every existing note shifts left on upgrade —
          and the margin stays a margin, which is most of what makes this look
          like paper rather than a canvas app.

          A separate element because an absolutely positioned child is placed
          against its ancestor's PADDING box: padding on the page would not
          move `left: 0` at all. */}
      <div
        ref={pageRef}
        className="nb-canvas-area"
        onPointerDown={onPagePointerDown}
        style={{ minHeight: `${minHeight}px` }}
      >
        {boxes.map((b) => {
          const live = drag && drag.id === b.id ? drag : b;
          return (
            <div
              key={b.id}
              ref={observeBox}
              data-box-id={b.id}
              className={`nb-box${drag?.id === b.id ? ' is-dragging' : ''}${typingIn === b.id ? ' is-typing' : ''}`}
              style={{
                left: `${live.x * 100}%`,
                top: `${live.y}px`,
                width: `${live.w * 100}%`,
              }}
            >
              <NoteEditor
                embedded
                ariaLabel={t('nb.box')}
                key={b.id}
                value={b.text}
                onChange={(text) => setText(b.id, text)}
                onInsertPhoto={onInsertPhoto}
                photoUrls={photoUrls}
                onOpenPhoto={onOpenPhoto}
                autoFocus={createdId === b.id}
                onFocusChange={(has) => {
                  setTypingIn((cur) => {
                    if (has) return b.id;
                    return cur === b.id ? null : cur;
                  });
                  if (!has) sweep(b.id);
                }}
              />
              {/* The handles. Rendered after the editor so they paint over it,
                  and hidden by CSS while this box holds the caret. */}
              <button
                type="button"
                className="nb-box-handle"
                aria-label={t('nb.moveBox')}
                onPointerDown={(e) => startDrag(e, b.id, 'move')}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <span aria-hidden="true">⠿</span>
              </button>
              <button
                type="button"
                className="nb-box-grip"
                aria-label={t('nb.resizeBox')}
                onPointerDown={(e) => startDrag(e, b.id, 'resize')}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              />
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

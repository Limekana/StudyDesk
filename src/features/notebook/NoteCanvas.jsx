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
import {
  GRID, MIN_W, MAX_W, DEFAULT_W, TRAILING_ROWS, makeBox, pageHeight, moveTo, resizeTo, settle,
} from './layout.js';

/** How far a mouse press on a box travels before it is a move, not a click. */
const DRAG_SLOP = 4;
/** Within this many px of the window's top or bottom, a drag scrolls the page. */
const SCROLL_EDGE = 48;

const widthOf = (el) => el?.getBoundingClientRect().width || 1;
/** Events from the handle and grip bubble to the box; they run their own drag. */
const fromGrip = (e) => !!e.target.closest?.('.nb-box-handle, .nb-box-grip');
const scrollTopOf = (s) => (!s ? 0 : s === document.documentElement ? window.scrollY : s.scrollTop);

/** A drag in flight, moved to a pointer position. The page may have scrolled
 *  since the drag began, and the box travels with the scroll. */
function project(d, clientX, clientY, pageW, scrollNow) {
  const dx = (clientX - d.startX) / pageW;
  const dy = clientY - d.startY + (scrollNow - d.scroll0);
  const next = d.mode === 'resize'
    ? resizeTo({ x: d.originX, w: d.originW }, dx)
    : moveTo({ x: d.originX, y: d.originY, w: d.originW }, dx, dy);
  return { ...d, ...next, lastX: clientX, lastY: clientY };
}

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
    // And the area itself: on a phone the canvas stays mounted but hidden
    // behind the note list, and a fill measured while hidden (top 0) was never
    // redone when it came back (StudyDesk#131).
    ro?.observe(area);
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
  // Only a tap or click that lands on the page ITSELF, not on a box. On
  // `click`, not `pointerdown` (StudyDesk#131): a finger that starts a scroll
  // on empty paper sends pointerdown before the browser knows it is a pan, so
  // every scroll over the paper started a box and raised the keyboard. A pan
  // never ends in a click. By the time a click arrives the browser's own focus
  // handling for the press is over, so it no longer blurs the box this mounts.
  const onPageClick = useCallback((e) => {
    if (e.target !== e.currentTarget) return;
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

  // ── Moving and resizing (StudyDesk#112) ─────────────────────────────────
  //
  // The maths is in layout.js (moveTo / resizeTo / settle, tested): the box
  // follows the pointer and only snaps to a rule on release, and a full-width
  // box narrows against the page edge instead of refusing to move. This part
  // is where the gesture comes from, and auto-scroll.

  const scrollerRef = useRef(null);
  const dragRef = useRef(null);
  useEffect(() => { dragRef.current = drag; });

  const beginDrag = useCallback((id, mode, pointerId, clientX, clientY) => {
    const box = boxes.find((b) => b.id === id);
    if (!box) return;
    scrollerRef.current = scrollParent(pageRef.current);
    setDrag({
      id, mode, pointerId,
      startX: clientX, startY: clientY, lastX: clientX, lastY: clientY,
      scroll0: scrollTopOf(scrollerRef.current),
      originX: box.x, originY: box.y, originW: box.w,
      x: box.x, y: box.y, w: box.w,
    });
  }, [boxes]);

  // The handle and the grip: an explicit grab, on every device.
  const startDrag = useCallback((e, id, mode) => {
    e.preventDefault();
    e.stopPropagation();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older WebView */ }
    beginDrag(id, mode, e.pointerId, e.clientX, e.clientY);
  }, [beginDrag]);

  const onDragMove = useCallback((e) => {
    setDrag((d) => (!d || d.pointerId !== e.pointerId
      ? d
      : project(d, e.clientX, e.clientY, widthOf(pageRef.current), scrollTopOf(scrollerRef.current))));
  }, []);

  // Released: the final position is projected from the release itself, so it
  // does not depend on the last pointermove having rendered, and the note is
  // written outside any state updater (React warns about a dispatch inside
  // one, and StrictMode would send it twice). A release where it started
  // writes nothing (StudyDesk#131).
  const endDrag = useCallback((e) => {
    const d = dragRef.current;
    setDrag((cur) => (cur && cur.pointerId === e.pointerId ? null : cur));
    if (!d || d.pointerId !== e.pointerId) return;
    const fin = project(d, e.clientX, e.clientY, widthOf(pageRef.current), scrollTopOf(scrollerRef.current));
    const rest = d.mode === 'resize' ? { x: d.originX, y: d.originY, w: fin.w } : settle(fin);
    if (rest.x === d.originX && rest.y === d.originY && rest.w === d.originW) return;
    patchBox(d.id, d.mode === 'resize' ? { w: rest.w } : rest);
  }, [patchBox]);

  // The box itself, with a mouse or pen, when it is not being typed in: a
  // press is held back until it is clear whether it is a drag or a click. A
  // click is replayed to the block it landed on, so the editor opens exactly
  // as it always has (Block opens it on mousedown). Touch is left alone, so a
  // finger on a box still scrolls the page; the handle moves it there.
  const pressRef = useRef(null);

  // A cancelled pointer (a pen pan, an OS gesture) puts the box back where it
  // was and opens nothing; it used to commit the half-done move like a
  // release (StudyDesk#131).
  const cancelDrag = useCallback((e) => {
    if (pressRef.current?.pointerId === e.pointerId) pressRef.current = null;
    setDrag((cur) => (cur && cur.pointerId === e.pointerId ? null : cur));
  }, []);

  const onBoxPointerDown = useCallback((e, id) => {
    if (e.pointerType === 'touch' || e.button !== 0) return;
    if (typingIn === id) return; // while typing, a drag selects text, as in any editor
    // `button` covers the checkbox. `.nb-check` also matched the whole
    // checklist LINE, so a checklist could not be picked up by its text (#131).
    if (e.target.closest('button, a, input, select, textarea, .nb-photo')) return;
    e.preventDefault(); // holds back the mousedown, and with it the editor
    pressRef.current = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY, target: e.target, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older WebView */ }
  }, [typingIn]);

  const onBoxPointerMove = useCallback((e) => {
    if (fromGrip(e)) return; // the handle and grip run their own drag
    const p = pressRef.current;
    if (p && !p.moved && p.pointerId === e.pointerId
        && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_SLOP) {
      p.moved = true;
      beginDrag(p.id, 'move', e.pointerId, p.x, p.y);
    }
    onDragMove(e);
  }, [beginDrag, onDragMove]);

  const onBoxPointerUp = useCallback((e) => {
    if (fromGrip(e)) return;
    const p = pressRef.current;
    pressRef.current = null;
    if (p && !p.moved && p.pointerId === e.pointerId) {
      p.target.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0, clientX: e.clientX, clientY: e.clientY,
      }));
      return;
    }
    endDrag(e);
  }, [endDrag]);

  // Held at the top or bottom edge of the window, the page scrolls, and the
  // box goes with it: without this a box could only travel as far as the
  // screen showed.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return undefined;
    let raf = 0;
    let last = 0;
    // The bottom edge is the bottom of what can be SEEN: on a phone the tab
    // bar (or the docked format bar) covers the bottom of the scroller, and an
    // edge zone measured from the scroller sat behind it (StudyDesk#131).
    const covers = [...document.querySelectorAll('.mobile-tabbar, body > .nb-bar')]
      .filter((el) => getComputedStyle(el).display !== 'none')
      .map((el) => el.getBoundingClientRect().top);
    const tick = (ts) => {
      raf = requestAnimationFrame(tick);
      // Per millisecond, not per frame, so a 120 Hz screen does not scroll
      // twice as fast as a 60 Hz one.
      const dt = last ? Math.min(ts - last, 50) : 16;
      last = ts;
      const d = dragRef.current;
      const s = scrollerRef.current;
      if (!d || !s || d.mode !== 'move') return;
      const isDoc = s === document.documentElement;
      const top = isDoc ? 0 : s.getBoundingClientRect().top;
      const bottom = Math.min(isDoc ? window.innerHeight : s.getBoundingClientRect().bottom, ...covers);
      let speed = 0;
      if (d.lastY > bottom - SCROLL_EDGE) speed = Math.min(d.lastY - (bottom - SCROLL_EDGE), SCROLL_EDGE) / 3;
      else if (d.lastY < top + SCROLL_EDGE) speed = -Math.min(top + SCROLL_EDGE - d.lastY, SCROLL_EDGE) / 3;
      const step = Math.sign(speed) * Math.ceil(Math.abs(speed) * (dt / 16));
      if (!step) return;
      if (isDoc) window.scrollBy(0, step); else s.scrollTop += step;
      setDrag((cur) => (cur
        ? project(cur, cur.lastX, cur.lastY, widthOf(pageRef.current), scrollTopOf(s))
        : cur));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragging]);

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
  // Grows under a box carried down, but never shrinks under one carried up:
  // shrinking clamped the scroll at the end of the page, and the box stalled
  // under the pointer (StudyDesk#131).
  const restHeight = pageHeight(boxes, heights, paper);
  const minHeight = drag ? Math.max(restHeight, pageHeight(placed, heights, paper)) : restHeight;

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
        onClick={onPageClick}
        style={{ minHeight: `${minHeight}px` }}
      >
        {boxes.map((b) => {
          const live = drag && drag.id === b.id ? drag : b;
          return (
            <div
              key={b.id}
              ref={observeBox}
              data-box-id={b.id}
              onPointerDown={(e) => onBoxPointerDown(e, b.id)}
              onPointerMove={onBoxPointerMove}
              onPointerUp={onBoxPointerUp}
              onPointerCancel={cancelDrag}
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
                onPointerCancel={cancelDrag}
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
                onPointerCancel={cancelDrag}
              />
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}

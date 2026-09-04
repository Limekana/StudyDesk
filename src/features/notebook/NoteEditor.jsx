// The page. Rendered blocks, one textarea for the block the caret is in.
//
// See model.js for the architecture and why the focused block is a plain
// textarea rather than a contenteditable with span-level reveal. Everything
// here follows from that one decision: nothing rewrites the element the user
// is typing into, so an IME's composition is never disturbed.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Block from './Block.jsx';
import FormatBar from './FormatBar.jsx';
import { BLOCK, parse, serialize, serializeBlock, numbering } from './model.js';
import { MARK, toggleMark, clearMarks } from './inline.js';
import {
  matchBlockRule, applyBlockRule, undoBlockRule,
  enterBehaviour, indentBehaviour, backspaceAtStart, isList,
} from './inputRules.js';
import { useKeyboardInset } from './useKeyboardInset.js';
import { isComposing, compositionTracking } from '../../lib/imeSubmit.js';

// Desktop shortcuts, §5. Word/Docs conventions, unchanged — people arrive
// already knowing these and an app that reassigns them is picking a fight it
// cannot win.
function matchShortcut(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const k = e.key.toLowerCase();

  if (e.altKey) {
    if (k === '1') return { kind: 'block', type: BLOCK.H1 };
    if (k === '2') return { kind: 'block', type: BLOCK.H2 };
    return null;
  }
  if (e.shiftKey) {
    if (k === 'h') return { kind: 'mark', mark: MARK.HL, role: 1 };
    if (k === '*' || k === '8') return { kind: 'block', type: BLOCK.BULLET };
    if (k === '&' || k === '7') return { kind: 'block', type: BLOCK.NUMBER };
    if (k === '(' || k === '9') return { kind: 'block', type: BLOCK.CHECK };
    if (k === 'p') return { kind: 'photo' };
    if (k === 'm') return { kind: 'span', open: '$', close: '$' };
    if (k === 'e') return { kind: 'span', open: '$$', close: '$$' };
    return null;
  }
  if (k === 'b') return { kind: 'mark', mark: MARK.BOLD };
  if (k === 'i') return { kind: 'mark', mark: MARK.ITALIC };
  if (k === 'u') return { kind: 'mark', mark: MARK.UNDERLINE };
  if (k === '\\') return { kind: 'clear' };
  // ime-ok: this matcher is pure and is only ever reached from NoteEditor's
  // keydown, which returns on `isComposing(e, el)` before calling it. It is
  // also mod-gated — every branch above requires Ctrl/Cmd — so the keystroke
  // is Ctrl+Enter, not the bare Enter an IME commits with.
  if (e.key === 'Enter') return { kind: 'toggleCheck' };
  return null;
}

export default function NoteEditor({
  value,
  onChange,
  onInsertPhoto,
  photoUrls,
  onOpenPhoto,
  autoFocus,
}) {
  const { t } = useTranslation();

  const blocks = useMemo(() => parse(value), [value]);
  const numbers = useMemo(() => numbering(blocks), [blocks]);

  // Which block the caret is in. `-1` means none, which is the read state —
  // no chrome over the page at all (§4).
  const [focus, setFocus] = useState(autoFocus ? 0 : -1);
  const [draft, setDraft] = useState('');
  const taRef = useRef(null);
  // The undo record for constraint 2 in inputRules.js: Backspace immediately
  // after a rule fires restores the literal characters. Held in a ref rather
  // than state because it must not survive into the next render as a stale
  // value, and reading it does not need to re-render anything.
  const pendingUndo = useRef(null);
  const [swatches, setSwatches] = useState(false);

  useKeyboardInset(focus >= 0);

  // Entering a block loads its SOURCE into the textarea. This is the reveal.
  //
  // Adjusted DURING RENDER rather than in an effect — React's own documented
  // pattern for "a piece of state derived from a changing key" (the
  // `prevProp` idiom in "You Might Not Need an Effect"). An effect would
  // render once with the previous block's text in the textarea and then
  // immediately render again with the right text, which is a visible flash of
  // the wrong line's source on a slow phone, and on a fast one is still a
  // wasted render of the one component the user is typing into.
  //
  // The guard is `focus !== draftFor`, not `focus` alone, so re-rendering for
  // any other reason does NOT clobber what the user has typed since.
  const [draftFor, setDraftFor] = useState(-1);
  if (focus !== draftFor) {
    setDraftFor(focus);
    setDraft(focus >= 0 && blocks[focus] ? serializeBlock(blocks[focus]) : '');
    // `pendingUndo` is deliberately NOT cleared here. A ref must not be
    // written during render, and it does not need to be: the Backspace
    // handler already requires `p.at === focus`, so a record left over from
    // another block can never fire. Clearing it on the next keystroke is both
    // legal and more correct — see `onInput`.
  }

  // Autosize: the textarea has to occupy exactly the height the rendered block
  // would, or the page jumps every time the caret moves. Measured rather than
  // computed from line count, because wrapping depends on the measure.
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => { autosize(); }, [draft, autosize]);

  useEffect(() => {
    if (focus < 0) return;
    const el = taRef.current;
    if (el) { el.focus(); autosize(); }
  }, [focus, autosize]);

  // ── Committing ──────────────────────────────────────────────────────────
  //
  // The whole note is rebuilt from blocks each time. Cheap (a note is tens of
  // lines, not thousands) and it keeps ONE source of truth: the string. A
  // diffing commit would introduce a second representation that could drift.
  const commit = useCallback((nextBlocks, nextFocus) => {
    onChange(serialize(nextBlocks));
    if (nextFocus !== undefined) setFocus(nextFocus);
  }, [onChange]);

  const commitDraft = useCallback((text, nextFocus) => {
    const next = [...blocks];
    // `parse` on a single line gives the block back with its type re-derived
    // from the markers, which is what makes typing `## ` at the front of an
    // existing line work without a special case.
    //
    // ── Multi-line commits (v1.13 review, blocker 6) ────────────────────
    //
    // This took `parse(text)[0]` and dropped everything after it. The
    // textarea holds ONE block, so the only way it acquires a newline is a
    // paste — and pasting three pages of lecture notes silently kept the
    // first line and threw the rest away on blur. Splitting here rather than
    // in a paste handler covers every route text can arrive by, including
    // Android keyboards that insert clipboard content without firing a
    // `paste` event this component can read.
    const parsed = parse(text);
    if (parsed.length > 1) {
      const rebuilt = parsed.map((b, i) => ({ ...b, id: focus + i }));
      next.splice(focus, 1, ...rebuilt);
      // Land the caret at the end of what was pasted, which is where the
      // user expects to keep typing.
      commit(next, nextFocus === -1 ? -1 : focus + rebuilt.length - 1);
      return;
    }
    next[focus] = { ...parsed[0], id: focus };
    commit(next, nextFocus);
  }, [blocks, focus, commit]);

  const blurToRead = useCallback(() => {
    if (focus >= 0) commitDraft(draft, -1);
  }, [focus, draft, commitDraft]);

  // ── Typing ──────────────────────────────────────────────────────────────

  const onInput = useCallback((e) => {
    const text = e.target.value;
    const caret = e.target.selectionStart;
    setDraft(text);

    // Input rules fire on the character that completes them — never on a
    // timer (§5 constraint 3).
    const [asBlock] = parse(text);
    const match = matchBlockRule({ ...asBlock, text }, caret);
    if (match) {
      const next = [...blocks];
      next[focus] = applyBlockRule({ ...next[focus], id: focus }, match);
      pendingUndo.current = { at: focus, undo: match.undo };
      setDraft(serializeBlock(next[focus]));
      onChange(serialize(next));
      return;
    }

    // §5 is precise: Backspace undoes a rule "IMMEDIATELY after" it fires.
    // Any other keystroke in between and the user has moved on, so the record
    // is dropped — otherwise typing a list item and then Backspacing to the
    // start of it would surprise them by dissolving the bullet they wanted.
    pendingUndo.current = null;
  }, [blocks, focus, onChange]);

  // ── Keys ────────────────────────────────────────────────────────────────

  const onKeyDown = useCallback((e) => {
    const el = e.target;
    const at = el.selectionStart;
    const to = el.selectionEnd;

    // Composition guard, and it is the FIRST thing this handler does. While an
    // IME is composing, every key belongs to the IME: Enter commits the
    // candidate, Tab cycles it, Backspace deletes from its buffer. Every
    // branch below would steal one of those.
    //
    // Routed through the shared helper rather than checked inline. The inline
    // version this replaces tested `isComposing` and keyCode 229 — two of the
    // three signals — and missed the one the helper exists for: some Android
    // WebView builds have already cleared `isComposing` by the time keydown is
    // dispatched, which is #35 reappearing through the very check meant to
    // catch it. The third signal is a flag we maintain ourselves, from
    // `compositionTracking()` on the textarea below.
    if (isComposing(e, el)) return;

    const sc = matchShortcut(e);
    if (sc) {
      e.preventDefault();
      if (sc.kind === 'mark') {
        const r = toggleMark(draft, at, to, sc.mark, sc.role);
        setDraft(r.source);
        requestAnimationFrame(() => el.setSelectionRange(r.start, r.end));
      } else if (sc.kind === 'clear') {
        const r = clearMarks(draft, at, to);
        setDraft(r.source);
        requestAnimationFrame(() => el.setSelectionRange(r.start, r.end));
      } else if (sc.kind === 'block') {
        const next = [...blocks];
        // Same fix as the format bar's `block` branch — this path had the
        // identical stale-block bug, reached by Ctrl+Shift+8 rather than by
        // tapping. See the comment there.
        const [live] = parse(draft);
        const cur = { ...live, id: focus };
        // Pressing the same block shortcut twice returns to a paragraph, which
        // is what every editor does and what people try first to undo it.
        const type = cur.type === sc.type ? BLOCK.P : sc.type;
        next[focus] = { ...cur, type, checked: false };
        setDraft(serializeBlock(next[focus]));
        onChange(serialize(next));
      } else if (sc.kind === 'span') {
        const sel = draft.slice(at, to);
        const inserted = `${sc.open}${sel}${sc.close}`;
        const source = draft.slice(0, at) + inserted + draft.slice(to);
        setDraft(source);
        const caret = at + sc.open.length + sel.length;
        requestAnimationFrame(() => el.setSelectionRange(caret, caret));
      } else if (sc.kind === 'toggleCheck') {
        const next = [...blocks];
        // And here — Ctrl+Enter on a checklist item would have dropped
        // whatever had been typed into it since the last commit.
        const [live] = parse(draft);
        const cur = { ...live, id: focus };
        if (cur.type === BLOCK.CHECK) {
          next[focus] = { ...cur, checked: !cur.checked };
          setDraft(serializeBlock(next[focus]));
          onChange(serialize(next));
        }
      } else if (sc.kind === 'photo') {
        onInsertPhoto?.();
      }
      return;
    }

    // Esc leaves a span / the editor without moving the caret to end of line
    // (§11's third shortcut).
    if (e.key === 'Escape') {
      e.preventDefault();
      commitDraft(draft, -1);
      el.blur();
      return;
    }

    // ime-ok: guarded by the single `isComposing(e, el)` early return at the
    // top of this handler. One guard covers Enter, Tab and Backspace together,
    // which is what this handler needs — a per-branch check would leave the
    // other two keys open.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const cur = { ...parse(draft)[0], id: focus };
      const behaviour = enterBehaviour(cur);
      const next = [...blocks];

      if (behaviour.action === 'exit') {
        next[focus] = { ...cur, type: BLOCK.P, indent: 0, checked: false, text: '' };
        commit(next, focus);
        setDraft('');
        return;
      }
      if (behaviour.action === 'outdent') {
        next[focus] = { ...cur, indent: (cur.indent || 0) - 1 };
        commit(next, focus);
        setDraft(serializeBlock(next[focus]));
        return;
      }

      // Split at the caret, so Enter mid-line behaves like Enter mid-line.
      const head = draft.slice(0, at);
      const tail = draft.slice(at);
      const [headBlock] = parse(head);
      next[focus] = { ...headBlock, id: focus };
      next.splice(focus + 1, 0, {
        id: focus + 1,
        type: behaviour.type,
        indent: behaviour.indent,
        checked: behaviour.checked ?? false,
        // The tail keeps its text but not the head's marker — parse would
        // otherwise re-read a `- ` that the split moved.
        text: parse(tail)[0].text,
      });
      commit(next, focus + 1);
      return;
    }

    if (e.key === 'Tab') {
      const cur = { ...parse(draft)[0], id: focus };
      const next = indentBehaviour(cur, e.shiftKey);
      if (!next) return; // not a list — let Tab move focus normally
      e.preventDefault();
      const all = [...blocks];
      all[focus] = next;
      commit(all, focus);
      setDraft(serializeBlock(next));
      return;
    }

    if (e.key === 'Backspace' && at === 0 && to === 0) {
      // §5 constraint 2 — undo a rule that just fired, restoring the literal
      // characters. Checked before the structural behaviour, because the user
      // is undoing the LAST thing that happened.
      const p = pendingUndo.current;
      if (p && p.at === focus) {
        e.preventDefault();
        const all = [...blocks];
        all[focus] = undoBlockRule({ ...all[focus], id: focus }, p.undo);
        pendingUndo.current = null;
        commit(all, focus);
        setDraft(p.undo.text);
        return;
      }

      const cur = { ...parse(draft)[0], id: focus };
      const behaviour = backspaceAtStart(cur);
      if (behaviour.action !== 'merge') {
        e.preventDefault();
        const all = [...blocks];
        all[focus] = behaviour.block;
        commit(all, focus);
        setDraft(serializeBlock(behaviour.block));
        return;
      }
      if (focus > 0) {
        e.preventDefault();
        const all = [...blocks];
        const prev = { ...all[focus - 1] };
        const caret = prev.text.length;
        prev.text += cur.text;
        all[focus - 1] = prev;
        all.splice(focus, 1);
        commit(all, focus - 1);
        setDraft(serializeBlock(prev));
        requestAnimationFrame(() => {
          const el2 = taRef.current;
          if (el2) {
            const off = serializeBlock(prev).length - prev.text.length + caret;
            el2.setSelectionRange(off, off);
          }
        });
      }
      return;
    }

    // Arrow out of the top / bottom of a block moves to the neighbour, which
    // is what makes the page feel like one document rather than a stack of
    // fields.
    if (e.key === 'ArrowUp' && at === 0 && focus > 0) {
      e.preventDefault();
      commitDraft(draft, focus - 1);
      return;
    }
    if (e.key === 'ArrowDown' && at === draft.length && focus < blocks.length - 1) {
      e.preventDefault();
      commitDraft(draft, focus + 1);
    }
  }, [draft, blocks, focus, commit, commitDraft, onChange, onInsertPhoto]);

  // ── Bar actions ─────────────────────────────────────────────────────────

  const applyFromBar = useCallback((action, arg) => {
    const el = taRef.current;
    if (!el) return;
    const at = el.selectionStart;
    const to = el.selectionEnd;

    if (action === 'mark') {
      const r = toggleMark(draft, at, to, arg.mark, arg.role);
      setDraft(r.source);
      // The bar must not steal focus — losing it would dismiss the keyboard
      // and the bar with it, which on a phone means the control disappears as
      // you press it.
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(r.start, r.end); });
      return;
    }
    if (action === 'block') {
      const next = [...blocks];
      // From `draft`, NOT from `blocks`. v1.13 review, blocker 5.
      //
      // `blocks` is `parse(value)` — the COMMITTED note. Everything typed
      // since the last commit lives only in `draft`, so reading the block out
      // of `blocks` here discarded it, and the `setDraft` below then wiped it
      // from the textarea as well. Type a line, tap `•`, and the line was
      // gone with no undo. On Android this bar is the only way to set a block
      // type, so it was the primary path, not an edge case.
      const [live] = parse(draft);
      const cur = { ...live, id: focus };
      next[focus] = { ...cur, type: cur.type === arg ? BLOCK.P : arg, checked: false };
      setDraft(serializeBlock(next[focus]));
      onChange(serialize(next));
      requestAnimationFrame(() => el.focus());
      return;
    }
    if (action === 'photo') onInsertPhoto?.();
  }, [draft, blocks, focus, onChange, onInsertPhoto]);

  const currentType = focus >= 0 && blocks[focus] ? parse(draft)[0].type : null;

  return (
    <div className="nb-page-wrap">
      <div className="nb-page" onMouseDown={(e) => {
        // A click on the page below the last block puts the caret at the end,
        // which is what a page of paper implies. Without it, the large empty
        // area under a short note is dead.
        if (e.target === e.currentTarget && blocks.length) setFocus(blocks.length - 1);
      }}>
        {blocks.map((b, i) => (
          i === focus ? (
            <div key={i} className={`nb-block nb-${b.type} is-focused`} data-indent={b.indent || 0}>
              <textarea
                ref={taRef}
                className="nb-input"
                value={draft}
                rows={1}
                onChange={onInput}
                onKeyDown={onKeyDown}
                // Maintains signal 3 for the guard in `onKeyDown`. Without
                // this the guard is back to the two signals that were not
                // enough on Android.
                {...compositionTracking()}
                onBlur={blurToRead}
                spellCheck={false}
                // §5: "No auto-correct, no smart quotes, no em-dash
                // substitution. A maths note types characters those rules
                // destroy (`--`, `"`, `'`, `...`)." These four attributes are
                // the only way to say that to a mobile keyboard.
                autoCorrect="off"
                autoCapitalize="off"
                autoComplete="off"
                data-gramm="false"
                aria-label={t('nb.editorLine', { n: i + 1 })}
              />
            </div>
          ) : (
            <Block
              key={i}
              block={b}
              index={i}
              number={numbers.get(i)}
              onFocus={setFocus}
              onToggleCheck={(idx) => {
                const next = [...blocks];
                next[idx] = { ...next[idx], checked: !next[idx].checked };
                commit(next);
              }}
              photoUrl={photoUrls?.[b.asset]}
              onOpenPhoto={onOpenPhoto}
            />
          )
        ))}
      </div>

      {focus >= 0 && (
        <FormatBar
          activeType={currentType}
          isList={isList(currentType)}
          swatchesOpen={swatches}
          onSwatches={setSwatches}
          onAction={applyFromBar}
          canInsertPhoto={typeof onInsertPhoto === 'function'}
        />
      )}
    </div>
  );
}

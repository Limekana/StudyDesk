// Enter-to-submit that does not fight an input method editor.
//
// GitHub #35: a Chinese user could not create a course. Mechanism: a CJK IME
// uses Enter to *commit the candidate selection*, not to submit the form. In an
// Android WebView that keydown reaches the React handler while composition is
// still open, so `onKeyDown={e => e.key === "Enter" && addCourse()}` fires on
// the keystroke that was meant to choose characters. At that instant the
// controlled value still holds the uncommitted buffer or is empty, the
// handler's own `if (!name.trim()) return` bails, and the modal just sits
// there. The user sees a dead button and presses Enter again, forever.
//
// StudyDesk ships 10 locales and adding a course is the first thing anyone
// does, so every CJK user hit this on the first screen of onboarding.
//
// Three signals, because no single one is reliable in an Android WebView:
//
//   1. `nativeEvent.isComposing` — the standard, and correct where it is
//      implemented. React's SyntheticEvent does not surface it, hence
//      nativeEvent.
//   2. `keyCode === 229` — what a WebView reports for a keystroke the IME has
//      swallowed. Predates isComposing and is still what several Android
//      keyboards actually send. A real Enter is 13, so this never false-fires.
//   3. A composition flag we keep ourselves. Some WebView builds have already
//      cleared isComposing by the time keydown is dispatched, which is the
//      whole bug reappearing through the one check that was supposed to catch
//      it. compositionstart/compositionend bracket the session unambiguously.
//
// The flag lives in a WeakSet keyed on the DOM element, not in a ref. That
// keeps this a plain function rather than a hook, so it can be called inside a
// map or a conditional branch without changing hook order at any call site,
// and entries die with the element.
const composing = new WeakSet();

/**
 * Is this keystroke part of an open composition?
 *
 * Exported because `enterSubmit` only fits a single-purpose input. A handler
 * that owns several keys — the Notebook editor's, which routes Enter, Tab and
 * Backspace — needs the same three signals as ONE early return at the top,
 * before any branch gets to look at the key. Pair it with
 * `compositionTracking()` on the same element or the third signal is dead.
 */
export function isComposing(e, el) {
  const ne = e.nativeEvent;
  return Boolean(
    (ne && ne.isComposing) ||
    e.keyCode === 229 ||
    (ne && ne.keyCode === 229) ||
    (el && composing.has(el)),
  );
}

/**
 * Props for a text input whose Enter key submits.
 *
 * Spread it: `<input {...enterSubmit(save)} />`. Returns all three handlers
 * together on purpose — a call site cannot take the Enter guard and forget the
 * composition tracking that makes it work.
 *
 * `fn` receives the event, so a caller that needs preventDefault or the value
 * still has it. It is called only for a real, committed Enter.
 *
 * After the IME commits on the first Enter, a second Enter submits. That is
 * the behaviour every native CJK text field has; it is the correct outcome,
 * not a compromise.
 */
/**
 * The composition-tracking half of `enterSubmit`, on its own.
 *
 * Spread it onto any element whose own keydown handler calls `isComposing`.
 * Signal 3 — the flag we keep ourselves — only exists if something maintains
 * it, and it is the signal that catches the WebView builds where the other
 * two have already gone quiet.
 */
export function compositionTracking() {
  return {
    onCompositionStart: (e) => { composing.add(e.currentTarget); },
    onCompositionEnd: (e) => { composing.delete(e.currentTarget); },
  };
}

export function enterSubmit(fn) {
  return {
    ...compositionTracking(),
    onKeyDown: (e) => {
      if (e.key !== 'Enter') return;
      if (isComposing(e, e.currentTarget)) return;
      fn(e);
    },
  };
}

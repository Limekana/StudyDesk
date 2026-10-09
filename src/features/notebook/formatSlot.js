// The desktop format row (StudyDesk#113).
//
// The docked bar is a phone answer to a phone problem (FormatBar.jsx), and on
// desktop notebook.css hides it: "the always-visible format row in the note
// header takes its place". That row was never built, so on desktop there was
// no formatting UI at all, only shortcuts nobody was told about.
//
// NotebookView owns the row and provides this context. The editor that holds
// the caret portals its own FormatBar into `slot`, so every control keeps the
// exact behaviour it has on the phone; while nothing is being edited the row
// shows an idle copy, so the controls are visible before you click in.
import { createContext, useContext, useEffect, useState } from 'react';

export const FormatSlotContext = createContext(null);

/** `{ slot, setEditing, openHelp }`, or null outside the notebook. `slot` is
 *  null on narrow screens, where the docked bar is used. */
export const useFormatSlot = () => useContext(FormatSlotContext);

/** The width at which notebook.css hides the docked phone bar. */
export const WIDE = '(min-width: 769px)';

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return matches;
}

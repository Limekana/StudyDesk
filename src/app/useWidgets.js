// Home-screen widgets: data pushes and widget-tap navigation.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { useState, useEffect } from "react";
import { formatLocale } from "../lib/dates.js";
import { pushWidgetSnapshot, consumeWidgetLaunchView, onWidgetNavigate } from "../lib/widgetBridge.js";
import { WIDGET_PALETTE_EVENT } from "../lib/theme.js";

export function useWidgets({ state, t, dispatch }) {
  // v1.9 (Item 8) — keep the home-screen widgets in step with the same data,
  // on the same triggers as the notifications above. Both answer "what's next"
  // from outside the app, so they should never be able to disagree.
  //
  // Not gated on notifEnabled: a widget the user chose to place on their home
  // screen is not a notification, and declining reminders is not declining it.
  // The push itself no-ops off Android and when no widget is placed.
  //
  // v1.15 — and on a palette change: the widgets follow the app's look (or
  // the Settings override), so switching to Dark has to reach the home screen
  // without waiting for the next assignment edit.
  const [widgetPaletteTick, setWidgetPaletteTick] = useState(0);
  useEffect(() => {
    const bump = () => setWidgetPaletteTick((n) => n + 1);
    window.addEventListener(WIDGET_PALETTE_EVENT, bump);
    return () => window.removeEventListener(WIDGET_PALETTE_EVENT, bump);
  }, []);
  useEffect(() => {
    void pushWidgetSnapshot({
      assignments: state.assignments,
      exams: state.exams,
      courses: state.courses,
      t,
      locale: formatLocale(),
    });
  }, [state.assignments, state.exams, state.courses, t, widgetPaletteTick]);

  // v1.10 — widget taps land where the widget was about.
  //
  // Shipped 1.7.0 gave both widgets the same bare "open MainActivity" intent,
  // so a tap dropped the user on whatever screen they last left the app on —
  // reported as "doesnt take me to the right place both just open the app".
  // Next Up now opens the Next Up view, Upcoming opens the plan view.
  //
  // Two paths because Android delivers the two cases differently: a cold start
  // is queued natively and collected here on mount, a tap while the app is
  // already running arrives as an event. See WidgetBridgePlugin.
  useEffect(() => {
    let cancelled = false;

    void consumeWidgetLaunchView().then((view) => {
      if (!cancelled && view) dispatch({ type: "SET_VIEW", view });
    });

    // Await the handle before removing it — the same StrictMode ordering trap
    // that double-registered the notification listener in v1.7.
    const handlePromise = onWidgetNavigate((view) => {
      dispatch({ type: "SET_VIEW", view });
    });

    return () => {
      cancelled = true;
      void handlePromise?.then((h) => h.remove()).catch(() => {});
    };
  }, [dispatch]);
}

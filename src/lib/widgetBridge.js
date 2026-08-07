// v1.9 (Item 8) — feeds the Android home-screen widgets.
//
// The widgets are drawn by the launcher, in another process, usually with
// StudyDesk not running. They cannot reach IndexedDB, so this pushes a small
// finished snapshot into native storage whenever the data changes, and the
// widgets only ever render what they are given.
//
// All the deciding happens here rather than in Java on purpose: "what's next"
// is a product rule, and having a second copy of it in another language is how
// the widget and the app end up disagreeing about the same question.

import { registerPlugin, Capacitor } from '@capacitor/core';

const WidgetBridge = registerPlugin('WidgetBridge');

/** How many deadlines the Upcoming widget can show. Matches ROW_IDS in
 *  UpcomingWidget.java — more rows than that are simply not drawn. */
const MAX_UPCOMING = 5;

/** View ids a widget is allowed to ask for. An intent extra is attacker-
 *  reachable in principle — any app can build one naming our exported
 *  MainActivity — so treat it as untrusted input and only honour known views
 *  rather than dispatching whatever string arrives. */
const WIDGET_VIEWS = new Set(['actions', 'plan']);

/**
 * Where a widget tap wants to land, or null.
 *
 * Cold start only: the native side queues the target while the web layer is
 * still booting. A launch from the app icon resolves null, which is the
 * overwhelmingly common case.
 */
export async function consumeWidgetLaunchView() {
  if (Capacitor.getPlatform() !== 'android') return null;
  try {
    const { view } = await WidgetBridge.consumeLaunchView();
    return WIDGET_VIEWS.has(view) ? view : null;
  } catch (e) {
    // An older native layer has no such method. Not worth a broken launch.
    console.warn('[StudyDesk] widget launch view unavailable:', e?.message ?? e);
    return null;
  }
}

/**
 * Subscribe to widget taps that arrive while the app is already running.
 *
 * Returns a promise for the listener handle — await it before calling
 * .remove(), or the cleanup races the registration and orphans the listener.
 * That exact bug bit the notification listener in v1.7; see App.jsx.
 */
export function onWidgetNavigate(handler) {
  if (Capacitor.getPlatform() !== 'android') return null;
  return WidgetBridge.addListener('widgetNavigate', ({ view }) => {
    if (WIDGET_VIEWS.has(view)) handler(view);
  });
}

/**
 * Ranking, identical to the daily Next Up digest in App.jsx: everything not
 * done that has a due date, soonest first. Exams before assignments on ties,
 * because an exam is the less reschedulable of the two.
 */
function rank(assignments, exams) {
  const live = [
    ...exams.filter((e) => !e.done && e.dueDate).map((e) => ({ ...e, kind: 'exam' })),
    ...assignments.filter((a) => !a.done && a.dueDate).map((a) => ({ ...a, kind: 'assignment' })),
  ];
  return live.sort((a, b) => {
    const d = new Date(a.dueDate) - new Date(b.dueDate);
    if (d !== 0) return d;
    return a.kind === b.kind ? 0 : a.kind === 'exam' ? -1 : 1;
  });
}

/**
 * "Today" / "Tomorrow" / a short date.
 *
 * Uses the device locale rather than the app's i18n bundle: the widget is
 * rendered outside the WebView where i18next does not exist, so this string has
 * to arrive already formatted. Day-level comparison is done on local calendar
 * dates, not elapsed hours — something due at 09:00 tomorrow is "Tomorrow" at
 * 23:00 tonight, even though that is only ten hours away.
 */
function whenLabel(dueDate, locale) {
  const due = new Date(dueDate);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
  if (days === 0) return { days, today: true, text: null };
  if (days === 1) return { days, tomorrow: true, text: null };
  return {
    days,
    text: due.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
  };
}

/**
 * How loud the widget's dot should be. v1.10.
 *
 * Derived here rather than natively because the native side only ever receives
 * `when` as an already-localised string — "Huomenna" is not something Java can
 * compare against a date. Negative days means overdue, which is at least as
 * urgent as due today.
 *
 * Mirrors the app's own TODAY / THIS WEEK / LATER grouping so the widget and
 * the Next Up screen never disagree about what counts as pressing.
 */
function urgencyOf(days) {
  if (days <= 0) return 'urgent';
  if (days <= 3) return 'soon';
  return 'later';
}

/**
 * Build and push the snapshot.
 *
 * Safe to call on every data change: it no-ops off-Android, and it asks the
 * native side whether any widget is actually placed before doing the work —
 * most users never place one, and there is no reason to serialise a payload
 * nobody will look at.
 *
 * Never throws. A widget failing to update must not break the app that was
 * only trying to save an assignment.
 */
export async function pushWidgetSnapshot({ assignments, exams, courses, t, locale }) {
  if (Capacitor.getPlatform() !== 'android') return;
  try {
    const { placed } = await WidgetBridge.hasWidgets();
    if (!placed) return;

    const ordered = rank(assignments ?? [], exams ?? []);
    const nameOf = (item) => {
      const course = courses?.[item.courseId];
      return course ? `${item.title} — ${course.name}` : item.title;
    };
    // One pass per item: the due date decides both the words and the dot, and
    // computing them apart invites them to disagree.
    const describe = (item) => {
      const w = whenLabel(item.dueDate, locale);
      const when = w.today ? t('widget.today') : w.tomorrow ? t('widget.tomorrow') : w.text;
      return { when, urgency: urgencyOf(w.days) };
    };

    const top = ordered[0];
    const topWhen = top ? describe(top) : null;
    // Title is the task, subtitle is the context — course and when. Putting
    // `nameOf` in both would have made the second line repeat the first.
    const topSubtitle = top
      ? [courses?.[top.courseId]?.name, topWhen.when].filter(Boolean).join(' · ')
      : '';
    const snapshot = {
      updatedAt: new Date().toISOString(),
      nextUp: top
        ? { title: top.title, subtitle: topSubtitle, urgency: topWhen.urgency }
        : null,
      upcoming: ordered.slice(0, MAX_UPCOMING).map((item) => {
        const d = describe(item);
        return {
          title: nameOf(item),
          when: d.when,
          urgency: d.urgency,
          kind: item.kind,
        };
      }),
    };

    await WidgetBridge.setSnapshot({ json: JSON.stringify(snapshot) });
  } catch (e) {
    console.warn('[StudyDesk] widget snapshot push failed:', e?.message ?? e);
  }
}

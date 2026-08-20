// Browser notifications for planned study blocks — the web half of SD-F8.
//
// On Android the reminders are OS alarms: `LocalNotifications.schedule()` hands
// the deadline to AlarmManager and nothing of ours needs to be running. The web
// has no equivalent, and the difference is worth stating precisely because it
// decides what this file can honestly promise.
//
// ── What works, and what does not ─────────────────────────────────────────
//   * StudyDesk open in a tab, even hidden or minimised  ->  works.
//   * StudyDesk closed entirely                          ->  IMPOSSIBLE here.
//
// Firing with the app closed needs a service worker plus Web Push: VAPID keys,
// a subscriptions table, and a server that sends the push at the right moment.
// StudyDesk has no service worker and no manifest today, so that is a feature,
// not a tweak. The Notification Triggers API (`showTrigger`) would have done it
// without a server, but it never shipped beyond a Chrome origin trial and was
// withdrawn — it is not a thing to build on.
//
// ── Why a ticking check and not one long setTimeout ───────────────────────
// A `setTimeout` 30 minutes out looks like the obvious implementation and is
// wrong: browsers clamp timers in hidden tabs (Chrome to roughly one per
// minute, then harder under budget throttling), so the one moment the timer
// matters is exactly when it is least trusted. Instead this polls wall-clock
// time on a short interval and asks "is anything due?" — throttling then costs
// at most the tick interval in lateness rather than an unbounded amount, and a
// clock change or a laptop resuming from sleep is picked up on the next tick
// rather than firing a timer that was scheduled against a stale clock.

const FIRED_KEY = 'studydesk-plan-fired';
const TICK_MS = 30_000;

/** How late a reminder may be and still fire. Opening the laptop at 23:00
 *  should not deliver every block the day had planned for it — a reminder that
 *  arrives long after the moment it describes is noise, and worse, it teaches
 *  the user that these can be ignored. */
const GRACE_MS = 5 * 60_000;

/** Fired keys are kept this long, then pruned. Long enough that a reload or a
 *  browser restart cannot re-fire something, short enough that the entry does
 *  not accumulate forever. */
const FIRED_TTL_MS = 2 * 24 * 60 * 60_000;

export function webNotifySupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function webNotifyPermission() {
  if (!webNotifySupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Ask for permission.
 *
 * Must be called from a user gesture — browsers reject or auto-deny a request
 * that arrives without one, and a denial is sticky, so asking automatically on
 * load would burn the single chance the app gets. Hence the Settings button
 * rather than a prompt on first render.
 */
export async function requestWebNotifyPermission() {
  if (!webNotifySupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function readFired() {
  try {
    const raw = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeFired(map) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(map));
  } catch { /* private mode, or quota — losing this only risks a repeat ping */ }
}

/**
 * Every reminder a plan is owed, as {key, at, title, body}.
 *
 * Exported for the assertions: this is the part with the actual rules in it,
 * and it is pure, so it can be checked without a browser or a clock.
 */
export function dueReminders(plans, prefs, courses, now, labels) {
  const out = [];
  const lead = Number.isFinite(prefs?.lead) ? prefs.lead : null;
  const wantStart = !!prefs?.atStart;
  if (lead === null && !wantStart) return out;

  for (const p of plans || []) {
    // Same exclusions as the native path: a plan that was logged or dropped is
    // not upcoming, and nagging about either is how a reminder system trains
    // people to ignore it.
    if (!p || !p.startsAt || p.fulfilledBy || p.dismissedAt || p.deletedAt) continue;
    const at = new Date(p.startsAt).getTime();
    if (!Number.isFinite(at)) continue;

    const c = p.subjectId ? courses?.[p.subjectId] : null;
    const body = p.title || (c && !c.deletedAt ? c.name : null) || labels.fallback;

    if (lead !== null) {
      out.push({ key: `${p.id}:lead`, at: at - lead * 60_000, title: labels.soon(lead), body });
    }
    if (wantStart) {
      out.push({ key: `${p.id}:start`, at, title: labels.now, body });
    }
  }
  // Only what is due right now, and not so long ago that it has stopped being
  // information. `now` is passed in rather than read so this stays testable.
  return out.filter((r) => r.at <= now && now - r.at <= GRACE_MS);
}

/**
 * Start the reminder loop. Returns a stop function.
 *
 * `getState` is a function rather than a snapshot so the loop always sees
 * current plans and preferences without being torn down and rebuilt on every
 * edit — re-subscribing on each keystroke in Settings would drop the tick and
 * reset the timing.
 */
export function startPlanReminderLoop(getState) {
  if (!webNotifySupported()) return () => {};

  let stopped = false;

  const sweep = () => {
    if (stopped) return;
    if (Notification.permission !== 'granted') return;
    const st = getState();
    if (!st || !st.enabled) return;

    const now = Date.now();
    const fired = readFired();
    let changed = false;

    for (const r of dueReminders(st.plans, st.prefs, st.courses, now, st.labels)) {
      if (fired[r.key]) continue;
      try {
        new Notification(r.title, { body: r.body, tag: r.key, icon: '/logo.png' });
      } catch { /* a refused notification must not stop the sweep */ }
      fired[r.key] = now;
      changed = true;
    }

    // Prune while we are here rather than on a separate schedule.
    for (const [k, ts] of Object.entries(fired)) {
      if (!Number.isFinite(ts) || now - ts > FIRED_TTL_MS) { delete fired[k]; changed = true; }
    }
    if (changed) writeFired(fired);
  };

  const id = setInterval(sweep, TICK_MS);
  // A hidden tab's interval is throttled, so a tab that has been in the
  // background for an hour may be several ticks behind. Sweeping the moment it
  // becomes visible again catches anything still inside the grace window.
  const onVisible = () => { if (!document.hidden) sweep(); };
  document.addEventListener('visibilitychange', onVisible);
  sweep();

  return () => {
    stopped = true;
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

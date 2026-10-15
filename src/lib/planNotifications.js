import { LocalNotifications } from "@capacitor/local-notifications";
import { parseLocalDate, addDays, fmtTime } from "./dates.js";
import { DIFFICULTY_DAYS } from "./examDifficulty.js";
import { dueDayReminderAt } from "./dueAt.js";
import { studyStartDate } from "./deadlines.js";

// ── Notifications ─────────────────────────────────────────────────────────────
// Action-type IDs for tap-action buttons. Registered once at app start via
// registerActionTypes() and attached per-notification via actionTypeId.
// The button click surfaces as a localNotificationActionPerformed event whose
// actionId === ACTION_DONE_ID and whose notification.extra carries the
// assignmentId to dispatch TOGGLE_ASSIGNMENT against.
const ASSIGNMENT_ACTION_TYPE = "assignment-reminder";
export const ACTION_DONE_ID = "done";
// v1.18.1 (StudyDesk#141): the button is labelled in the app's language, so it
// is registered again whenever that label changes.
let _actionLabelRegistered = null;
async function registerActionTypes(label) {
  if (_actionLabelRegistered === label) return;
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ASSIGNMENT_ACTION_TYPE,
          actions: [{ id: ACTION_DONE_ID, title: label }],
        },
      ],
    });
    _actionLabelRegistered = label;
  } catch (e) {
    console.warn("[StudyDesk] registerActionTypes failed:", e);
  }
}

// ── One run at a time (v1.18.1, StudyDesk#138) ───────────────────────────────
//
// A reschedule reads the pending alarms, cancels some and schedules others,
// with awaits in between, and every pull hands useReminders new arrays, so two
// runs used to overlap and interleave those steps. Runs now go one after the
// other, and a run asked for while another is in flight replaces any still
// waiting: only the newest state is worth scheduling. A switch-off goes
// through the same line, so it cannot be overtaken by a reschedule that
// started before it.
let nextJob = null;
let running = null;
function runLatest(job) {
  nextJob = job;
  if (!running) {
    running = (async () => {
      try {
        while (nextJob) {
          const j = nextJob;
          nextJob = null;
          // A job that throws must not strand the one queued behind it.
          try { await j(); } catch (e) { console.error("[StudyDesk] reminder job failed:", e); }
        }
      } finally {
        running = null;
      }
    })();
  }
  return running;
}

/** Cancels every pending notification without asking for permission.
 *  Used when reminders are switched off — scheduling and unscheduling must not
 *  share a path, because the scheduling path prompts and the off path must
 *  never prompt. */
export function cancelAllNotifications() {
  return runLatest(async () => {
    try {
      const pending = await LocalNotifications.getPending();
      if (pending.notifications.length > 0) {
        await LocalNotifications.cancel({ notifications: pending.notifications });
      }
    } catch (e) {
      console.error("[StudyDesk] cancelAllNotifications failed:", e);
    }
  });
}

/** A reminder's ID, from what it is about: `kind:entity` (plus the day, for
 *  the digest). v1.18.1 (StudyDesk#138): IDs were positions in the batch, so
 *  one reminder's ID went to another whenever anything earlier in the list
 *  changed, and every reschedule had to cancel and re-send all of them. The
 *  plugin's schedule() also dismisses a shown notification whose ID it
 *  reuses, so each pull cleared reminders the user had not read yet. A stable
 *  ID lets an unchanged reminder be left alone. FNV-1a, folded into positive
 *  31-bit space above 100000, clear of the old positional IDs (1000 up). */
export function reminderId(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 100000 + ((h >>> 0) % 2000000000);
}

/** Bumped when something a pending reminder carries but getPending does not
 *  report (icon, allow-while-idle, action type) changes, so the next run
 *  re-sends every reminder once with it. */
const REMINDER_FORMAT = 1;

/** Give each note its ID from its key, and its fingerprint. Two keys hashing
 *  alike in one batch are told apart by probing upward; vanishingly rare, and
 *  the cost is only that the second one's ID depends on the first.
 *
 *  The fingerprint rides in `extra`, which the plugin hands back unchanged.
 *  getPending's `schedule.at` cannot be compared instead: on Android it is a
 *  java.util.Date's toString(), "Thu Oct 15 09:00:00 HST 2026", which JS
 *  cannot parse for every zone (HST, AKST, AST among them), so there every
 *  reminder would look changed on every run. `actionLabel` is the "Mark done"
 *  text the reminder was scheduled with: the button is fixed then. */
function assignIds(notes, actionLabel) {
  const used = new Set();
  for (const n of notes) {
    let id = reminderId(n.key);
    while (used.has(id)) id = id >= 2000099999 ? 100000 : id + 1;
    used.add(id);
    n.id = id;
    delete n.key;
    const at = n.schedule.at.getTime();
    const fp = [REMINDER_FORMAT, n.title, n.body, at, n.actionTypeId ? actionLabel : ''].join('\u241f');
    n.extra = { ...(n.extra || {}), rk: fp, ra: at };
  }
  return notes;
}

/** A pending reminder this run would schedule exactly as it is. */
function samePending(p, n) {
  return typeof p?.extra?.rk === 'string' && p.extra.rk === n.extra.rk;
}

/** A pending reminder whose time has just come, but whose alarm has not
 *  fired yet (alarm latency, or Doze rationing allow-while-idle alarms). The
 *  new schedule no longer lists it, since it only lists the future; it is
 *  left to fire rather than cancelled unseen. */
const DUE_GRACE_MS = 15 * 60 * 1000;
function dueAndPending(p, now) {
  const at = Number(p?.extra?.ra);
  return Number.isFinite(at) && at <= now && now - at <= DUE_GRACE_MS;
}

/** How far ahead planned-session reminders are scheduled, and how many.
 *
 *  Both caps exist because Android holds a finite number of pending alarms per
 *  app (a few hundred) and this function already spends 30 on the daily digest
 *  plus up to three per exam and two per assignment. A user who plans a session
 *  every evening for a term would silently push the exam reminders out of the
 *  queue — the reminders that actually matter. Nearest-first ordering means the
 *  ones that survive the cap are the ones arriving soonest. */
const PLAN_NOTIFY_HORIZON_DAYS = 30;
const PLAN_NOTIFY_MAX = 60;

/** v1.19 — SD#137: every reminder is allowed to fire while the phone idles.
 *  Without the flag the plugin schedules `setExact(RTC)`, a non-wakeup alarm
 *  that Doze holds until the next maintenance window or until the screen comes
 *  on, which is how a "30 min" reminder reached an S24 13 minutes before the
 *  block. With it the plugin uses `setExactAndAllowWhileIdle(RTC_WAKEUP)`.
 *  Applied once, where the batch is handed over, so a reminder added later
 *  cannot leave it out. */
const allowWhileIdle = (n) => ({ ...n, schedule: { ...n.schedule, allowWhileIdle: true } });

/** The lead reminder's title, naming the block's start time.
 *  v1.19 — SD#137: it used to say "in {n} min", worked out at schedule time,
 *  while Android stamps the notification with its delivery time, so a late
 *  alarm showed a countdown that was wrong by however late it was. "at 15:00"
 *  stays true whenever it lands. Shared with the web loop (useReminders.js) so
 *  both paths say the same thing. */
export function planLeadTitle(t, at) {
  return t('notif.planLeadTitle', { time: fmtTime(at) });
}

export function scheduleNotifications(exams, assignments, courses, plannedSessions, planPrefs, t) {
  return runLatest(() => scheduleNow(exams, assignments, courses, plannedSessions, planPrefs, t));
}

/** Every reminder the current state calls for, each with the `key` its ID is
 *  made from. Pure; `now` is a parameter for the tests. */
export function buildReminders(exams, assignments, courses, plannedSessions, planPrefs, t, now = Date.now(), actionLabel = t('notif.markDone')) {
  const notes = [];
  const style = { smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" };

  // ── Daily 9am Next Up digest — fires every day for next 30 days ──
  const topItem = [...exams.filter(e=>!e.done&&e.dueDate), ...assignments.filter(a=>!a.done&&a.dueDate)]
    .sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];
  if (topItem) {
    const topCourse = courses[topItem.courseId];
    const topLabel = topCourse ? `${topItem.title} — ${topCourse.name}` : topItem.title;
    for (let day = 0; day < 30; day++) {
      const at = new Date(now); at.setHours(9,0,0,0); at.setDate(at.getDate() + day);
      // Keyed by the day it fires on, so tomorrow's digest keeps its ID as
      // the days roll forward.
      const dayKey = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
      if (at.getTime() > now) notes.push({ key: `digest:${dayKey}`, title: t('notif.digestTitle'), body: topLabel, schedule: { at }, ...style });
    }
  }

  // ── Exam-specific notifications ──
  // v1.18.1 (StudyDesk#141): titles from notif.*, in the app's language. They
  // were English strings, so every other locale got English reminders.
  exams.forEach(exam => {
    if (exam.done || !exam.dueDate) return;
    const c = courses[exam.courseId];
    const label = c ? `${exam.title} — ${c.name}` : exam.title;
    // Study start day at 9am
    const startAt = parseLocalDate(studyStartDate(exam)); startAt.setHours(9,0,0,0);
    const days = DIFFICULTY_DAYS[exam.difficulty||"medium"];
    if (startAt.getTime() > now) notes.push({ key: `exam-start:${exam.id}`, title: t('notif.examStartTitle'), body: t('notif.examStartBody', { label, count: days }), schedule: { at: startAt }, ...style });
    // 2 days before at 9am
    const twoDay = parseLocalDate(addDays(exam.dueDate,-2)); twoDay.setHours(9,0,0,0);
    if (twoDay.getTime() > now) notes.push({ key: `exam-2d:${exam.id}`, title: t('notif.examSoonTitle'), body: label, schedule: { at: twoDay }, ...style });
    // Exam day at 7am
    const examDay = parseLocalDate(exam.dueDate); examDay.setHours(7,0,0,0);
    if (examDay.getTime() > now) notes.push({ key: `exam-day:${exam.id}`, title: t('notif.examTodayTitle'), body: label, schedule: { at: examDay }, ...style });
  });

  // ── Assignment-specific notifications ──
  assignments.forEach(asgn => {
    if (asgn.done || !asgn.dueDate) return;
    const c = courses[asgn.courseId];
    // v1.14 Item 5 — the deadline's own time, when it has one, goes in the
    // body. A reminder that says "Essay — History" is a different message
    // from "Essay — History · 09:00" at eight in the morning.
    const base = c ? `${asgn.title} — ${c.name}` : asgn.title;
    const label = asgn.dueTime ? `${base} · ${asgn.dueTime}` : base;
    // Day before at 6pm. Action button "Mark done" → TOGGLE_ASSIGNMENT
    // (see App-level useEffect listener). extra.assignmentId carries the
    // target id; both reminders for the same assignment share that id so
    // either notification can mark it done.
    const dayBefore = parseLocalDate(addDays(asgn.dueDate,-1)); dayBefore.setHours(18,0,0,0);
    if (dayBefore.getTime() > now) notes.push({ key: `asgn-before:${asgn.id}`, title: t('notif.dueTomorrowTitle'), body: label, schedule: { at: dayBefore }, ...style, actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
    // Due day — 9am, or an hour before the deadline when that is earlier.
    // 9am was always fine for an evening deadline and useless for an 08:00
    // one, which is the case this item makes expressible. `null` means the
    // deadline is early enough that an hour's warning lands yesterday, where
    // the 6pm reminder above already covers it.
    const dueDay = dueDayReminderAt(asgn.dueDate, asgn.dueTime);
    if (dueDay && dueDay.getTime() > now) notes.push({ key: `asgn-due:${asgn.id}`, title: t('notif.dueTodayTitle'), body: label, schedule: { at: dueDay }, ...style, actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
  });

  // ── Planned study sessions (v1.10) ──────────────────────────────────
  //
  // Skips anything already resolved: `fulfilledBy` means the session was
  // logged and `dismissedAt` means it was dropped, and nagging about either
  // is how a reminder system teaches people to ignore it. Skips the past
  // too — a plan whose start time has gone is not upcoming.
  const lead = planPrefs?.lead;
  const wantStart = !!planPrefs?.atStart;
  if (Number.isFinite(lead) || wantStart) {
    const horizon = now + PLAN_NOTIFY_HORIZON_DAYS * 24 * 60 * 60 * 1000;
    const upcoming = (plannedSessions || [])
      .filter((p) => p && p.startsAt && !p.fulfilledBy && !p.dismissedAt && !p.deletedAt)
      .map((p) => ({ p, at: new Date(p.startsAt).getTime() }))
      .filter((x) => Number.isFinite(x.at) && x.at > now && x.at <= horizon)
      .sort((a, b) => a.at - b.at);

    let planned = 0;
    for (const { p, at } of upcoming) {
      if (planned >= PLAN_NOTIFY_MAX) break;
      const c = p.subjectId ? courses[p.subjectId] : null;
      const label = p.title || (c && !c.deletedAt ? c.name : null) || t('notif.planFallback');
      // The lead reminder is dropped, not clamped, when it would land in the
      // past: a plan made 10 minutes before it starts should still get its
      // at-start ping without also firing a "in 30 minutes" one immediately.
      if (Number.isFinite(lead)) {
        const leadAt = at - lead * 60 * 1000;
        if (leadAt > now) {
          notes.push({
            key: `plan-lead:${p.id}`, title: planLeadTitle(t, at), body: label,
            schedule: { at: new Date(leadAt) },
            ...style,
            extra: { view: "timer" },
          });
          planned++;
        }
      }
      if (wantStart && planned < PLAN_NOTIFY_MAX) {
        notes.push({
          key: `plan-start:${p.id}`, title: t('notif.planNowTitle'), body: label,
          schedule: { at: new Date(at) },
          ...style,
          extra: { view: "timer" },
        });
        planned++;
      }
    }
  }
  return assignIds(notes, actionLabel);
}

async function scheduleNow(exams, assignments, courses, plannedSessions, planPrefs, t) {
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;
    // Register action types before scheduling — must be set up before any
    // notification with actionTypeId fires or the button won't render.
    const actionLabel = t('notif.markDone');
    await registerActionTypes(actionLabel);
    const now = Date.now();
    const notes = buildReminders(exams, assignments, courses, plannedSessions, planPrefs, t, now, actionLabel);
    // v1.18.1 (StudyDesk#138): only what changed. A pending reminder with the
    // same ID, text and time stays as it is; everything else pending is
    // cancelled, and only the new or changed reminders are handed over, so
    // the plugin never re-sends (and dismisses) one that is unchanged.
    const wanted = new Map(notes.map((n) => [n.id, n]));
    const pending = (await LocalNotifications.getPending()).notifications || [];
    const kept = new Set();
    const stale = [];
    for (const p of pending) {
      const n = wanted.get(p.id);
      if (n && samePending(p, n)) kept.add(p.id);
      else if (!n && dueAndPending(p, now)) continue;
      else stale.push({ id: p.id });
    }
    if (stale.length > 0) await LocalNotifications.cancel({ notifications: stale });
    const fresh = notes.filter((n) => !kept.has(n.id));
    if (fresh.length > 0) await LocalNotifications.schedule({ notifications: fresh.map(allowWhileIdle) });
  } catch(e) {
    console.error("[StudyDesk] scheduleNotifications failed:", e);
  }
}

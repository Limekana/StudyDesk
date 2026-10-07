import { LocalNotifications } from "@capacitor/local-notifications";
import { parseLocalDate, addDays } from "./dates.js";
import { DIFFICULTY_DAYS } from "./examDifficulty.js";
import { dueDayReminderAt } from "./dueAt.js";
import { studyStartDate } from "./deadlines.js";

// ── Notifications ─────────────────────────────────────────────────────────────
// Action-type IDs for tap-action buttons. Registered once at app start via
// registerActionTypesOnce() and attached per-notification via actionTypeId.
// The button click surfaces as a localNotificationActionPerformed event whose
// actionId === ACTION_DONE_ID and whose notification.extra carries the
// assignmentId to dispatch TOGGLE_ASSIGNMENT against.
const ASSIGNMENT_ACTION_TYPE = "assignment-reminder";
export const ACTION_DONE_ID = "done";
let _actionTypesRegistered = false;
async function registerActionTypesOnce() {
  if (_actionTypesRegistered) return;
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: ASSIGNMENT_ACTION_TYPE,
          actions: [{ id: ACTION_DONE_ID, title: "Mark done" }],
        },
      ],
    });
    _actionTypesRegistered = true;
  } catch (e) {
    console.warn("[StudyDesk] registerActionTypes failed:", e);
  }
}

/** Cancels every pending notification without asking for permission.
 *  Used when reminders are switched off — scheduling and unscheduling must not
 *  share a path, because the scheduling path prompts and the off path must
 *  never prompt. */
export async function cancelAllNotifications() {
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
  } catch (e) {
    console.error("[StudyDesk] cancelAllNotifications failed:", e);
  }
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

export async function scheduleNotifications(exams, assignments, courses, plannedSessions, planPrefs, t) {
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== "granted") return;
    // Register action types before scheduling — must be set up before any
    // notification with actionTypeId fires or the button won't render.
    await registerActionTypesOnce();
    // Cancel all previously scheduled notifications before rescheduling
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
    const notes = [];
    const now = Date.now();
    // Use a deterministic ID derived from content so reschedules don't collide
    // IDs must be positive 32-bit integers — use a simple counter seeded > 0
    let id = 1000;

    // ── Daily 9am Next Up digest — fires every day for next 30 days ──
    const topItem = [...exams.filter(e=>!e.done&&e.dueDate), ...assignments.filter(a=>!a.done&&a.dueDate)]
      .sort((a,b)=>new Date(a.dueDate)-new Date(b.dueDate))[0];
    if (topItem) {
      const topCourse = courses[topItem.courseId];
      const topLabel = topCourse ? `${topItem.title} — ${topCourse.name}` : topItem.title;
      for (let day = 0; day < 30; day++) {
        const at = new Date(); at.setHours(9,0,0,0); at.setDate(at.getDate() + day);
        if (at.getTime() > now) {
          notes.push({ id: id++, title: "📚 StudyDesk — Next Up", body: topLabel, schedule: { at }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
        }
      }
    }

    // ── Exam-specific notifications ──
    exams.forEach(exam => {
      if (exam.done || !exam.dueDate) return;
      const c = courses[exam.courseId];
      const label = c ? `${exam.title} — ${c.name}` : exam.title;
      // Study start day at 9am
      const startAt = parseLocalDate(studyStartDate(exam)); startAt.setHours(9,0,0,0);
      if (startAt.getTime() > now) notes.push({ id: id++, title: "📚 Time to start studying", body: `${label} — ${DIFFICULTY_DAYS[exam.difficulty||"medium"]}d to go`, schedule: { at: startAt }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
      // 2 days before at 9am
      const twoDay = parseLocalDate(addDays(exam.dueDate,-2)); twoDay.setHours(9,0,0,0);
      if (twoDay.getTime() > now) notes.push({ id: id++, title: "⚠️ Exam in 2 days", body: label, schedule: { at: twoDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
      // Exam day at 7am
      const examDay = parseLocalDate(exam.dueDate); examDay.setHours(7,0,0,0);
      if (examDay.getTime() > now) notes.push({ id: id++, title: "📝 Exam today — good luck", body: label, schedule: { at: examDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62" });
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
      if (dayBefore.getTime() > now) notes.push({ id: id++, title: "📋 Due tomorrow", body: label, schedule: { at: dayBefore }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62", actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
      // Due day — 9am, or an hour before the deadline when that is earlier.
      // 9am was always fine for an evening deadline and useless for an 08:00
      // one, which is the case this item makes expressible. `null` means the
      // deadline is early enough that an hour's warning lands yesterday, where
      // the 6pm reminder above already covers it.
      const dueDay = dueDayReminderAt(asgn.dueDate, asgn.dueTime);
      if (dueDay && dueDay.getTime() > now) notes.push({ id: id++, title: "📋 Due today", body: label, schedule: { at: dueDay }, smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62", actionTypeId: ASSIGNMENT_ACTION_TYPE, extra: { assignmentId: asgn.id } });
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
              id: id++, title: t('notif.planSoonTitle', { n: lead }), body: label,
              schedule: { at: new Date(leadAt) },
              smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62",
              extra: { view: "timer" },
            });
            planned++;
          }
        }
        if (wantStart && planned < PLAN_NOTIFY_MAX) {
          notes.push({
            id: id++, title: t('notif.planNowTitle'), body: label,
            schedule: { at: new Date(at) },
            smallIcon: "ic_stat_studydesk", iconColor: "#8b4a62",
            extra: { view: "timer" },
          });
          planned++;
        }
      }
    }

    if (notes.length > 0) await LocalNotifications.schedule({ notifications: notes });
  } catch(e) {
    console.error("[StudyDesk] scheduleNotifications failed:", e);
  }
}

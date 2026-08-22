// Pure derivation for the desktop glance widget.
//
// Everything here is a function of (state, today, now) with no I/O, so the
// widget's behaviour can be reasoned about and tested without an Electron
// window or a network round trip.
//
// The one rule this file exists to honour: it DERIVES, it does not re-implement.
// Which lessons apply on a given date is a genuinely subtle question — a
// timetable can attach to a school year, a semester or a jakso, and the most
// specific term that actually has entries for that weekday wins. That rule
// lives in lessonsOn() and must keep living in exactly one place; a second copy
// here would drift and the widget would quietly disagree with the calendar the
// user is looking at in the main window.

import { lessonsOn, dayAndMinuteOf } from '../lib/timetable.js';
import { parseLocalDate } from '../lib/dates.js';

/** Whole days from `fromIso` to `toIso`. Negative when `toIso` is in the past. */
export function daysUntil(fromIso, toIso) {
  const a = parseLocalDate(fromIso);
  const b = parseLocalDate(toIso);
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  // Compare at local midnight so a due date is never off by one across a DST
  // boundary, where a naive 86_400_000 division lands on 0.958 or 1.042 days.
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  return days;
}

/**
 * The single assignment the widget leads with: the soonest still-open one.
 * Overdue work sorts first naturally, which is the right answer — a thing you
 * have already missed outranks a thing due later today.
 */
export function nextDue(state, todayIso) {
  const open = (state.assignments || []).filter((a) => a && !a.done && a.dueDate);
  if (!open.length) return null;

  const soonest = open.reduce((best, a) => {
    const c = String(a.dueDate).localeCompare(String(best.dueDate));
    if (c !== 0) return c < 0 ? a : best;
    // Same date: stable, name-ordered, so the widget doesn't reshuffle between
    // polls when two things are due the same day.
    return String(a.title || '').localeCompare(String(best.title || '')) < 0 ? a : best;
  });

  const course = soonest.courseId ? state.courses?.[soonest.courseId] : null;
  const liveCourse = course && !course.deletedAt ? course : null;
  return {
    id: soonest.id,
    title: soonest.title || '',
    dueDate: soonest.dueDate,
    daysAway: daysUntil(todayIso, soonest.dueDate),
    courseName: liveCourse?.name || null,
    color: liveCourse?.color || null,
  };
}

/**
 * Everything scheduled for `todayIso`, lessons and planned study blocks
 * together, in clock order.
 *
 * Lessons and planned study stay distinguishable by `kind` rather than being
 * flattened into one list of "events". They are different commitments — a
 * lesson is somewhere you have to be, a planned block is work you promised
 * yourself — and the calendar already draws that distinction, so the widget
 * keeps it too.
 */
export function todayPlan(state, todayIso) {
  const lessons = lessonsOn(state, todayIso).map((l) => ({
    kind: 'lesson',
    id: l.id,
    startMin: l.startMin,
    endMin: l.endMin,
    title: l.title,
    courseName: l.courseName,
    color: l.color,
    room: l.room,
    done: false,
  }));

  const planned = [];
  for (const p of state.plannedSessions || []) {
    // A dismissed block is one the user explicitly waved off; it is not part of
    // today's plan any more and showing it would be nagging, not glancing.
    if (!p || p.deletedAt || p.dismissedAt) continue;
    const at = dayAndMinuteOf(p.startsAt);
    if (!at || at.iso !== todayIso) continue;

    const course = p.subjectId ? state.courses?.[p.subjectId] : null;
    const liveCourse = course && !course.deletedAt ? course : null;
    const duration = Number(p.durationMinutes);
    planned.push({
      kind: 'planned',
      id: p.id,
      startMin: at.minutes,
      endMin: at.minutes + (Number.isFinite(duration) ? duration : 0),
      title: p.title || liveCourse?.name || null,
      courseName: liveCourse?.name || null,
      color: liveCourse?.color || null,
      room: null,
      // Fulfilled means a real study session was logged against this block.
      done: Boolean(p.fulfilledBy),
    });
  }

  return [...lessons, ...planned].sort(
    (a, b) => (a.startMin - b.startMin) || String(a.title || '').localeCompare(String(b.title || '')),
  );
}

/**
 * What the widget actually has room to show, given the clock.
 *
 * Forward-looking by default — the point of a glance is what is still coming.
 * But when the day is over, falling back to the last couple of items is more
 * honest than an empty state that reads "nothing planned today" at 23:00 on a
 * day that had four lessons in it.
 */
export function visiblePlan(plan, nowMinutes, max = 4) {
  if (!plan.length) return { items: [], overflow: 0, spent: false };

  const upcoming = plan.filter((i) => i.endMin > nowMinutes);
  if (upcoming.length) {
    return {
      items: upcoming.slice(0, max),
      overflow: Math.max(0, upcoming.length - max),
      spent: false,
    };
  }
  return { items: plan.slice(-2), overflow: 0, spent: true };
}

/** Minutes past local midnight for `date`. */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

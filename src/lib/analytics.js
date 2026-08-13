// v1.9 Item 14a — analytics over data StudyDesk already holds.
//
// Pure module, no React. Three readings the build plan asks for: grades over
// time per subject, a study-time heatmap, and whether study time and grades
// actually move together.
//
// The honesty rule running through all of it: a student's grade history is a
// SMALL sample. Four grades in a course is normal. Statistics that are routine
// on thousands of rows are noise on four, so every function here reports its
// own sample size and the correlation refuses to draw a conclusion it cannot
// support. A dashboard that says "your study time strongly predicts your
// grades" off five points is not a feature, it is a lie with a chart on it.

import { parseLocalDate, toLocalISO, addDays } from './dates.js';
import { startOfWeek } from './calendar.js';

/** Weighted mean of `grades`, or null when there is nothing to average. */
export function weightedMean(grades) {
  let sum = 0, w = 0;
  for (const g of grades) {
    const gw = Number(g.weight);
    const gv = Number(g.grade);
    if (!Number.isFinite(gv) || !Number.isFinite(gw) || gw <= 0) continue;
    sum += gv * gw;
    w += gw;
  }
  return w > 0 ? sum / w : null;
}

/** Per-subject grade series, oldest first, each point carrying the running
 *  weighted average up to and including it. The running average is what makes
 *  the line readable: raw grades bounce, and the question a student is asking
 *  is "where am I heading", not "what did I get on the third one". */
export function gradeSeries(state) {
  const out = [];
  const courses = state.courses || {};
  for (const id of Object.keys(courses)) {
    const c = courses[id];
    if (!c || c.deletedAt) continue;
    const points = (state.grades || [])
      .filter((g) => !g.deletedAt && g.subjectId === id && Number.isFinite(Number(g.grade)))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (!points.length) continue;
    const running = [];
    const acc = [];
    for (const g of points) {
      acc.push(g);
      running.push({
        date: g.date,
        grade: Number(g.grade),
        weight: Number(g.weight) || 1,
        mean: weightedMean(acc),
      });
    }
    out.push({
      courseId: id,
      name: c.name,
      color: c.color || null,
      points: running,
      latest: running[running.length - 1].mean,
      first: running[0].mean,
      n: running.length,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Daily study minutes for roughly the last `days` days, ending today.
 *
 *  The window is SNAPPED BACK to a week boundary, so the first column of the
 *  heatmap is always a full week. Starting it on whatever weekday fell 182
 *  days ago left a ragged first column — a lone square sitting by itself with
 *  an empty cell above it, which reads as a rendering fault rather than as
 *  "this window began mid-week". Snapping costs at most six extra days.
 *
 *  Rows are ordered from `weekStart` for the same reason the calendar grid is:
 *  a Monday-start reader should not get Sunday-first rows.
 *
 *  Returns a dense array — every day present, zeros included — because a
 *  heatmap with missing days silently compresses the calendar and the gaps
 *  ARE the information. */
export function studyHeatmap(state, days = 182, today = toLocalISO(new Date()), weekStart = 1) {
  const byDay = new Map();
  for (const s of state.studySessions || []) {
    if (s.deletedAt || !s.startedAt) continue;
    const iso = toLocalISO(new Date(s.startedAt));
    byDay.set(iso, (byDay.get(iso) || 0) + (Number(s.durationMinutes) || 0));
  }
  const start = startOfWeek(addDays(today, -(days - 1)), weekStart);
  const cells = [];
  let max = 0;
  // Run to today inclusive rather than for a fixed count: the snap moved the
  // start, and a fixed count would then overshoot into future days.
  for (let iso = start; iso <= today; iso = addDays(iso, 1)) {
    const minutes = byDay.get(iso) || 0;
    if (minutes > max) max = minutes;
    cells.push({
      iso,
      minutes,
      // Row index within the column, already rotated for the week start.
      weekday: (parseLocalDate(iso).getDay() - weekStart + 7) % 7,
    });
  }
  // Five levels, keyed off the busiest day in the window rather than an
  // absolute scale: an hour a day is a lot for one student and little for
  // another, and a fixed scale would render one of them a blank grid.
  for (const cell of cells) {
    cell.level = cell.minutes === 0 ? 0 : Math.min(4, Math.ceil((cell.minutes / max) * 4));
  }
  return { cells, max, total: cells.reduce((n, c) => n + c.minutes, 0), start, end: today };
}

/** Pearson r. Returns null rather than a number when the sample cannot
 *  support one, or when either series is constant (zero variance — where the
 *  formula divides by zero and a naive implementation returns NaN). */
export function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i += 1) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Study time in the 21 days before each grade, paired with that grade.
 *
 *  The window matters and is a real modelling choice: total study time over a
 *  whole course correlates with nothing useful, because a course you study a
 *  lot for is often simply a long course. Time spent shortly BEFORE a
 *  particular result is the thing a student can act on.
 */
export function studyVsGrades(state, windowDays = 21) {
  const sessions = (state.studySessions || [])
    .filter((s) => !s.deletedAt && s.startedAt)
    .map((s) => ({ iso: toLocalISO(new Date(s.startedAt)), subjectId: s.subjectId, minutes: Number(s.durationMinutes) || 0 }));

  const pairs = [];
  for (const g of state.grades || []) {
    if (g.deletedAt || !g.date || !Number.isFinite(Number(g.grade))) continue;
    const from = addDays(g.date, -windowDays);
    let minutes = 0;
    for (const s of sessions) {
      if (s.subjectId === g.subjectId && s.iso >= from && s.iso <= g.date) minutes += s.minutes;
    }
    pairs.push({ subjectId: g.subjectId, date: g.date, grade: Number(g.grade), minutes });
  }

  // Grades from different courses are on different scales in the same units
  // only by accident, so the correlation is computed per subject and only
  // where that subject has enough points to mean anything.
  const bySubject = new Map();
  for (const p of pairs) {
    if (!bySubject.has(p.subjectId)) bySubject.set(p.subjectId, []);
    bySubject.get(p.subjectId).push(p);
  }
  const perSubject = [];
  for (const [subjectId, ps] of bySubject) {
    const course = state.courses?.[subjectId];
    if (!course || course.deletedAt) continue;
    perSubject.push({
      subjectId,
      name: course.name,
      color: course.color || null,
      n: ps.length,
      r: pearson(ps.map((p) => p.minutes), ps.map((p) => p.grade)),
      points: ps.sort((a, b) => a.date.localeCompare(b.date)),
    });
  }
  return { windowDays, perSubject: perSubject.sort((a, b) => a.name.localeCompare(b.name)), pairs };
}

/** How to describe an r honestly, including refusing to.
 *  `n` gates before the value does: |r| = 0.9 on four points is not "strong",
 *  it is four points. */
export function describeCorrelation(r, n) {
  if (r === null || n < 5) return 'insufficient';
  const a = Math.abs(r);
  if (a < 0.3) return 'none';
  if (a < 0.6) return r > 0 ? 'weakPositive' : 'weakNegative';
  return r > 0 ? 'strongPositive' : 'strongNegative';
}

// Attendance marking and the per-term percentage. Issue #31.
//
// `deflate8818` — the project's first supporter — asked on 2026-08-25.
//
// Two surfaces, because the request is really two questions:
//
//   1. "Was I in Tuesday's maths?"  — a per-lesson mark on a real date.
//   2. "How am I doing?"            — a percentage, per term and per course.
//
// The marking surface is a WEEK, not the schedule grid, and that distinction
// is the whole reason this is a separate view rather than a control bolted
// onto the timetable. The timetable shows a repeating pattern with no dates
// in it; attendance is about specific days. Marking "Tuesday maths" on a
// pattern would have no date to attach to.
//
// The percentage counts present / (present + absent). A CANCELLED lesson is
// in neither — it did not happen, and counting it as an absence would punish
// a student for their timetable. See src/lib/attendance.js.

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatLocale, toLocalISO, addDays, parseLocalDate } from '../../lib/dates.js';
import { resolveWeekStart, weekdayLabels, startOfWeek } from '../../lib/calendar.js';
import { lessonsOn, termCoversDate, termIndex } from '../../lib/timetable.js';
import {
  ATTENDANCE, indexAttendance, statusFor, nextStatus,
  summariseTerm, summariseByCourse,
} from '../../lib/attendance.js';
import * as outbox from '../../lib/outbox.js';

// One glyph per state. Text rather than icons: these sit inside a dense week
// grid at 11px, where a lucide icon at that size is a smudge, and the four
// states have to be told apart at a glance.
const GLYPH = {
  [ATTENDANCE.PRESENT]: '✓',
  [ATTENDANCE.ABSENT]: '✕',
  [ATTENDANCE.CANCELLED]: '—',
  [ATTENDANCE.RESCHEDULED]: '→',
};

function pct(value, t) {
  // `null` is "nothing recorded", NOT zero. A student who has marked nothing
  // has not attended 0% of their lessons, and "0%" is a false statement about
  // them in the one place they might screenshot it.
  if (value === null) return t('at.noData');
  return `${Math.round(value)}%`;
}

export default function Attendance({ state, dispatch, session, term }) {
  const { t } = useTranslation();
  const locale = formatLocale();
  // Memoised rather than recomputed inline. `resolveWeekStart` reads
  // localStorage, so React Compiler cannot prove it is stable across a render
  // — and an unmemoised link anywhere in this chain makes it refuse to
  // optimise everything downstream of it, which is what the lint rule was
  // telling us.
  const weekStart = useMemo(() => resolveWeekStart(locale), [locale]);

  const [anchor, setAnchor] = useState(() => toLocalISO(new Date()));
  const weekFrom = useMemo(() => startOfWeek(anchor, weekStart), [anchor, weekStart]);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekFrom, i)),
    [weekFrom],
  );

  const rows = useMemo(() => (state.attendance || []).filter((r) => !r.deletedAt), [state.attendance]);
  const index = useMemo(() => indexAttendance(rows), [rows]);
  const byId = useMemo(() => termIndex(state.academicTerms || []), [state.academicTerms]);

  const entriesById = useMemo(() => {
    const m = new Map();
    for (const e of state.timetableEntries || []) if (!e.deletedAt) m.set(e.id, e);
    return m;
  }, [state.timetableEntries]);

  // `lessonsOn` already resolves term specificity AND the new week parity, so
  // a fortnightly lesson simply does not appear on its off week — there is
  // nothing to mark, which is correct and needs no code here.
  const week = useMemo(
    () => days.map((iso) => ({ iso, lessons: lessonsOn(state, iso, weekStart) })),
    [days, state, weekStart],
  );

  const covers = useCallback(
    (trm, iso) => termCoversDate(trm, byId, iso),
    [byId],
  );

  const termSummary = useMemo(() => summariseTerm(rows, term, covers), [rows, term, covers]);
  const courseSummary = useMemo(() => {
    if (!term) return [];
    const inTerm = rows.filter((r) => covers(term, r.date));
    return summariseByCourse(inTerm, entriesById);
  }, [rows, term, covers, entriesById]);

  const cycle = useCallback((entryId, iso) => {
    const current = statusFor(index, entryId, iso);
    const next = nextStatus(current);
    dispatch({ type: 'SET_ATTENDANCE', timetableEntryId: entryId, date: iso, status: next });

    if (!session) return;
    // Read the row back after the dispatch would have created it, so the
    // queued payload carries the id the reducer actually assigned. The
    // existing row is reused when there is one — the server's unique index is
    // on (user, entry, date), so a second id for the same fact would be
    // rejected rather than duplicated, and the outbox would quarantine it.
    const existing = index.get(`${entryId}::${iso}`);
    if (next === null) {
      if (existing) outbox.enqueue('delete_attendance', { id: existing.id });
      return;
    }
    outbox.enqueue('upsert_attendance', {
      id: existing?.id,
      timetableEntryId: entryId,
      date: iso,
      status: next,
    });
  }, [index, dispatch, session]);

  const labels = weekdayLabels(weekStart, locale);
  const today = toLocalISO(new Date());

  return (
    <div className="at-wrap">
      <div className="at-head">
        <button className="btn-outline btn-sm" onClick={() => setAnchor(addDays(weekFrom, -7))}>
          {t('at.prevWeek')}
        </button>
        <div className="at-range">
          {parseLocalDate(weekFrom).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
          {' – '}
          {parseLocalDate(days[6]).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
        </div>
        <button className="btn-outline btn-sm" onClick={() => setAnchor(addDays(weekFrom, 7))}>
          {t('at.nextWeek')}
        </button>
        <button className="btn-outline btn-sm" onClick={() => setAnchor(today)}>
          {t('at.thisWeek')}
        </button>
      </div>

      {/* ── The percentage ── */}
      <div className="at-summary">
        <div className="at-summary-main">
          <div className="at-pct">{pct(termSummary.percent, t)}</div>
          <div className="at-pct-lbl">
            {term ? t('at.forTerm', { name: term.name }) : t('at.allTime')}
          </div>
        </div>
        <div className="at-counts">
          <span>{t('at.present', { n: termSummary.present })}</span>
          <span>{t('at.absent', { n: termSummary.absent })}</span>
          {/* Shown, and shown as NOT counted. A student who sees "3 cancelled"
              next to a percentage that ignores them learns the rule from the
              interface instead of having to be told it. */}
          {termSummary.cancelled > 0 && (
            <span className="at-uncounted">{t('at.cancelled', { n: termSummary.cancelled })}</span>
          )}
          {termSummary.rescheduled > 0 && (
            <span className="at-uncounted">{t('at.rescheduled', { n: termSummary.rescheduled })}</span>
          )}
        </div>
        {(termSummary.cancelled > 0 || termSummary.rescheduled > 0) && (
          <div className="at-note">{t('at.uncountedNote')}</div>
        )}
      </div>

      {/* ── The week ── */}
      <div className="at-week">
        {week.map(({ iso, lessons }, i) => (
          <div key={iso} className={`at-day${iso === today ? ' is-today' : ''}`}>
            <div className="at-day-head">
              <span className="at-day-dow">{labels[i]}</span>
              <span className="at-day-num">{parseLocalDate(iso).getDate()}</span>
            </div>
            {lessons.length === 0 && <div className="at-day-empty">{t('at.noLessons')}</div>}
            {lessons.map((l) => {
              const status = statusFor(index, l.id, iso);
              return (
                <button
                  key={l.id}
                  type="button"
                  className={`at-lesson${status ? ` is-${status}` : ''}`}
                  onClick={() => cycle(l.id, iso)}
                  // The cycle is not discoverable from the glyph alone, so the
                  // label says both what it is and what pressing does.
                  aria-label={t('at.cycleAria', {
                    lesson: l.title || t('tt.noCourse'),
                    status: status ? t(`at.status.${status}`) : t('at.unmarked'),
                  })}
                >
                  <span className="at-lesson-pip" style={{ background: l.color || 'var(--border2)' }} aria-hidden="true" />
                  <span className="at-lesson-name">{l.title}</span>
                  <span className="at-lesson-mark" aria-hidden="true">{status ? GLYPH[status] : '·'}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* ── Per course ──
          The overall figure is the headline; this is the one that answers the
          question behind the request, which is usually "which course am I
          actually behind in". Worst first. */}
      {courseSummary.length > 0 && (
        <div className="at-courses">
          <div className="at-courses-title">{t('at.byCourse')}</div>
          {courseSummary.map((c) => {
            const course = c.courseId ? state.courses?.[c.courseId] : null;
            return (
              <div key={c.courseId || 'none'} className="at-course-row">
                <span className="at-lesson-pip" style={{ background: course?.color || 'var(--border2)' }} aria-hidden="true" />
                <span className="at-course-name">{course?.name || t('tt.noCourse')}</span>
                <span className="at-course-counts">{c.present}/{c.counted}</span>
                <span className="at-course-pct">{pct(c.percent, t)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
  ATTENDANCE, indexAttendance, statusFor, nextStatus, attendanceKey,
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
  if (value === null) return t('att.noData');
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

  // Every attendance row in local state, including soft-deleted ones, keyed by
  // the natural key. `index` (from `indexAttendance`) deliberately drops
  // deleted rows because it backs the grid, but the enqueue path needs to find
  // a cleared row in order to revive it rather than mint a second id for a
  // fact the server stores once.
  const rowsByKey = useMemo(() => {
    const m = new Map();
    for (const r of rows || []) {
      if (r) m.set(attendanceKey(r.timetableEntryId, r.date), r);
    }
    return m;
  }, [rows]);

  const cycle = useCallback((entryId, iso) => {
    const current = statusFor(index, entryId, iso);
    const next = nextStatus(current);

    // The id is minted HERE and handed to both the reducer and the outbox, so
    // the two cannot disagree.
    //
    // v1.13 review, blocker A4: this used to read the id back from `index`
    // AFTER dispatching, on the assumption that the dispatch had already
    // created the row. It had not — `index` is memoised over the pre-dispatch
    // `rows`, and React has not re-rendered yet. For a new mark that meant
    // enqueueing `id: undefined` while the reducer minted a different uuid,
    // so the outbox item and local state described the same fact under two
    // identities from the moment it was created.
    //
    // An existing row (live OR cleared) is reused: the server's unique index
    // is total on (user, entry, date), so one lesson on one date is one row
    // forever and re-marking revives it.
    const existing = rowsByKey.get(attendanceKey(entryId, iso));
    const id = existing?.id || crypto.randomUUID();

    dispatch({
      type: 'SET_ATTENDANCE',
      id,
      timetableEntryId: entryId,
      date: iso,
      status: next,
    });

    if (!session) return;
    if (next === null) {
      // Nothing to delete if the row was never created locally, and nothing to
      // tell the server about either.
      if (existing) outbox.enqueue('delete_attendance', { id });
      return;
    }
    // `id` is carried for the outbox's own identity (`kind::payload.id`, which
    // is what lets a re-tap coalesce onto the pending item instead of growing
    // the queue). It is NOT sent to Supabase — `upsertAttendance` strips it,
    // because PostgREST would otherwise emit `DO UPDATE SET id = ...` and
    // reassign the row's primary key on every conflicting write.
    outbox.enqueue('upsert_attendance', {
      id,
      timetableEntryId: entryId,
      date: iso,
      status: next,
    });
  }, [index, rowsByKey, dispatch, session]);

  const labels = weekdayLabels(weekStart, locale);
  const today = toLocalISO(new Date());

  return (
    <div className="at-wrap">
      <div className="at-head">
        <button className="btn-outline btn-sm" onClick={() => setAnchor(addDays(weekFrom, -7))}>
          {t('att.prevWeek')}
        </button>
        <div className="at-range">
          {parseLocalDate(weekFrom).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
          {' – '}
          {parseLocalDate(days[6]).toLocaleDateString(locale, { day: 'numeric', month: 'short' })}
        </div>
        <button className="btn-outline btn-sm" onClick={() => setAnchor(addDays(weekFrom, 7))}>
          {t('att.nextWeek')}
        </button>
        <button className="btn-outline btn-sm" onClick={() => setAnchor(today)}>
          {t('att.thisWeek')}
        </button>
      </div>

      {/* ── The percentage ── */}
      <div className="at-summary">
        <div className="at-summary-main">
          <div className="at-pct">{pct(termSummary.percent, t)}</div>
          <div className="at-pct-lbl">
            {term ? t('att.forTerm', { name: term.name }) : t('att.allTime')}
          </div>
        </div>
        <div className="at-counts">
          <span>{t('att.present', { n: termSummary.present })}</span>
          <span>{t('att.absent', { n: termSummary.absent })}</span>
          {/* Shown, and shown as NOT counted. A student who sees "3 cancelled"
              next to a percentage that ignores them learns the rule from the
              interface instead of having to be told it. */}
          {termSummary.cancelled > 0 && (
            <span className="at-uncounted">{t('att.cancelled', { n: termSummary.cancelled })}</span>
          )}
          {termSummary.rescheduled > 0 && (
            <span className="at-uncounted">{t('att.rescheduled', { n: termSummary.rescheduled })}</span>
          )}
        </div>
        {(termSummary.cancelled > 0 || termSummary.rescheduled > 0) && (
          <div className="at-note">{t('att.uncountedNote')}</div>
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
            {lessons.length === 0 && <div className="at-day-empty">{t('att.noLessons')}</div>}
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
                  aria-label={t('att.cycleAria', {
                    lesson: l.title || t('tt.noCourse'),
                    status: status ? t(`att.status.${status}`) : t('att.unmarked'),
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
          <div className="at-courses-title">{t('att.byCourse')}</div>
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

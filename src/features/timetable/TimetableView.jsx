// v1.10 — the school timetable, and the term tree it hangs off.
//
// Owner: "different Jaksot have different schedules and I think it would be
// good to have that be seen in the same app as well." A Finnish upper-secondary
// timetable changes every period — five or six times a year — so a single fixed
// weekly grid is wrong by construction. What varies is not the lesson, it is
// which stretch of the year the lesson applies to.
//
// Hence: School Year > Semester > Jakso, and a schedule attaches at ANY of the
// three. Make one for a jakso when the jaksot differ; make one for the whole
// semester or year when they do not. `lib/timetable.js` resolves which wins on
// any given date (most specific with entries), and carries that reasoning.
//
// A lesson is NOT a study session and is never written to `study_sessions`.

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, CalendarRange } from 'lucide-react';
import Attendance from './Attendance.jsx';
import { shortenLabels } from '../../lib/courseLabels.js';
import {
  TERM_LEVELS, childLevel, childrenOf, termIndex, resolveTermRange,
  descendantTermIds, timeToMinutes, minutesToTime, minutesToSqlTime, flattenTerms,
  planSeriesWrite, entriesInSeries,
} from '../../lib/timetable.js';
import { resolveWeekStart, weekdayLabels } from '../../lib/calendar.js';
import { formatLocale, parseLocalDate } from '../../lib/dates.js';
import * as outbox from '../../lib/outbox.js';
import '../../styles/timetable.css';
import { enterSubmit } from '../../lib/imeSubmit.js';

const DEFAULT_LESSON_MIN = 75;
// Default hour window for the week grid. Referenced by name from desktop.css,
// which pairs it with a taller row height — the two together are what stop the
// page reading as a short strip beside List and Calendar.
const WEEK_FROM = 8;
const WEEK_TO = 17;

// One formatter, shared with the parser it round-trips against, so a change to
// either cannot leave the grid labelling times it can no longer read back.
const clock = minutesToTime;

/** Compact, locale-correct term range for the outline: "1 Aug – 31 May".
 *
 *  The raw ISO pair ("2026-08-01 → 2027-05-31") ran to roughly 140px of mono
 *  text in a 300px column, which left almost nothing for the term name — the
 *  owner reported the range sitting on top of the name, and truncating the name
 *  to fit would only have made that a tidier failure. The date is the thing
 *  that was too long, so the date is what got shorter.
 *
 *  `formatRange` rather than two formatted dates joined by a dash, for the same
 *  reason the calendar's week title uses it: which side the month falls on is a
 *  property of the locale, not something to hardcode. */
function formatTermRange(from, to, locale) {
  if (!from && !to) return null;
  const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const a = from ? parseLocalDate(from) : null;
  const b = to ? parseLocalDate(to) : null;
  if (a && b) {
    try { return fmt.formatRange(a, b); } catch { return `${fmt.format(a)} – ${fmt.format(b)}`; }
  }
  // One-sided ranges still say something useful; an open end is the normal
  // state for a term the user has not decided the end of yet.
  return a ? `${fmt.format(a)} –` : `– ${fmt.format(b)}`;
}

// ── Term tree ──────────────────────────────────────────────────────────────

function TermNode({ term, terms, depth, selectedId, onSelect, onAdd, onEdit, onDelete, t }) {
  const kids = childrenOf(terms, term.id);
  const next = childLevel(term.level);
  const byId = useMemo(() => termIndex(terms), [terms]);
  const { from, to } = resolveTermRange(term, byId);
  const range = formatTermRange(from, to, formatLocale());
  // Inherited dates are shown in a lighter weight, because "this jakso runs
  // Aug–Dec" is a very different statement when the jakso says so itself and
  // when it is merely sitting inside a semester that does.
  const ownDates = !!(term.startsOn || term.endsOn);

  return (
    <li className="tt-node">
      <div className={`tt-term${term.id === selectedId ? ' selected' : ''} lvl-${term.level}`} style={{ '--tt-depth': depth }}>
        <button type="button" className="tt-term-main" onClick={() => onSelect(term.id)}>
          <span className="tt-term-level">{t(`tt.level.${term.level}`)}</span>
          <span className="tt-term-name">{term.name}</span>
          {range && (
            // `title` keeps the exact ISO dates one hover away — the compact
            // form is for scanning, not for checking a boundary.
            <span className={`tt-term-dates${ownDates ? '' : ' inherited'}`} title={`${from || '…'} → ${to || '…'}`}>
              {range}
            </span>
          )}
        </button>
        <span className="tt-term-actions">
          {next && (
            <button type="button" onClick={() => onAdd(term.id, next)} title={t('tt.addChild', { level: t(`tt.level.${next}`) })}>
              <Plus size={13} strokeWidth={1.75} />
            </button>
          )}
          <button type="button" onClick={() => onEdit(term)} title={t('av.pl.edit')}>
            <Pencil size={12} strokeWidth={1.75} />
          </button>
          <button type="button" className="danger" onClick={() => onDelete(term)} title={t('common.delete')}>
            <Trash2 size={12} strokeWidth={1.75} />
          </button>
        </span>
      </div>
      {kids.length > 0 && (
        <ul className="tt-children">
          {kids.map((k) => (
            <TermNode
              key={k.id} term={k} terms={terms} depth={depth + 1}
              selectedId={selectedId} onSelect={onSelect}
              onAdd={onAdd} onEdit={onEdit} onDelete={onDelete} t={t}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TermForm({ draft, onSave, onClose, t }) {
  const [name, setName] = useState(draft.name || '');
  const [startsOn, setStartsOn] = useState(draft.startsOn || '');
  const [endsOn, setEndsOn] = useState(draft.endsOn || '');
  const [err, setErr] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr(t('tt.errName')); return; }
    // The DB carries the same check. Catching it here means the user gets a
    // sentence instead of a constraint violation surfacing five retries deep
    // in the outbox with no screen to show it on.
    if (startsOn && endsOn && endsOn < startsOn) { setErr(t('tt.errDates')); return; }
    onSave({ ...draft, name: trimmed, startsOn, endsOn });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {draft.id ? t('tt.editTerm') : t('tt.newTerm', { level: t(`tt.level.${draft.level}`) })}
        </div>
        <div className="input-group">
          <div className="input-label">{t('tt.fName')}</div>
          <input
            type="text" value={name} autoFocus
            onChange={(e) => { setName(e.target.value); setErr(''); }}
            placeholder={t(`tt.namePlaceholder.${draft.level}`)}
            {...enterSubmit(submit)}
          />
        </div>
        <div className="tt-form-row">
          <div className="input-group">
            <div className="input-label">{t('tt.fStarts')}</div>
            <input type="date" value={startsOn} onChange={(e) => { setStartsOn(e.target.value); setErr(''); }} />
          </div>
          <div className="input-group">
            <div className="input-label">{t('tt.fEnds')}</div>
            <input type="date" value={endsOn} onChange={(e) => { setEndsOn(e.target.value); setErr(''); }} />
          </div>
        </div>
        <div className="tt-hint">{t('tt.datesHint')}</div>
        {err && <div className="tt-error">{err}</div>}
        <div className="plan-actions">
          <button className="btn" onClick={submit}>{t('common.save')}</button>
          <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Lesson form ────────────────────────────────────────────────────────────

function LessonForm({ draft, courses, terms, onSave, onDelete, onClose, t }) {
  const [subjectId, setSubjectId] = useState(draft.subjectId || '');
  // v1.14 Item 6b (#51) — "there's no way to move a lesson between the year,
  // the semester and the jakso without deleting it and typing it in again".
  // The scope is a foreign key, so moving one is an edit; what made it
  // impossible was that the editor had no field for it and `saveLesson`
  // hard-wired whichever term the sidebar happened to have selected.
  const [termId, setTermId] = useState(draft.termId || '');
  // v1.14 Item 6a — the weekday is a SET now. `draft.weekdays` is supplied by
  // the caller, which knows whether this lesson is already part of a series;
  // falling back to the single weekday keeps every existing lesson working.
  const [weekdays, setWeekdays] = useState(
    () => new Set((draft.weekdays && draft.weekdays.length ? draft.weekdays : [draft.weekday]).map(Number)),
  );
  const [title, setTitle] = useState(draft.title || '');
  const [start, setStart] = useState(clock(draft.startMin));
  const [end, setEnd] = useState(clock(draft.endMin));
  const [room, setRoom] = useState(draft.room || '');
  // v1.13 — '' is "every week" and maps to null on save. A select rather than
  // a checkbox pair: "every week / week A / week B" is one choice with three
  // answers, and two checkboxes would allow the meaningless both-and-neither.
  const [parity, setParity] = useState(draft.weekParity ? String(draft.weekParity) : '');
  const [err, setErr] = useState('');
  const locale = formatLocale();
  const weekStart = resolveWeekStart(locale);
  const labels = weekdayLabels(weekStart, locale);
  const termOptions = flattenTerms(terms);
  const moved = !!draft.id && !!termId && termId !== draft.termId;

  const submit = () => {
    const s = timeToMinutes(start), e = timeToMinutes(end);
    if (s === null || e === null) { setErr(t('tt.errTime')); return; }
    if (e <= s) { setErr(t('tt.errOrder')); return; }
    // The DB requires a subject OR a non-blank title. Enforced here so the row
    // is never queued in a shape the server is certain to reject.
    if (!subjectId && !title.trim()) { setErr(t('tt.errIdentity')); return; }
    // A lesson on no days is not a lesson. Refused here rather than saved as a
    // deletion: `planSeriesWrite` would otherwise be asked to remove every day
    // in the series through the Save button, which is not what Save means.
    if (weekdays.size === 0) { setErr(t('tt.errNoDays')); return; }
    onSave({
      ...draft,
      termId: termId || draft.termId,
      subjectId: subjectId || null,
      title: title.trim(),
      weekdays: [...weekdays].sort((a, b) => a - b),
      startsAt: minutesToSqlTime(s),
      endsAt: minutesToSqlTime(e),
      room: room.trim(),
      weekParity: parity === '1' || parity === '2' ? Number(parity) : null,
    });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{draft.id ? t('tt.editLesson') : t('tt.newLesson')}</div>
        <div className="input-group">
          <div className="input-label">{t('sv.fCourse')}</div>
          <select value={subjectId} onChange={(e) => { setSubjectId(e.target.value); setErr(''); }}>
            <option value="">{t('tt.noCourse')}</option>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="input-group">
          <div className="input-label">{t('tt.fLabel')}</div>
          <input
            type="text" value={title}
            onChange={(e) => { setTitle(e.target.value); setErr(''); }}
            placeholder={t('tt.labelPlaceholder')}
          />
        </div>
        {/* Full width, above the times: seven toggles do not fit in a third of
            a row, and the day set is the first thing you check when you open
            this form. */}
        <div className="input-group">
            <div className="input-label">{t('tt.fDays')}</div>
            {/* v1.14 Item 6a — toggles, not a <select multiple>. Seven items is
                small enough to show at once, and a multi-select on a phone
                hides the very thing this control exists to make obvious: which
                days this lesson runs on.

                Rendered in the LOCALE's week order but carrying the real
                `getDay()` value, so a Monday-first user picks Monday from the
                left and still stores 1. */}
            <div className="tt-daypick" role="group" aria-label={t('tt.fDays')}>
              {labels.map((label, i) => {
                const dayValue = (weekStart + i) % 7;
                const on = weekdays.has(dayValue);
                return (
                  <button
                    key={dayValue}
                    type="button"
                    className={'tt-daypick-btn' + (on ? ' on' : '')}
                    aria-pressed={on}
                    onClick={() => {
                      setErr('');
                      setWeekdays((prev) => {
                        const next = new Set(prev);
                        if (next.has(dayValue)) next.delete(dayValue); else next.add(dayValue);
                        return next;
                      });
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
        </div>
        <div className="tt-form-row">
          <div className="input-group">
            <div className="input-label">{t('tt.fStart')}</div>
            <input type="time" step="300" value={start} onChange={(e) => { setStart(e.target.value); setErr(''); }} />
          </div>
          <div className="input-group">
            <div className="input-label">{t('tt.fEnd')}</div>
            <input type="time" step="300" value={end} onChange={(e) => { setEnd(e.target.value); setErr(''); }} />
          </div>
        </div>
        <div className="input-group">
          <div className="input-label">{t('tt.fRoom')}</div>
          <input type="text" value={room} onChange={(e) => setRoom(e.target.value)} placeholder={t('tt.roomPlaceholder')} />
        </div>
        {/* v1.13 — alternating weeks. Counted from the start of the term this
            lesson's schedule is attached to, which is what the note below
            says out loud: without it, "week A" is a label with no anchor and
            two users will read it two different ways. */}
        <div className="input-group">
          <div className="input-label">{t('tt.fRepeat')}</div>
          <select value={parity} onChange={(e) => setParity(e.target.value)}>
            <option value="">{t('tt.repeatEvery')}</option>
            <option value="1">{t('tt.repeatOdd')}</option>
            <option value="2">{t('tt.repeatEven')}</option>
          </select>
          {parity && <div className="tt-hint">{t('tt.repeatNote')}</div>}
        </div>
        {/* Only when there is an existing lesson to move. On a NEW one the
            scope is the term the user is looking at, and offering to file it
            somewhere else invites creating a lesson that then vanishes from
            the grid they created it on. */}
        {draft.id && termOptions.length > 1 && (
          <div className="input-group">
            <div className="input-label">{t('tt.fScope')}</div>
            <select value={termId} onChange={(e) => setTermId(e.target.value)}>
              {termOptions.map(({ term, depth }) => (
                <option key={term.id} value={term.id}>
                  {`${'\u00a0\u00a0'.repeat(depth)}${depth ? '\u2514 ' : ''}${term.name}`}
                </option>
              ))}
            </select>
            {/* The one consequence that is not obvious. Parity is counted from
                the START OF THE TERM the lesson hangs off, so the same "week
                A" lands on different weeks under a different term — see
                weekParityOf. Said here rather than discovered a fortnight
                later. */}
            {moved && parity && <div className="tt-hint">{t('tt.scopeParityNote')}</div>}
            {moved && !parity && <div className="tt-hint">{t('tt.scopeNote')}</div>}
          </div>
        )}
        {err && <div className="tt-error">{err}</div>}
        <div className="plan-actions">
          <button className="btn" onClick={submit}>{t('common.save')}</button>
          <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          {draft.id && (
            <button className="btn-danger-text plan-delete" onClick={onDelete}>
              <Trash2 size={13} strokeWidth={1.75} />{' '}
              {draft.weekdays && draft.weekdays.length > 1
                ? t('tt.deleteSeries', { count: draft.weekdays.length })
                : t('common.delete')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Weekly grid ────────────────────────────────────────────────────────────

function WeekGrid({ entries, courses, weekStart, locale, onAdd, onEdit, t }) {
  const labels = weekdayLabels(weekStart, locale);
  const cols = labels.map((label, i) => ({ label, weekday: (weekStart + i) % 7 }));

  const parsed = entries
    .map((e) => ({ e, from: timeToMinutes(e.startsAt), to: timeToMinutes(e.endsAt) }))
    .filter((x) => x.from !== null && x.to !== null && x.to > x.from);

  // Seven day columns on a phone leave roughly eight characters per block, and
  // the owner takes a full year of Pre-IB courses — so every block on the grid
  // truncated to the same three letters, "Pre", and the timetable stopped
  // saying anything at a glance. `shortenLabels` drops the words EVERY course
  // shares, and no more than it must to tell them apart. Computed across the
  // whole grid rather than per column, so a course reads the same on Monday as
  // it does on Friday.
  const displayName = (e) => e.title
    || (e.subjectId && !courses[e.subjectId]?.deletedAt ? courses[e.subjectId]?.name : null)
    || t('tt.lesson');
  // Measured over the COURSE LIST rather than over the lesson titles on the
  // grid. A lesson the user retitled by hand, or a term holding a single
  // course, would otherwise change how every other label is shortened.
  // Applied at EVERY tier, including desktop. This was briefly gated to the
  // narrow tiers on the assumption that a desktop column has room for a full
  // course name; measured, it does not. The default desktop layout puts the
  // grid in a ~669px pane beside the term tree, which is 67px of text per
  // block — "Pre-IB Mathematics" wants 96px and truncates, while
  // "Mathematics" wants 62px and fits. Seven columns is narrow at any window
  // size, so the shortening earns its place everywhere.
  const shortLabelMap = shortenLabels(
    Object.values(courses || {})
      .filter((c) => c && !c.deletedAt && !c.archivedAt)
      .map((c) => c.name),
  );
  const shortName = (e) => {
    const full = displayName(e);
    return shortLabelMap.get(full) || full;
  };

  // The window fits the timetable rather than assuming a school day. A single
  // 07:15 lesson widens the grid; an empty term still gets the full default
  // window so the columns are clickable rather than collapsed to nothing.
  //
  // 08–17 rather than 08–16: the extra hour is where the after-school slot and
  // most club/training-shaped commitments land, and a grid that stops at 16:00
  // cannot be clicked to create one. Paired with the taller desktop row height
  // in desktop.css — together they fix the page reading as a short strip.
  let from = WEEK_FROM, to = WEEK_TO;
  for (const x of parsed) {
    from = Math.min(from, Math.floor(x.from / 60));
    to = Math.max(to, Math.ceil(x.to / 60));
  }
  const hours = Array.from({ length: Math.max(1, to - from) }, (_, i) => from + i);
  const top = (m) => ((m - from * 60) / 60) * 100 / hours.length;
  const height = (m) => (m / 60) * 100 / hours.length;

  return (
    <div className="tt-grid" style={{ '--tt-hour-count': hours.length }}>
      <div className="tt-grid-head">
        <div />
        {cols.map((c) => <div key={c.weekday} className="tt-grid-dow">{c.label}</div>)}
      </div>
      <div className="tt-grid-body">
        <div className="tt-grid-gutter">
          {hours.map((h) => <div key={h} className="tt-grid-hour">{String(h).padStart(2, '0')}</div>)}
        </div>
        {cols.map((c) => (
          <div
            key={c.weekday}
            className="tt-grid-col"
            role="button"
            tabIndex={0}
            aria-label={t('tt.addOn', { day: c.label })}
            onClick={(ev) => {
              if (ev.target !== ev.currentTarget && !ev.target.classList?.contains('tt-grid-line')) return;
              const rect = ev.currentTarget.getBoundingClientRect();
              const raw = ((ev.clientY - rect.top) / rect.height) * (hours.length * 60) + from * 60;
              // Snapped to five minutes: school periods start at :15 and :45 as
              // often as on the hour, and rounding to :00 would fight the user
              // on almost every real timetable.
              const startMin = Math.max(0, Math.min(24 * 60 - DEFAULT_LESSON_MIN, Math.round(raw / 5) * 5));
              onAdd(c.weekday, startMin);
            }}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return;
              if (ev.target !== ev.currentTarget) return;
              ev.preventDefault();
              onAdd(c.weekday, from * 60);
            }}
          >
            {hours.map((h) => <div key={h} className="tt-grid-line" />)}
            {parsed.filter((x) => x.e.weekday === c.weekday).map(({ e, from: s, to: en }) => {
              const course = e.subjectId ? courses[e.subjectId] : null;
              const live = course && !course.deletedAt ? course : null;
              const color = e.color || live?.color || null;
              return (
                <button
                  key={e.id}
                  type="button"
                  className="tt-lesson"
                  style={{
                    top: `${top(s)}%`,
                    height: `${height(en - s)}%`,
                    '--tt-color': color || 'var(--border2)',
                    '--tt-wash': color ? `${color}18` : 'var(--surface2)',
                  }}
                  onClick={(ev) => { ev.stopPropagation(); onEdit(e); }}
                >
                  <span className="tt-lesson-title" title={displayName(e)}>{shortName(e)}</span>
                  <span className="tt-lesson-meta">
                    {/* The time hides on a phone and the room does not. The
                        block's own position on the grid already states when it
                        is; nothing on screen stated WHERE it is, which is half
                        of what a timetable gets checked for on the way there. */}
                    <span className="tt-lesson-time">{clock(s)}–{clock(en)}</span>
                    {e.room && <span className="tt-lesson-room">{e.room}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── View ───────────────────────────────────────────────────────────────────

export default function TimetableView({ state, dispatch, session, showFlash }) {
  const { t } = useTranslation();
  const locale = formatLocale();
  const weekStart = useMemo(() => resolveWeekStart(locale), [locale]);

  // Memoised because `|| []` mints a new array on every render, which would
  // make every hook keyed on `terms` recompute even when nothing changed.
  const terms = useMemo(() => state.academicTerms || [], [state.academicTerms]);
  const roots = useMemo(() => childrenOf(terms, null), [terms]);
  const [selectedId, setSelectedId] = useState(null);
  const [termDraft, setTermDraft] = useState(null);
  const [lessonDraft, setLessonDraft] = useState(null);
  // v1.13 — Schedule / Attendance. A sub-tab rather than a fourth Plan tab or
  // a fifth bottom tab, for the reason the rest of this app already settled:
  // the bottom bar is sized for four. Attendance also genuinely belongs
  // *inside* the timetable — it is the same lessons, on real dates.
  const [sub, setSub] = useState('schedule');

  const byId = useMemo(() => termIndex(terms), [terms]);
  // Falls back to the first root so the grid has something to show on arrival
  // rather than an instruction to click a term the user can already see.
  const selected = (selectedId && byId.get(selectedId)) || roots[0] || null;
  const entries = useMemo(
    () => (state.timetableEntries || []).filter((e) => !e.deletedAt && e.termId === selected?.id),
    [state.timetableEntries, selected],
  );
  const courses = useMemo(
    () => Object.values(state.courses || {}).filter((c) => !c.deletedAt && !c.archivedAt),
    [state.courses],
  );

  const saveTerm = (form) => {
    if (form.id) {
      dispatch({ type: 'EDIT_TERM', id: form.id, name: form.name, startsOn: form.startsOn, endsOn: form.endsOn });
      if (session) outbox.enqueue('upsert_term', { id: form.id, parentId: form.parentId, level: form.level, name: form.name, startsOn: form.startsOn, endsOn: form.endsOn, position: form.position || 0 });
    } else {
      const id = crypto.randomUUID();
      // Position is the count of existing siblings, so a new jakso lands after
      // the ones already there instead of sorting alphabetically into the
      // middle of a sequence that is inherently ordinal.
      const position = childrenOf(terms, form.parentId || null).length;
      dispatch({ type: 'ADD_TERM', id, parentId: form.parentId, level: form.level, name: form.name, startsOn: form.startsOn, endsOn: form.endsOn, position });
      if (session) outbox.enqueue('upsert_term', { id, parentId: form.parentId, level: form.level, name: form.name, startsOn: form.startsOn, endsOn: form.endsOn, position });
      setSelectedId(id);
    }
    setTermDraft(null);
    showFlash?.(t('tt.termSaved'));
  };

  const removeTerm = (term) => {
    const descendantIds = descendantTermIds(terms, term.id);
    dispatch({ type: 'DELETE_TERM', id: term.id, descendantIds });
    if (session) outbox.enqueue('delete_term', { id: term.id, descendantIds });
    if (selectedId === term.id || descendantIds.includes(selectedId)) setSelectedId(null);
    showFlash?.(descendantIds.length
      ? t('tt.termDeletedTree', { n: descendantIds.length })
      : t('tt.termDeleted'));
  };

  // v1.14 Item 6a — a lesson is a SET of weekdays now, so saving reconciles
  // that set against what is already stored rather than writing one row.
  //
  // The series is the unit of editing: time, course, room, parity and term are
  // shared by every day in it, which is what makes it a series rather than
  // several lessons that happen to look alike. Everything except the weekday
  // therefore goes into `base` and lands on all of them.
  const saveLesson = (form) => {
    const base = {
      // v1.14 Item 6b — the form's choice, when it made one. A new lesson has
      // no `termId` in its draft and still lands in the selected term.
      termId: form.termId || selected.id,
      subjectId: form.subjectId,
      title: form.title,
      startsAt: form.startsAt,
      endsAt: form.endsAt,
      room: form.room,
      color: form.color || null,
      weekParity: form.weekParity ?? null,
    };

    // A lesson that has never been grouped gets a series id the first time it
    // is saved, whether or not it gains a second day. One rule, and the id is
    // then already there if a day is added later.
    const seriesId = form.seriesId || crypto.randomUUID();
    // Its own row counts as part of the series even before it had an id —
    // otherwise editing a long-standing single-day lesson would leave the
    // original row behind and write a second one beside it.
    const existing = form.id
      ? [...new Set([
        ...entriesInSeries(state.timetableEntries, form.seriesId),
        ...(state.timetableEntries || []).filter((e) => e.id === form.id && !e.deletedAt),
      ])]
      : [];

    const { upserts, deleteIds } = planSeriesWrite({
      existing,
      seriesId,
      weekdays: form.weekdays,
      base,
      newId: () => crypto.randomUUID(),
    });
    if (upserts.length === 0) return;

    for (const row of upserts) {
      const { id, ...rest } = row;
      const known = (state.timetableEntries || []).some((e) => e.id === id);
      dispatch({ type: known ? 'EDIT_TT_ENTRY' : 'ADD_TT_ENTRY', id, ...rest });
      if (session) outbox.enqueue('upsert_timetable', { id, ...rest });
    }
    // Days the user unticked. Deleted one at a time through the same path a
    // single delete uses, so nothing new can go wrong here that would not
    // already be wrong there.
    for (const id of deleteIds) {
      dispatch({ type: 'DELETE_TT_ENTRY', id });
      if (session) outbox.enqueue('delete_timetable', { id });
    }

    setLessonDraft(null);
    showFlash?.(upserts.length > 1
      ? t('tt.lessonSavedDays', { count: upserts.length })
      : t('tt.lessonSaved'));
  };

  // v1.14 Item 6a — Delete removes the whole set, because the set is what the
  // form edits. Dropping a single day is unticking it and saving, which is
  // where the user already is. The button says "all N days" when there is more
  // than one, so this is never a surprise — the commitment editor made the
  // same call for the same reason.
  const removeLesson = () => {
    if (!lessonDraft?.id) return;
    const ids = [...new Set([
      lessonDraft.id,
      ...entriesInSeries(state.timetableEntries, lessonDraft.seriesId).map((e) => e.id),
    ])];
    dispatch({ type: 'DELETE_TT_ENTRIES', ids });
    if (session) for (const id of ids) outbox.enqueue('delete_timetable', { id });
    setLessonDraft(null);
    showFlash?.(ids.length > 1 ? t('tt.lessonDeletedDays', { count: ids.length }) : t('tt.lessonDeleted'));
  };

  const range = selected ? resolveTermRange(selected, byId) : { from: null, to: null };
  const unbounded = selected && !range.from;

  return (
    <div className="tt">
      <div className="tt-panes">
        <aside className="tt-tree">
          <div className="section-label">
            {t('tt.terms')}
            <button
              className="btn btn-sm"
              style={{ marginLeft: 'auto' }}
              onClick={() => setTermDraft({ level: TERM_LEVELS[0], parentId: null })}
            >
              {t('tt.addYear')}
            </button>
          </div>
          {roots.length === 0 && (
            <div className="tt-empty">
              <CalendarRange size={20} strokeWidth={1.5} />
              <div className="tt-empty-title">{t('tt.emptyTitle')}</div>
              <div className="tt-empty-body">{t('tt.emptyBody')}</div>
            </div>
          )}
          <ul className="tt-roots">
            {roots.map((r) => (
              <TermNode
                key={r.id} term={r} terms={terms} depth={0}
                selectedId={selected?.id} onSelect={setSelectedId}
                onAdd={(parentId, level) => setTermDraft({ parentId, level })}
                onEdit={(term) => setTermDraft(term)}
                onDelete={removeTerm}
                t={t}
              />
            ))}
          </ul>
        </aside>

        <section className="tt-main">
          {!selected && <div className="empty">{t('tt.pickTerm')}</div>}
          {selected && (
            <>
              <div className="tt-main-head">
                <div>
                  <div className="tt-main-title">{selected.name}</div>
                  <div className="tt-main-sub">
                    {t(`tt.level.${selected.level}`)}
                    {range.from && <span> · {range.from} → {range.to || t('tt.openEnded')}</span>}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  onClick={() => setLessonDraft({ weekday: weekStart, startMin: 9 * 60, endMin: 9 * 60 + DEFAULT_LESSON_MIN })}
                >
                  {t('tt.addLesson')}
                </button>
              </div>

              {/* Stated rather than silently tolerated. A term with no start
                  date resolves to no dates at all, which means its lessons
                  never appear on the calendar — and a timetable you have
                  filled in that draws nowhere is a bug from where the user is
                  sitting unless the app says why. */}
              {unbounded && <div className="tt-warn">{t('tt.warnNoDates')}</div>}

              <div className="timer-subtabs" role="tablist" aria-label={t('tt.sections')}>
                {[['schedule', 'tt.tabSchedule'], ['attendance', 'att.tab']].map(([id, key]) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={sub === id}
                    className={`timer-subtab${sub === id ? ' active' : ''}`}
                    onClick={() => setSub(id)}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>

              {sub === 'attendance' && (
                <Attendance state={state} dispatch={dispatch} session={session} term={selected} />
              )}

              {sub === 'schedule' && <WeekGrid
                entries={entries}
                courses={state.courses || {}}
                weekStart={weekStart}
                locale={locale}
                onAdd={(weekday, startMin) => setLessonDraft({
                  weekday,
                  startMin,
                  endMin: Math.min(24 * 60, startMin + DEFAULT_LESSON_MIN),
                })}
                onEdit={(e) => {
                  // v1.14 Item 6a — open the SET, not the day that was tapped.
                  // Tapping Wednesday on a Mon/Wed lesson and seeing a form
                  // that only knows about Wednesday is how you end up with two
                  // lessons that were meant to be one.
                  const days = entriesInSeries(state.timetableEntries, e.seriesId).map((x) => x.weekday);
                  return setLessonDraft({
                    id: e.id,
                    seriesId: e.seriesId || null,
                    termId: e.termId,
                    subjectId: e.subjectId || '',
                    title: e.title || '',
                    weekday: e.weekday,
                    weekdays: days.length ? days : [e.weekday],
                    startMin: timeToMinutes(e.startsAt) ?? 9 * 60,
                    endMin: timeToMinutes(e.endsAt) ?? 10 * 60,
                    room: e.room || '',
                    color: e.color || null,
                    weekParity: e.weekParity ?? null,
                  });
                }}
                t={t}
              />}
            </>
          )}
        </section>
      </div>

      {termDraft && (
        <TermForm draft={termDraft} onSave={saveTerm} onClose={() => setTermDraft(null)} t={t} />
      )}
      {lessonDraft && selected && (
        <LessonForm
          draft={lessonDraft}
          terms={terms}
          courses={courses}
          onSave={saveLesson}
          onDelete={removeLesson}
          onClose={() => setLessonDraft(null)}
          t={t}
        />
      )}
    </div>
  );
}

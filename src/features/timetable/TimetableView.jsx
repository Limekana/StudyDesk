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
import { shortenLabels } from '../../lib/courseLabels.js';
import {
  TERM_LEVELS, childLevel, childrenOf, termIndex, resolveTermRange,
  descendantTermIds, timeToMinutes, minutesToTime, minutesToSqlTime,
} from '../../lib/timetable.js';
import { resolveWeekStart, weekdayLabels } from '../../lib/calendar.js';
import { formatLocale, parseLocalDate } from '../../lib/dates.js';
import * as outbox from '../../lib/outbox.js';
import '../../styles/timetable.css';

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
            onKeyDown={(e) => e.key === 'Enter' && submit()}
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

function LessonForm({ draft, courses, onSave, onDelete, onClose, t }) {
  const [subjectId, setSubjectId] = useState(draft.subjectId || '');
  const [title, setTitle] = useState(draft.title || '');
  const [weekday, setWeekday] = useState(String(draft.weekday));
  const [start, setStart] = useState(clock(draft.startMin));
  const [end, setEnd] = useState(clock(draft.endMin));
  const [room, setRoom] = useState(draft.room || '');
  const [err, setErr] = useState('');
  const locale = formatLocale();
  const weekStart = resolveWeekStart(locale);
  const labels = weekdayLabels(weekStart, locale);

  const submit = () => {
    const s = timeToMinutes(start), e = timeToMinutes(end);
    if (s === null || e === null) { setErr(t('tt.errTime')); return; }
    if (e <= s) { setErr(t('tt.errOrder')); return; }
    // The DB requires a subject OR a non-blank title. Enforced here so the row
    // is never queued in a shape the server is certain to reject.
    if (!subjectId && !title.trim()) { setErr(t('tt.errIdentity')); return; }
    onSave({
      ...draft,
      subjectId: subjectId || null,
      title: title.trim(),
      weekday: Number(weekday),
      startsAt: minutesToSqlTime(s),
      endsAt: minutesToSqlTime(e),
      room: room.trim(),
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
        <div className="tt-form-row">
          <div className="input-group">
            <div className="input-label">{t('tt.fDay')}</div>
            <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {/* Options are generated in the LOCALE's week order but carry the
                  real `getDay()` value, so a Monday-first user picks Monday
                  from the top of the list and still stores 1. */}
              {labels.map((label, i) => {
                const dayValue = (weekStart + i) % 7;
                return <option key={dayValue} value={dayValue}>{label}</option>;
              })}
            </select>
          </div>
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
        {err && <div className="tt-error">{err}</div>}
        <div className="plan-actions">
          <button className="btn" onClick={submit}>{t('common.save')}</button>
          <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
          {draft.id && (
            <button className="btn-danger-text plan-delete" onClick={onDelete}>
              <Trash2 size={13} strokeWidth={1.75} /> {t('common.delete')}
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

  const saveLesson = (form) => {
    const payload = {
      termId: selected.id,
      subjectId: form.subjectId,
      title: form.title,
      weekday: form.weekday,
      startsAt: form.startsAt,
      endsAt: form.endsAt,
      room: form.room,
      color: form.color || null,
    };
    if (form.id) {
      dispatch({ type: 'EDIT_TT_ENTRY', id: form.id, ...payload });
      if (session) outbox.enqueue('upsert_timetable', { id: form.id, ...payload });
    } else {
      const id = crypto.randomUUID();
      dispatch({ type: 'ADD_TT_ENTRY', id, ...payload });
      if (session) outbox.enqueue('upsert_timetable', { id, ...payload });
    }
    setLessonDraft(null);
    showFlash?.(t('tt.lessonSaved'));
  };

  const removeLesson = () => {
    if (!lessonDraft?.id) return;
    dispatch({ type: 'DELETE_TT_ENTRY', id: lessonDraft.id });
    if (session) outbox.enqueue('delete_timetable', { id: lessonDraft.id });
    setLessonDraft(null);
    showFlash?.(t('tt.lessonDeleted'));
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

              <WeekGrid
                entries={entries}
                courses={state.courses || {}}
                weekStart={weekStart}
                locale={locale}
                onAdd={(weekday, startMin) => setLessonDraft({
                  weekday,
                  startMin,
                  endMin: Math.min(24 * 60, startMin + DEFAULT_LESSON_MIN),
                })}
                onEdit={(e) => setLessonDraft({
                  id: e.id,
                  subjectId: e.subjectId || '',
                  title: e.title || '',
                  weekday: e.weekday,
                  startMin: timeToMinutes(e.startsAt) ?? 9 * 60,
                  endMin: timeToMinutes(e.endsAt) ?? 10 * 60,
                  room: e.room || '',
                  color: e.color || null,
                })}
                t={t}
              />
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

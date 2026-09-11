// The Notebook screen.
//
// ── §3, the feature's reason to exist ────────────────────────────────────
//
// The build plan is unambiguous that the timer linkage is not a stretch goal:
//
//   > "The timer linkage is an ACCEPTANCE CRITERION, not a stretch goal. A
//      note editor without it loses to Obsidian and OneNote on features; with
//      it, the notes are already scoped to the course you are studying, one
//      tap from a running timer, no search. Ship the editor without the
//      linkage and you ship the losing half."
//
// So it is wired first here, not last:
//   * the tree auto-scopes to the course selected in the timer;
//   * a SCOPED TO SESSION block appears at the top of the sidebar;
//   * the timer shrinks to a corner pill — the EXISTING TimerPill at its
//     existing size, mounted in a new position, not restyled (§3 rule 2);
//   * the note records the session id, so a debrief can list what was written
//     during it (§3 rule 3).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import NotebookTree from './NotebookTree.jsx';
import NoteEditor from './NoteEditor.jsx';
import TimerPill from '../timer/TimerPill.jsx';
import { readTimerSnapshot, subscribeTimer } from '../../lib/timerSnapshot.js';

function newId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch { /* insecure context */ }
  // Same fallback shape as the feedback id in SettingsView: the column is
  // `uuid`, so an invented "note-1a2b" string would be rejected by Postgres.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export default function NotebookView({ state, dispatch, onDeleteNote, onOpenTimer }) {
  const { t } = useTranslation();

  const courses = useMemo(
    () => Object.values(state.courses || {}).filter((c) => c && !c.deletedAt && !c.archivedAt),
    [state.courses],
  );
  const notes = useMemo(() => (state.notes || []).filter((n) => !n.deletedAt), [state.notes]);

  const [timer, setTimer] = useState(() => readTimerSnapshot());
  useEffect(() => subscribeTimer(() => setTimer(readTimerSnapshot())), []);

  // Set when the user explicitly opens another course while a session is
  // running. §3 rule 1: the scope is a default, not a lock, and this records
  // that the user has overridden it.
  const [unscoped, setUnscoped] = useState(false);

  const sessionCourseId = timer?.courseId || null;
  const scopedCourseId = !unscoped && sessionCourseId ? sessionCourseId : null;

  // ── The notebook's navigation on a phone ────────────────────────────────
  //
  // The tree is `display: none` below 768px (notebook.css, RESPONSIVE), and
  // nothing replaced it, so on a phone the notebook had no navigation at all:
  // the only reachable action was the empty state's "New note". Measured on
  // the built bundle at 393px — write a note, leave the sub-tab, come back:
  //
  //     .nb-tree display : none
  //     note rows in DOM : 0          (visible: 0)
  //     empty state      : "Pick a note, or start a new one." + New note
  //     press New note   : a SECOND note, the first now unreachable
  //
  // The note was saved and the header said so — "Edited 9/11/2026, 10:47" —
  // which is the whole of the report: notes that save and then cannot be
  // picked, viewed or re-edited. StudyDesk is a phone app first, so the
  // feature shipped with its navigation on the one form factor that is not
  // the product.
  //
  // The phone answer is a list ↔ note flow, not a drawer: the tree already IS
  // the list, so it takes the screen when there is no note to show or the user
  // asks for it, and the note takes the screen otherwise. That needs no
  // overlay, no scrim and no fixed positioning to fight the docked format bar
  // and the keyboard inset over. On desktop both panes are always up and
  // `is-list` is inert — its rules live inside the phone media query.
  const [browsing, setBrowsing] = useState(false);

  // `null` means "nothing chosen yet"; the scoped default fills in below.
  // Deliberately NOT resolved in an effect: setState during an effect causes a
  // cascading render, and more importantly it makes the scoped default a
  // WRITE, so a user who closed a note would have it silently reopened on the
  // next render. Derived, it is a default that a real choice overrides.
  const [chosenId, setChosenId] = useState(null);

  // Seeded ONCE, from the scope at mount, rather than kept in sync by an
  // effect. "Open the notebook during a session and that course is expanded"
  // is a starting condition, not an invariant — an effect enforcing it would
  // reopen the course every time the user collapsed it, which is §3's "it is
  // a default, not a lock" broken in the other direction.
  const [expanded, setExpanded] = useState(
    () => (scopedCourseId ? new Set([scopedCourseId]) : new Set()),
  );

  // Auto-scope, DERIVED: opening the notebook during a running session lands
  // on that course's most recent note. This is the "one tap from a running
  // timer, no search" claim, and it has to happen without the user asking or
  // the claim is untrue.
  const activeId = useMemo(() => {
    if (chosenId) return chosenId;
    if (!scopedCourseId) return null;
    const forCourse = notes
      .filter((n) => n.courseId === scopedCourseId)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return forCourse[0]?.id ?? null;
  }, [chosenId, scopedCourseId, notes]);

  const active = notes.find((n) => n.id === activeId) || null;

  const toggleCourse = useCallback((courseId, opts) => {
    if (opts?.unscope) setUnscoped(true);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(courseId)) next.delete(courseId);
      else next.add(courseId);
      return next;
    });
  }, []);

  const createNote = useCallback((courseId) => {
    const id = newId();
    dispatch({
      type: 'ADD_NOTE',
      note: {
        id,
        courseId: courseId ?? null,
        title: '',
        lessonDate: null,
        content: '',
        // §3 rule 3 — recorded at creation, because that is when we know it.
        // Attaching it later would need a guess about which session a note
        // "belongs" to, and a wrong guess is worse than no link.
        sessionId: timer?.sessionId || null,
      },
    });
    setChosenId(id);
    setBrowsing(false);
    if (courseId) setExpanded((prev) => new Set(prev).add(courseId));
  }, [dispatch, timer]);

  // Picking a note on a phone is also leaving the list. On desktop the list
  // never went away, so this is a no-op there.
  const selectNote = useCallback((id) => {
    setChosenId(id);
    setBrowsing(false);
  }, []);

  const updateContent = useCallback((content) => {
    if (!active) return;
    dispatch({ type: 'UPDATE_NOTE', id: active.id, patch: { content } });
  }, [active, dispatch]);

  // Filing a note under a course, after it exists.
  //
  // `createNote` takes a course id, and the tree offers a per-course "new
  // note" row — but that was the ONLY way a note ever acquired a course. The
  // main "New note" button passes the timer's scope, which is null whenever no
  // session is running, so a note written outside a session was filed nowhere
  // and could never be moved. `UPDATE_NOTE` was only ever dispatched with
  // `{ content }`.
  //
  // That is half of "notes cannot be filed into folders": the tree groups by
  // course correctly, and nothing could put a note into a group.
  const updateCourse = useCallback((courseId) => {
    if (!active) return;
    dispatch({ type: 'UPDATE_NOTE', id: active.id, patch: { courseId: courseId || null } });
    if (courseId) setExpanded((prev) => new Set(prev).add(courseId));
  }, [active, dispatch]);

  const scopedCourse = scopedCourseId ? courses.find((c) => c.id === scopedCourseId) : null;
  const activeCourse = active?.courseId ? courses.find((c) => c.id === active.courseId) : null;

  // On a phone the list takes the screen when the user asked for it, and
  // whenever there is no note to show — otherwise the phone would land on an
  // empty page with the list one tap away but nothing saying so.
  const showList = browsing || !active;

  return (
    <div className={`nb${showList ? ' is-list' : ''}`}>
      <NotebookTree
        courses={courses}
        notes={notes}
        activeNoteId={activeId}
        expanded={expanded}
        onToggleCourse={toggleCourse}
        onSelectNote={selectNote}
        onNewNote={createNote}
        scopedCourseId={scopedCourse ? scopedCourseId : null}
      />

      <div className="nb-page-wrap">
        <header className="nb-head">
          {/* The way back to the list, phone only — on desktop the list is
              already on screen and this is `display: none`. First in the
              header because that is where a back affordance is looked for. */}
          <button
            type="button"
            className="nb-head-browse"
            onClick={() => setBrowsing(true)}
            aria-label={t('nb.allNotes')}
          >
            {/* The chevron comes from CSS so it can flip for Arabic — a
                hardcoded ‹ points out of the screen under dir="rtl", which
                i18n/index.js sets on the document element. */}
            <span className="nb-head-browse-chev" aria-hidden="true" />
            <span>{t('nb.allNotes')}</span>
          </button>
          {active && (
            <label className="nb-head-course">
              <span
                className="nb-scope-pip"
                style={{ background: activeCourse?.color || 'var(--border2)' }}
                aria-hidden="true"
              />
              {/* A select rather than a drag target: the tree is a list on a
                  phone, and dragging a note between collapsed course groups is
                  not a gesture that works one-handed. */}
              <select
                className="nb-head-course-select"
                value={active.courseId || ''}
                onChange={(e) => updateCourse(e.target.value)}
                aria-label={t('nb.fileUnder')}
              >
                <option value="">{t('nb.unfiled')}</option>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
          )}
          {active?.updatedAt && (
            <span className="nb-head-meta nb-head-meta-edited">
              {t('nb.edited', { when: new Date(active.updatedAt).toLocaleString() })}
            </span>
          )}
          {/* §3: "Saved to session · 20 Mar 14:22" as a meta line. Shown only
              when the note actually carries a session id — a note written
              outside a session must not claim one. */}
          {active?.sessionId && (
            <span className="nb-head-meta">{t('nb.savedToSession')}</span>
          )}
          <span className="nb-head-spacer" />
          {/* Delete. Confirmed, because a note is the one thing in this app
              with no undo — the editor's history is per-block and does not
              survive the note being unmounted. */}
          {active && onDeleteNote && (
            <button
              type="button"
              className="nb-head-delete"
              onClick={() => {
                if (window.confirm(t('nb.confirmDelete'))) onDeleteNote(active.id);
              }}
              aria-label={t('nb.delete')}
              title={t('nb.delete')}
            >
              ×
            </button>
          )}
          {/* The corner pill. The EXISTING component at its existing size,
              mounted in a new position — not restyled, so the timer surface it
              came from is unaffected (§3 rule 2, §10 point 3). */}
          <TimerPill onOpen={onOpenTimer} />
        </header>

        {active ? (
          <NoteEditor
            key={active.id}
            value={active.content || ''}
            onChange={updateContent}
            autoFocus={false}
          />
        ) : (
          <div className="nb-empty">
            <p>{t('nb.emptyTitle')}</p>
            <button type="button" className="btn" onClick={() => createNote(scopedCourseId)}>
              {t('nb.newNote')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

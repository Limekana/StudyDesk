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

export default function NotebookView({ state, dispatch, onOpenTimer }) {
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
    if (courseId) setExpanded((prev) => new Set(prev).add(courseId));
  }, [dispatch, timer]);

  const updateContent = useCallback((content) => {
    if (!active) return;
    dispatch({ type: 'UPDATE_NOTE', id: active.id, patch: { content } });
  }, [active, dispatch]);

  const scopedCourse = scopedCourseId ? courses.find((c) => c.id === scopedCourseId) : null;
  const activeCourse = active?.courseId ? courses.find((c) => c.id === active.courseId) : null;

  return (
    <div className="nb">
      <NotebookTree
        courses={courses}
        notes={notes}
        activeNoteId={activeId}
        expanded={expanded}
        onToggleCourse={toggleCourse}
        onSelectNote={setChosenId}
        onNewNote={createNote}
        scopedCourseId={scopedCourse ? scopedCourseId : null}
      />

      <div className="nb-page-wrap">
        <header className="nb-head">
          {activeCourse && (
            <span className="nb-head-course">
              <span className="nb-scope-pip" style={{ background: activeCourse.color }} aria-hidden="true" />
              {activeCourse.name}
            </span>
          )}
          {active?.updatedAt && (
            <span className="nb-head-meta">
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

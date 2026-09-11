// The course tree. §2 (desktop sidebar) and §3 (session scoping).
//
// §2 says: "Uses the existing course pip colour and the existing sidebar row
// treatment — do not build a new tree component if the sidebar's course list
// can carry a nested level." It cannot, and the reason is structural rather
// than stylistic: the app's sidebar course list is a flat route switcher
// where selecting a course changes `state.activeCourse` and navigates. A
// notebook tree needs a course to EXPAND without navigating, and needs a
// second row type under it. Bending the sidebar to do both would put notebook
// state into the app shell for one screen's benefit.
//
// What is reused is the part that matters for consistency: the pip colour
// comes from the course record exactly as the sidebar reads it, and the row
// geometry matches (39px note indent, per §2).

import { useTranslation } from 'react-i18next';
import { excerpt } from './model.js';

export default function NotebookTree({
  courses,
  notes,
  activeNoteId,
  expanded,
  onToggleCourse,
  onSelectNote,
  onNewNote,
  scopedCourseId,
}) {
  const { t } = useTranslation();

  const notesFor = (courseId) => notes
    .filter((n) => !n.deletedAt && (n.courseId || null) === (courseId || null))
    // Most recently edited first: in a revision session the note you want is
    // almost always the one you were last in.
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  const scoped = scopedCourseId ? courses.find((c) => c.id === scopedCourseId) : null;
  // §3: while scoped, the other courses collapse into a single dim line. They
  // stay TAPPABLE — "The scope is visible and reversible. Collapsed courses
  // stay tappable. It is a default, not a lock."
  const others = scoped ? courses.filter((c) => c.id !== scopedCourseId) : [];
  const shown = scoped ? [scoped] : courses;

  return (
    <nav className="nb-tree" aria-label={t('nb.treeLabel')}>
      {scoped && (
        <div className="nb-scope">
          <div className="nb-scope-label">{t('nb.scopedToSession')}</div>
          <div className="nb-scope-course">
            <span className="nb-scope-pip" style={{ background: scoped.color }} aria-hidden="true" />
            <span>{scoped.name}</span>
          </div>
        </div>
      )}

      {shown.map((course) => {
        const courseNotes = notesFor(course.id);
        const open = expanded.has(course.id) || course.id === scopedCourseId;
        return (
          <div key={course.id}>
            <button
              type="button"
              className="nb-course-row"
              onClick={() => onToggleCourse(course.id)}
              aria-expanded={open}
            >
              <span className="nb-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
              <span className="nb-scope-pip" style={{ background: course.color }} aria-hidden="true" />
              <span className="nb-course-name">{course.name}</span>
              <span className="nb-course-count">{courseNotes.length}</span>
            </button>
            {open && courseNotes.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`nb-note-row${n.id === activeNoteId ? ' is-active' : ''}`}
                onClick={() => onSelectNote(n.id)}
              >
                {n.title || excerpt(n.content) || t('nb.untitled')}
              </button>
            ))}
            {open && (
              <button type="button" className="nb-note-row" onClick={() => onNewNote(course.id)}>
                {t('nb.newNote')}
              </button>
            )}
          </div>
        );
      })}

      {others.length > 0 && (
        <div className="nb-collapsed">
          {others.map((c, i) => (
            <span key={c.id}>
              <button type="button" onClick={() => onToggleCourse(c.id, { unscope: true })}>
                {c.name}
              </button>
              {i < others.length - 1 && <span aria-hidden="true"> · </span>}
            </span>
          ))}
        </div>
      )}

      {/* Unfiled notes. A note whose course was deleted lands here rather than
          disappearing — the FK is ON DELETE SET NULL precisely so a term of
          revision survives the course being cleaned up at the end of a jakso. */}
      {notesFor(null).length > 0 && (
        <div>
          <button
            type="button"
            className="nb-course-row"
            onClick={() => onToggleCourse(null)}
            aria-expanded={expanded.has(null)}
          >
            <span className="nb-chev" aria-hidden="true">{expanded.has(null) ? '▾' : '▸'}</span>
            <span className="nb-course-name">{t('nb.unfiled')}</span>
            <span className="nb-course-count">{notesFor(null).length}</span>
          </button>
          {expanded.has(null) && notesFor(null).map((n) => (
            <button
              key={n.id}
              type="button"
              className={`nb-note-row${n.id === activeNoteId ? ' is-active' : ''}`}
              onClick={() => onSelectNote(n.id)}
            >
              {n.title || excerpt(n.content) || t('nb.untitled')}
            </button>
          ))}
        </div>
      )}
    </nav>
  );
}

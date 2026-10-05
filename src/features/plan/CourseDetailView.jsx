import { useTranslation } from "react-i18next";
import { fmtDateFull, toLocalISO } from "../../lib/dates.js";
import { byDueAsc, byDueDesc } from "../../lib/dueAt.js";
import AsgnItem from "./AsgnItem.jsx";
import ExamCard from "./ExamCard.jsx";

// ── CourseDetailView — the middle pane of the desktop three-pane layout ──────
//
// v1.9 Item 14a. Replaces `StatusView`, which was written for the `status`
// route and then never mounted — clicking a course in the sidebar dispatched
// `view:"status"` and rendered nothing at all. Rather than restore a component
// that only listed assignments, this is the course-detail pane the build plan
// asks for: the sidebar is the list, this is the detail, and on the desktop
// tier a third column carries what is coming up and what has been put in.
export default function CourseDetailView({ state, dispatch, session, showFlash, tier, onAddAsgn, onAddExam, onEditCourse }) {
  const { t } = useTranslation();
  const ac = state.activeCourse;
  const course = ac ? state.courses[ac] : null;

  if (!course || course.deletedAt) {
    return <div className="empty">{t('cal.courseGone')}</div>;
  }

  const assignments = state.assignments.filter(a => a.courseId === ac);
  const open = assignments.filter(a => !a.done)
    .sort(byDueAsc);
  const done = assignments.filter(a => a.done)
    .sort(byDueDesc);
  const exams = state.exams.filter(e => e.courseId === ac);
  const openExams = exams.filter(e => !e.done).sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  const sessions = (state.studySessions || []).filter(s => !s.deletedAt && s.subjectId === ac);
  const totalMin = sessions.reduce((n, s) => n + (s.durationMinutes || 0), 0);

  // Weighted mean of this course's own grades. No scale conversion: every
  // grade within one course shares the same scale, so the raw weighted mean is
  // the honest number here — converting would need the GPA machinery and would
  // say something different from what the Grades screen already shows.
  const grades = (state.grades || []).filter(g => !g.deletedAt && g.subjectId === ac);
  const wSum = grades.reduce((n, g) => n + (Number(g.weight) || 0), 0);
  const mean = wSum > 0
    ? grades.reduce((n, g) => n + Number(g.grade) * (Number(g.weight) || 0), 0) / wSum
    : null;

  const stats = [
    { label: t('cal.statOpen'), value: open.length },
    { label: t('cal.statExams'), value: openExams.length },
    { label: t('cal.statStudied'), value: totalMin >= 60 ? `${Math.round(totalMin / 60)}h` : `${totalMin}m` },
    { label: t('cal.statAverage'), value: mean === null ? '—' : mean.toFixed(2) },
  ];

  const body = (
    <div>
      <div className="cdv-head" style={{ borderInlineStartColor: course.color }}>
        <div className="cdv-head-main">
          <div className="cdv-name">{course.name}</div>
          <div className="cdv-sub">
            {course.semester && <span>{course.semester}</span>}
            {course.schoolYear && <span>· {course.schoolYear}</span>}
            {course.credits != null && <span>· {t('cal.credits', { n: course.credits })}</span>}
            {course.archivedAt && <span>· {t('cal.archived')}</span>}
          </div>
        </div>
        <button className="btn-outline btn-sm" onClick={() => onEditCourse({ id: course.id, name: course.name, color: course.color })}>
          {t('av.pl.edit')}
        </button>
      </div>

      <div className="cdv-stats">
        {stats.map(s => (
          <div key={s.label} className="cdv-stat">
            <div className="cdv-stat-value">{s.value}</div>
            <div className="cdv-stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="section-label">
        {t('av.pl.assignments')}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onAddAsgn}>{t('av.pl.add')}</button>
      </div>
      {open.length === 0 && <div className="empty">{t('av.pl.noOpenAsgn')}</div>}
      {open.map(a => <AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash} />)}
      {done.length > 0 && (
        <details style={{ marginBottom: 16 }}>
          <summary style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted)", cursor: "pointer", padding: "8px 0" }}>
            {t('av.pl.completed', { count: done.length })}
          </summary>
          {done.map(a => <AsgnItem key={a.id} asgn={a} courses={state.courses} dispatch={dispatch} attachments={state.attachments} session={session} showFlash={showFlash} />)}
        </details>
      )}

      <div className="divider" />
      <div className="section-label">
        {t('av.pl.examsCalendar')}
        <button className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={onAddExam}>{t('av.pl.add')}</button>
      </div>
      {openExams.length === 0 && <div className="empty">{t('av.pl.noExams')}</div>}
      {openExams.map(e => <ExamCard key={e.id} exam={e} courses={state.courses} dispatch={dispatch} />)}
    </div>
  );

  if (tier !== 'desktop') return body;

  // Third pane. Recent sessions only — the full history has its own screen,
  // and a course pane that grows without bound stops being a summary.
  const recent = sessions
    .slice()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 8);

  return (
    <div className="cdv-split">
      {body}
      <aside className="cdv-aside">
        <div className="cdv-aside-label">{t('cal.recentSessions')}</div>
        {recent.length === 0 && <div className="cdv-aside-empty">{t('cal.noSessionsYet')}</div>}
        {recent.map(s => (
          <div key={s.id} className="cdv-session">
            <div className="cdv-session-when">{fmtDateFull(toLocalISO(new Date(s.startedAt)))}</div>
            <div className="cdv-session-len">
              {s.durationMinutes >= 60
                ? `${Math.floor(s.durationMinutes / 60)}h ${s.durationMinutes % 60 || ''}${s.durationMinutes % 60 ? 'm' : ''}`.trim()
                : `${s.durationMinutes}m`}
              {s.focusRating != null && <span className="cdv-session-focus"> · {t('cal.focus', { n: s.focusRating })}</span>}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

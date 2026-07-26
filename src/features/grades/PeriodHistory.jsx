import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subjectEffectiveGrade, subjectsWithEffectiveGrades, calculateGPA } from '../../lib/gpa.js';

// v1.5 (5C) — read-only Period/Jakso history. Groups ARCHIVED courses by
// school_year → period (the `semester` string tag), computes a per-group GPA
// snapshot, and lets the user tap a period open to see its courses + grades.
// Lives inside Settings (no new tab, per CTO decision). Zero schema beyond
// v15_school_year; restore stays in the Grades tab.

const css = `
.ph-empty{font-size:13px;color:var(--muted);line-height:1.55;}
.ph-year{margin-bottom:6px;}
.ph-year + .ph-year{margin-top:14px;}
.ph-year-label{font-family:var(--font-mono);font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted2);margin-bottom:8px;}
.ph-period{border:1px solid var(--border);border-radius:8px;background:var(--bg);margin-bottom:8px;overflow:hidden;}
.ph-period-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 13px;cursor:pointer;}
.ph-period-name{font-family:var(--font-display);font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}
.ph-period-meta{font-family:var(--font-mono);font-size:11px;color:var(--muted);text-align:end;white-space:nowrap;}
.ph-gpa{font-family:var(--font-display);font-weight:600;color:var(--text);}
.ph-caret{color:var(--muted2);font-size:11px;}
.ph-courses{border-top:1px solid var(--border);padding:4px 13px 10px;}
.ph-course{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:13px;}
.ph-course + .ph-course{border-top:1px dashed var(--border);}
.ph-course-name{display:flex;align-items:center;gap:8px;min-width:0;}
.ph-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.ph-course-grade{font-family:var(--font-mono);font-size:12px;color:var(--text);white-space:nowrap;}
.ph-course-grade.none{color:var(--muted2);}
`;

const NO_YEAR = '__noyear__';
const NO_PERIOD = '__noperiod__';

export default function PeriodHistory({ courses, grades, mode = 'ib' }) {
  const { t } = useTranslation();
  const grouped = useMemo(() => {
    const archived = Object.values(courses || {}).filter((c) => !c.deletedAt && c.archivedAt);
    // year → period → subjects[]
    const years = new Map();
    for (const c of archived) {
      const yKey = c.schoolYear || NO_YEAR;
      const pKey = c.semester || NO_PERIOD;
      if (!years.has(yKey)) years.set(yKey, new Map());
      const periods = years.get(yKey);
      if (!periods.has(pKey)) periods.set(pKey, []);
      periods.get(pKey).push(c);
    }
    // Stable, human order: years descending (newest first), periods ascending.
    const yearList = [...years.entries()].sort((a, b) => {
      if (a[0] === NO_YEAR) return 1;
      if (b[0] === NO_YEAR) return -1;
      return b[0].localeCompare(a[0]);
    });
    return yearList.map(([yKey, periods]) => {
      const periodList = [...periods.entries()].sort((a, b) => {
        if (a[0] === NO_PERIOD) return 1;
        if (b[0] === NO_PERIOD) return -1;
        return a[0].localeCompare(b[0]);
      });
      return [yKey, periodList];
    });
  }, [courses]);

  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  if (grouped.length === 0) {
    return (
      <>
        <style>{css}</style>
        <div className="ph-empty">{t('history.empty')}</div>
      </>
    );
  }

  const gpaLabel = mode === 'ib' ? t('history.gpaIb') : t('history.gpaUs');

  return (
    <>
      <style>{css}</style>
      {grouped.map(([yKey, periodList]) => (
        <div className="ph-year" key={yKey}>
          <div className="ph-year-label">{yKey === NO_YEAR ? t('history.noSchoolYear') : yKey}</div>
          {periodList.map(([pKey, subs]) => {
            const key = `${yKey}::${pKey}`;
            const isOpen = open.has(key);
            const effective = subjectsWithEffectiveGrades(subs, grades);
            const gpa = calculateGPA(effective, mode);
            const graded = effective.length;
            return (
              <div className="ph-period" key={key}>
                <div
                  className="ph-period-head"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggle(key)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(key))}
                >
                  <div className="ph-period-name">
                    <span className="ph-caret">{isOpen ? '▾' : '▸'}</span>
                    {pKey === NO_PERIOD ? t('history.noPeriod') : pKey}
                  </div>
                  <div className="ph-period-meta">
                    {t('history.course', { count: subs.length })}
                    {graded > 0 && (
                      <> · {gpaLabel} <span className="ph-gpa">{gpa}</span></>
                    )}
                  </div>
                </div>
                {isOpen && (
                  <div className="ph-courses">
                    {subs.map((c) => {
                      const own = (grades || []).filter((g) => g.subjectId === c.id && !g.deletedAt);
                      const eff = subjectEffectiveGrade(own);
                      return (
                        <div className="ph-course" key={c.id}>
                          <div className="ph-course-name">
                            <span className="ph-dot" style={{ background: c.color || 'var(--muted2)' }} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                          </div>
                          <div className={`ph-course-grade${eff == null ? ' none' : ''}`}>
                            {eff == null ? t('history.noGrades') : Math.round(eff * 100) / 100}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// v1.14 Item 8a (#51) — putting a finished term's grades in.
//
//   > "to add grades from a past semester the course has to be currently in
//      the course list, so there's no way to just add the course and its
//      credits straight into the archive"
//
// The archive was built the only way it could have been: you take courses you
// are currently doing and archive them when the term ends. That works forever
// forward and not at all backward. Someone arriving with two years of
// transcript behind them had to create every past course as ACTIVE — polluting
// the live GPA, the Plan tab and the timetable pickers with courses they
// finished in 2024 — enter the grades, and then remember to archive each one.
// If they forgot a single course, their GPA was quietly wrong.
//
// So this creates the course ALREADY ARCHIVED. Nothing else about it is
// special: it is an ordinary row with `archivedAt` set at birth, which is the
// same state `ARCHIVE_SEMESTER` produces, and it restores, edits and deletes
// through the paths that already exist.
//
// Credits are the field that makes this worth having rather than a convenience
// — a past course with no credit weight contributes wrongly to a cumulative
// GPA, and that is the number the whole feature exists to produce.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import CoursePicker from '../../lib/CoursePicker.jsx';
import { COURSE_COLORS } from '../../lib/courseColors.js';
import { enterSubmit } from '../../lib/imeSubmit.js';

export default function PastCourseModal({ courses, onCreate, onClose }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [credits, setCredits] = useState('1');
  const [semester, setSemester] = useState('');
  const [schoolYear, setSchoolYear] = useState('');
  const [color, setColor] = useState(COURSE_COLORS[0]);
  const [err, setErr] = useState('');

  // Offer the terms already in use, from every course rather than only the
  // archived ones: someone entering their transcript a term at a time should
  // get "Autumn 2024" back on the second course, spelled exactly as the first.
  const all = Object.values(courses || {}).filter((c) => !c.deletedAt);
  const semesterOptions = [...new Set(all.map((c) => c.semester).filter(Boolean))].sort();
  const yearOptions = [...new Set(all.map((c) => c.schoolYear).filter(Boolean))].sort();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) { setErr(t('gv.pcErrName')); return; }
    const cr = parseFloat(credits);
    // Zero credits is a real answer — a pass/fail seminar that counts for
    // nothing towards the GPA — so only a negative or unparseable value is
    // rejected.
    if (!Number.isFinite(cr) || cr < 0) { setErr(t('gv.pcErrCredits')); return; }
    onCreate({
      name: trimmed,
      color,
      credits: cr,
      semester: semester.trim() || null,
      schoolYear: schoolYear.trim() || null,
    });
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('gv.pcTitle')} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{t('gv.pcTitle')}</div>
        {/* Said plainly at the top rather than discovered afterwards: the whole
            reason to use this instead of "Add course" is where the course
            lands, and that is not visible from the fields. */}
        <div className="sv2-note" style={{ marginTop: 0, marginBottom: 14 }}>{t('gv.pcNote')}</div>

        <div className="input-group">
          <div className="input-label">{t('gv.pcName')}</div>
          <input
            type="text" value={name} autoFocus
            placeholder={t('gv.pcNamePh')}
            onChange={(e) => { setName(e.target.value); setErr(''); }}
            {...enterSubmit(submit)}
          />
        </div>

        <div className="modal-grid">
          <div className="input-group">
            <div className="input-label">{t('gv.pcCredits')}</div>
            <input
              type="number" step="0.5" min="0" value={credits}
              onChange={(e) => { setCredits(e.target.value); setErr(''); }}
            />
          </div>
          <div className="input-group">
            <div className="input-label">{t('gv.pcTerm')}</div>
            <input
              type="text" value={semester} list="gv-pc-terms"
              placeholder={t('gv.pcTermPh')}
              onChange={(e) => setSemester(e.target.value)}
            />
            <datalist id="gv-pc-terms">
              {semesterOptions.map((s) => <option key={s} value={s} />)}
            </datalist>
          </div>
        </div>

        <div className="input-group">
          <div className="input-label">{t('gv.pcYear')}</div>
          <input
            type="text" value={schoolYear} list="gv-pc-years"
            placeholder={t('gv.pcYearPh')}
            onChange={(e) => setSchoolYear(e.target.value)}
          />
          <datalist id="gv-pc-years">
            {yearOptions.map((y) => <option key={y} value={y} />)}
          </datalist>
        </div>

        <div className="input-group">
          <div className="input-label">{t('gv.pcColour')}</div>
          <CoursePicker value={color} onChange={setColor} />
        </div>

        {err && <div className="tt-error">{err}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={submit}>{t('gv.pcCreate')}</button>
          <button className="btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

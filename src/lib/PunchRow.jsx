// v1.14 — attendance as a punch card rather than a bare percentage.
//
// "84%" is a number a student has to take on faith. A row of marks is the
// same fact as an object they can check: one mark per lesson, oldest to
// newest, so the shape of the term is visible. "I was fine until March" does
// not exist in a percentage and is obvious here.
//
// The four states keep the meanings the percentage already gives them, and
// the row is where that rule becomes self-explanatory: cancelled and
// rescheduled lessons are DRAWN, because they happened to the timetable, but
// drawn hollow and dimmed, because they are in neither half of the fraction.
// A student who sees three ghosts next to a percentage that ignores them
// learns the rule from the interface instead of from a footnote.

import { useTranslation } from 'react-i18next';
import { punchRow } from './blocks.js';
import { ATTENDANCE } from './attendance.js';

const CLASS = {
  [ATTENDANCE.PRESENT]: 'is-present',
  [ATTENDANCE.ABSENT]: 'is-absent',
  [ATTENDANCE.CANCELLED]: 'is-cancelled',
  [ATTENDANCE.RESCHEDULED]: 'is-rescheduled',
};

export default function PunchRow({ rows, summary }) {
  const { t } = useTranslation();
  const { punches, hidden } = punchRow(rows);
  if (punches.length === 0) return null;

  return (
    <div className="pr">
      <div
        className="pr-row"
        role="img"
        // The counts, not a mark-by-mark reading. Same reasoning as the
        // weight rail: the picture is an aid, the sentence is the content.
        aria-label={t('att.punchAria', {
          present: summary?.present ?? 0,
          absent: summary?.absent ?? 0,
          total: punches.length,
        })}
      >
        {punches.map((p, i) => (
          <span
            key={`${p.date}-${i}`}
            className={`pr-punch ${CLASS[p.status] || 'is-unknown'}`}
            title={`${p.date} · ${t(`att.status.${p.status}`, { defaultValue: p.status })}`}
          />
        ))}
      </div>
      {hidden > 0 && <div className="pr-more">{t('att.punchHidden', { n: hidden })}</div>}
    </div>
  );
}

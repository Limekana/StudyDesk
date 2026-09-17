// v1.14 — a grade's weight, drawn as the slice of the course it actually is.
//
// The "Weight: 1" field was the ambiguous thing this item exists to fix, and
// Item 8b already answered it in words: a share-of-course percentage beside
// the number. This is the same fact as an object. The course's whole weight
// budget is the rail; each grade is a segment; the one being asked about is
// solid and the rest are faint. You can see at a glance that the final is
// half the course and the three quizzes together are not.
//
// The percentage stays. Per LimeLog's `PlateBar`, whose contract this borrows:
// the picture is never the only representation of the number, because a
// segment is floored to a minimum width (see MIN_SEGMENT) and a floored
// segment is no longer strictly to scale.

import { useTranslation } from 'react-i18next';
import { weightSegments } from './blocks.js';

/**
 * @param {Array<{id, weight}>} items every live grade in the course
 * @param {*} activeId  the grade this readout belongs to
 * @param {boolean} compact  the row listing; false for the editor
 */
export default function WeightBlocks({ items, activeId, compact = false }) {
  const { t } = useTranslation();
  const { segments } = weightSegments(items, activeId);
  if (segments.length === 0) return null;

  const active = segments.find((s) => s.active);
  const pct = active ? Math.round(active.share * 100) : null;

  return (
    <span className={compact ? 'wb wb-compact' : 'wb'}>
      <span
        className="wb-rail"
        // One label for the whole rail. Twelve anonymous divs each announcing
        // themselves is worse than silence for anyone using a screen reader,
        // and the sentence they actually want is the one below.
        role="img"
        aria-label={pct === null
          ? t('gv.weightBlocksNoneAria', { n: segments.length })
          : t('gv.weightBlocksAria', { pct, n: segments.length })}
      >
        {segments.map((s, i) => (
          <span
            key={s.id ?? i}
            className={s.active ? 'wb-seg is-active' : 'wb-seg'}
            style={{ width: `${(s.width * 100).toFixed(3)}%` }}
          />
        ))}
      </span>
      {pct !== null && <span className="wb-pct">{t('gv.shareOfCourse', { pct })}</span>}
    </span>
  );
}

// v1.9 Item 14a — the analytics dashboard.
//
// Three readings over data the app already has: grades over time per subject,
// a study-time heatmap, and whether study time and grades move together. All
// the maths lives in `lib/analytics.js` behind 65 assertions; this file draws.
//
// Hand-built SVG rather than a charting dependency, same reasoning as the
// calendar: two line charts and a grid of squares do not justify a library,
// its date handling and its theme system, in an app whose whole visual
// identity is one it would have to be fought into.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gradeSeries, studyHeatmap, studyVsGrades, describeCorrelation } from '../../lib/analytics.js';
import { parseLocalDate, formatLocale } from '../../lib/dates.js';
import { resolveWeekStart } from '../../lib/calendar.js';
import '../../styles/analytics.css';

const H = 200;      // plot height
const PAD_L = 34;   // room for the y-axis labels
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 22;

/** Measured width, not a stretched viewBox. `preserveAspectRatio="none"` is
 *  fine on a 320px sparkline and wrong at 1200px, where it turns every point
 *  marker into an ellipse and every label into a smear. */
function useMeasuredWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width;
      if (width) setW(Math.round(width));
    });
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function fmtMinutes(m) {
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}

// ── Grade trend ────────────────────────────────────────────────────────────

function GradeTrend({ series, locale, t }) {
  const [ref, w] = useMeasuredWidth();
  const [hidden, setHidden] = useState(() => new Set());

  // Derived INSIDE the memo, from `series` and `hidden`. Memoising on a
  // `visible.flatMap(...)` result instead would have been decorative: that
  // array is newly built on every render, so its identity always changes and
  // the memo never holds.
  const { visible, all, bounds } = useMemo(() => {
    const vis = series.filter((s) => !hidden.has(s.courseId));
    const pts = vis.flatMap((s) => s.points);
    if (!pts.length) return { visible: vis, all: pts, bounds: null };
    const times = pts.map((p) => parseLocalDate(p.date).getTime());
    const vals = pts.map((p) => p.mean);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    // A flat line needs a band to sit in, or the scale collapses to zero
    // height and every point lands on the top edge of the plot.
    if (hi - lo < 0.5) { const mid = (hi + lo) / 2; lo = mid - 0.5; hi = mid + 0.5; }
    const pad = (hi - lo) * 0.12;
    return {
      visible: vis,
      all: pts,
      bounds: { t0: Math.min(...times), t1: Math.max(...times), lo: lo - pad, hi: hi + pad },
    };
  }, [series, hidden]);

  const toggle = (id) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const plotW = Math.max(0, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const x = (date) => {
    if (!bounds || bounds.t1 === bounds.t0) return PAD_L + plotW / 2;
    return PAD_L + ((parseLocalDate(date).getTime() - bounds.t0) / (bounds.t1 - bounds.t0)) * plotW;
  };
  const y = (v) => PAD_T + (1 - (v - bounds.lo) / (bounds.hi - bounds.lo)) * plotH;

  const ticks = bounds ? [bounds.lo, (bounds.lo + bounds.hi) / 2, bounds.hi] : [];

  return (
    <section className="an-card">
      <div className="an-head">
        <h3 className="an-title">{t('an.gradeTrend')}</h3>
        <div className="an-sub">{t('an.gradeTrendSub')}</div>
      </div>

      <div className="an-legend">
        {series.map((s) => (
          <button
            key={s.courseId}
            type="button"
            className={`an-key${hidden.has(s.courseId) ? ' off' : ''}`}
            onClick={() => toggle(s.courseId)}
            aria-pressed={!hidden.has(s.courseId)}
          >
            <span className="an-key-pip" style={{ background: s.color || 'var(--muted2)' }} />
            {s.name}
            <span className="an-key-n">{t('an.nGrades', { n: s.n })}</span>
          </button>
        ))}
      </div>

      <div className="an-plot" ref={ref}>
        {w > 0 && bounds && (
          <svg width={w} height={H} role="img" aria-label={t('an.gradeTrend')}>
            {ticks.map((v, i) => (
              <g key={i}>
                <line x1={PAD_L} x2={w - PAD_R} y1={y(v)} y2={y(v)} className="an-grid" />
                <text x={PAD_L - 6} y={y(v) + 3} className="an-axis" textAnchor="end">{v.toFixed(1)}</text>
              </g>
            ))}
            {visible.map((s) => {
              const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)},${y(p.mean).toFixed(1)}`).join(' ');
              const stroke = s.color || 'var(--muted)';
              return (
                <g key={s.courseId}>
                  {/* A single grade is a dot, not a line — a one-point path
                      draws nothing at all, which reads as missing data. */}
                  {s.points.length > 1 && <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />}
                  {s.points.map((p, i) => (
                    <circle key={i} cx={x(p.date)} cy={y(p.mean)} r="2.6" fill={stroke}>
                      <title>{`${s.name} · ${parseLocalDate(p.date).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })} · ${t('an.gradeWas', { grade: p.grade })} · ${t('an.meanNow', { mean: p.mean.toFixed(2) })}`}</title>
                    </circle>
                  ))}
                </g>
              );
            })}
            {bounds && (
              <>
                <text x={PAD_L} y={H - 6} className="an-axis">{parseLocalDate(all.reduce((a, b) => (a.date < b.date ? a : b)).date).toLocaleDateString(locale, { month: 'short', year: '2-digit' })}</text>
                <text x={w - PAD_R} y={H - 6} className="an-axis" textAnchor="end">{parseLocalDate(all.reduce((a, b) => (a.date > b.date ? a : b)).date).toLocaleDateString(locale, { month: 'short', year: '2-digit' })}</text>
              </>
            )}
          </svg>
        )}
        {(!bounds || !visible.length) && <div className="an-empty">{t('an.noGrades')}</div>}
      </div>
    </section>
  );
}

// ── Heatmap ────────────────────────────────────────────────────────────────

function Heatmap({ data, locale, t }) {
  // Column-major weeks so the grid reads like a contribution graph: each
  // column is a week, each row a weekday.
  const weeks = useMemo(() => {
    const cols = [];
    let col = [];
    for (const cell of data.cells) {
      col.push(cell);
      if (col.length === 7) { cols.push(col); col = []; }
    }
    // Only the LAST column is ever short, and it is short because the current
    // week has not finished yet — days that have not happened. The first
    // column needs no padding at all now that the window snaps to a week
    // boundary, which is what removed the stray lone square.
    if (col.length) { while (col.length < 7) col.push(null); cols.push(col); }
    return cols;
  }, [data.cells]);

  return (
    <section className="an-card">
      <div className="an-head">
        <h3 className="an-title">{t('an.heatmap')}</h3>
        <div className="an-sub">{t('an.heatmapSub', { total: fmtMinutes(data.total) })}</div>
      </div>
      <div className="an-heat-wrap">
        <div className="an-heat" style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}>
          {weeks.map((col, ci) => (
            <div className="an-heat-col" key={ci}>
              {col.map((cell, ri) => (cell ? (
                <div
                  key={cell.iso}
                  className={`an-heat-cell lv${cell.level}`}
                  title={`${parseLocalDate(cell.iso).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })} — ${cell.minutes ? fmtMinutes(cell.minutes) : t('an.noStudy')}`}
                />
              ) : <div key={`p${ri}`} className="an-heat-cell empty" />))}
            </div>
          ))}
        </div>
      </div>
      <div className="an-scale">
        <span>{t('an.less')}</span>
        {[0, 1, 2, 3, 4].map((l) => <span key={l} className={`an-heat-cell lv${l}`} />)}
        <span>{t('an.more')}</span>
        {data.max > 0 && <span className="an-scale-max">{t('an.busiest', { total: fmtMinutes(data.max) })}</span>}
      </div>
    </section>
  );
}

// ── Correlation ────────────────────────────────────────────────────────────

function Correlation({ data, t }) {
  return (
    <section className="an-card">
      <div className="an-head">
        <h3 className="an-title">{t('an.correlation')}</h3>
        <div className="an-sub">{t('an.correlationSub', { days: data.windowDays })}</div>
      </div>
      {data.perSubject.length === 0 && <div className="an-empty">{t('an.noPairs')}</div>}
      {data.perSubject.map((s) => {
        const verdict = describeCorrelation(s.r, s.n);
        return (
          <div className="an-corr" key={s.subjectId}>
            <span className="an-key-pip" style={{ background: s.color || 'var(--muted2)' }} />
            <span className="an-corr-name">{s.name}</span>
            <span className={`an-corr-verdict v-${verdict}`}>{t(`an.verdict.${verdict}`)}</span>
            <span className="an-corr-n">
              {verdict === 'insufficient'
                ? t('an.nPoints', { n: s.n })
                : t('an.rValue', { r: s.r.toFixed(2), n: s.n })}
            </span>
          </div>
        );
      })}
      {/* Stated on the surface, not buried in a tooltip: this is a small
          sample and a correlation is not a cause. Leaving it off would let a
          student conclude that studying does not help because one course of
          six grades says so. */}
      <p className="an-caveat">{t('an.caveat')}</p>
    </section>
  );
}

// ── View ───────────────────────────────────────────────────────────────────

export default function AnalyticsView({ state }) {
  const { t } = useTranslation();
  const locale = formatLocale();
  // Same week-start resolution the calendar uses, so the heatmap's rows and
  // the calendar's columns cannot disagree about which day a week begins on.
  const weekStart = useMemo(() => resolveWeekStart(locale), [locale]);
  const series = useMemo(() => gradeSeries(state), [state]);
  const heat = useMemo(() => studyHeatmap(state, 182, undefined, weekStart), [state, weekStart]);
  const corr = useMemo(() => studyVsGrades(state), [state]);

  return (
    <div className="an">
      <GradeTrend series={series} locale={locale} t={t} />
      <Heatmap data={heat} locale={locale} t={t} />
      <Correlation data={corr} t={t} />
    </div>
  );
}

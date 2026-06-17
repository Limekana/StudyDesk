import { useMemo } from 'react';
import { calculateGPA, subjectsWithEffectiveGrades } from '../../lib/gpa.js';

// ── BUG-21: Study Statistics Dashboard ───────────────────────────────────────
//
// StudyDesk is now the only home for study data (NCC's studies overview was
// removed in v1.3). This view surfaces what the user can no longer see in the
// hub: weekly study load, where the time goes (subject split), consistency
// (streak), and where the GPA is trending. All data is already local +
// synced — this is a pure read/derive surface. Cream-paper aesthetic, in line
// with the rest of the app.

const css = `
.st-wrap{padding:16px 24px 80px;max-width:820px;margin:0 auto;}
.st-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:14px;}
.st-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px;}
.st-card-title{font-family:var(--font-mono);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--muted2);}
.st-card-note{font-family:var(--font-mono);font-size:10px;color:var(--muted);letter-spacing:0.04em;}
.st-hero{display:flex;align-items:flex-end;gap:8px;margin-bottom:2px;}
.st-hero-val{font-family:var(--font-display);font-size:42px;font-weight:600;line-height:0.95;letter-spacing:-0.02em;}
.st-hero-unit{font-family:var(--font-mono);font-size:12px;color:var(--muted);margin-bottom:5px;}
.st-delta{font-family:var(--font-mono);font-size:11px;letter-spacing:0.03em;}
.st-delta.up{color:#2e7d52;}
.st-delta.down{color:#b06a2c;}
.st-delta.flat{color:var(--muted);}

/* Weekly bars */
.st-weeks{display:flex;align-items:flex-end;gap:10px;height:96px;margin-top:6px;}
.st-week{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;height:100%;justify-content:flex-end;}
.st-week-bar{width:100%;max-width:38px;background:var(--text);border-radius:4px 4px 0 0;min-height:3px;transition:height 200ms var(--ease-settle,ease);}
.st-week-bar.current{background:var(--accent,#7a7570);}
.st-week-label{font-family:var(--font-mono);font-size:9px;color:var(--muted2);letter-spacing:0.04em;}
.st-week-val{font-family:var(--font-mono);font-size:9px;color:var(--muted);}

/* Subject split */
.st-split-row{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
.st-split-pip{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.st-split-name{flex:1;min-width:0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.st-split-bar-track{flex:2;height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;}
.st-split-bar-fill{height:100%;border-radius:4px;}
.st-split-val{font-family:var(--font-mono);font-size:10px;color:var(--muted);white-space:nowrap;width:52px;text-align:right;}

/* Streak */
.st-streak-dots{display:flex;gap:5px;margin-top:10px;flex-wrap:wrap;}
.st-streak-dot{width:13px;height:13px;border-radius:3px;background:var(--surface2);border:1px solid var(--border);}
.st-streak-dot.on{background:var(--text);border-color:var(--text);}

/* GPA trend */
.st-gpa-line{margin-top:8px;}
.st-empty{padding:14px 2px;font-size:13px;color:var(--muted);}
`;

// Monday-anchored start of the ISO week containing `d`.
function weekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - day);
  return x;
}
function dayKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export default function StatsView({ state }) {
  const mode = state.gradeMode || 'ib';

  const sessions = useMemo(
    () => (state.studySessions || []).filter((s) => !s.deletedAt && s.startedAt),
    [state.studySessions],
  );

  // ── Weekly study load: current week + the prior 4 ─────────────────────────
  const weekly = useMemo(() => {
    const thisWeek = weekStart(new Date());
    const weeks = [];
    for (let i = 4; i >= 0; i--) {
      const start = new Date(thisWeek);
      start.setDate(start.getDate() - i * 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      weeks.push({ start, end, minutes: 0 });
    }
    for (const s of sessions) {
      const t = new Date(s.startedAt);
      for (const w of weeks) {
        if (t >= w.start && t < w.end) { w.minutes += Number(s.durationMinutes) || 0; break; }
      }
    }
    const current = weeks[weeks.length - 1].minutes;
    const priors = weeks.slice(0, 4);
    const priorAvg = priors.reduce((a, w) => a + w.minutes, 0) / 4;
    const max = Math.max(1, ...weeks.map((w) => w.minutes));
    return { weeks, current, priorAvg, max };
  }, [sessions]);

  // ── Subject split (last 30 days) ──────────────────────────────────────────
  const split = useMemo(() => {
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 29); cutoff.setHours(0, 0, 0, 0);
    const bySubject = new Map();
    let total = 0;
    for (const s of sessions) {
      if (new Date(s.startedAt) < cutoff) continue;
      const key = s.subjectId || '__general__';
      const mins = Number(s.durationMinutes) || 0;
      bySubject.set(key, (bySubject.get(key) || 0) + mins);
      total += mins;
    }
    const rows = Array.from(bySubject.entries())
      .map(([key, minutes]) => {
        const course = key === '__general__' ? null : state.courses?.[key];
        return {
          key,
          name: course?.name || 'General study',
          color: course?.color || '#a8a29a',
          minutes,
        };
      })
      .sort((a, b) => b.minutes - a.minutes);
    return { rows, total };
  }, [sessions, state.courses]);

  // ── Study streak: consecutive days (ending today/yesterday) with ≥1 session ─
  const streak = useMemo(() => {
    const days = new Set(sessions.map((s) => dayKey(s.startedAt)));
    let count = 0;
    const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
    // Allow the streak to "still be alive" if nothing logged today yet but
    // yesterday has a session.
    if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    const last14 = [];
    const probe = new Date(); probe.setHours(0, 0, 0, 0);
    for (let i = 0; i < 14; i++) {
      last14.unshift(days.has(dayKey(probe)));
      probe.setDate(probe.getDate() - 1);
    }
    while (days.has(dayKey(cursor))) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return { count, last14 };
  }, [sessions]);

  // ── GPA trend: cumulative GPA per month over the trailing window ───────────
  const gpaTrend = useMemo(() => {
    const activeCourses = Object.values(state.courses || {}).filter((c) => !c.deletedAt && !c.archivedAt);
    const coursesMap = {};
    for (const c of activeCourses) coursesMap[c.id] = c;
    const grades = (state.grades || []).filter((g) => !g.deletedAt && g.date);
    if (grades.length === 0) return { points: [], min: 0, max: 0 };

    // Bucket grades by month, build cumulative GPA at each month boundary.
    const months = Array.from(new Set(grades.map((g) => g.date.slice(0, 7)))).sort();
    const points = months.map((m) => {
      const upTo = grades.filter((g) => g.date.slice(0, 7) <= m);
      const aggregates = subjectsWithEffectiveGrades(coursesMap, upTo);
      return { month: m, gpa: calculateGPA(aggregates, mode) };
    }).filter((p) => Number.isFinite(p.gpa) && p.gpa > 0);

    const vals = points.map((p) => p.gpa);
    return { points, min: Math.min(...vals), max: Math.max(...vals) };
  }, [state.courses, state.grades, mode]);

  const fmtH = (mins) => (mins / 60).toFixed(1);
  const deltaPct = weekly.priorAvg > 0
    ? Math.round(((weekly.current - weekly.priorAvg) / weekly.priorAvg) * 100)
    : null;

  const hasAnySessions = sessions.length > 0;

  return (
    <>
      <style>{css}</style>
      <div className="st-wrap">

        {/* Weekly load */}
        <div className="st-card">
          <div className="st-card-head">
            <span className="st-card-title">This week</span>
            <span className="st-card-note">vs 4-week avg {fmtH(weekly.priorAvg)}h</span>
          </div>
          <div className="st-hero">
            <span className="st-hero-val">{fmtH(weekly.current)}</span>
            <span className="st-hero-unit">hours</span>
          </div>
          {deltaPct != null && (
            <div className={'st-delta ' + (deltaPct > 2 ? 'up' : deltaPct < -2 ? 'down' : 'flat')}>
              {deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '→'} {Math.abs(deltaPct)}% vs your recent average
            </div>
          )}
          <div className="st-weeks">
            {weekly.weeks.map((w, i) => {
              const isCurrent = i === weekly.weeks.length - 1;
              const h = Math.round((w.minutes / weekly.max) * 100);
              return (
                <div className="st-week" key={i}>
                  <div className="st-week-val">{w.minutes > 0 ? `${fmtH(w.minutes)}h` : ''}</div>
                  <div className={'st-week-bar' + (isCurrent ? ' current' : '')} style={{ height: `${Math.max(3, h)}%` }} />
                  <div className="st-week-label">{isCurrent ? 'NOW' : `−${weekly.weeks.length - 1 - i}w`}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Subject split */}
        <div className="st-card">
          <div className="st-card-head">
            <span className="st-card-title">Where your time went</span>
            <span className="st-card-note">last 30 days · {fmtH(split.total)}h</span>
          </div>
          {split.rows.length === 0 ? (
            <div className="st-empty">No sessions in the last 30 days.</div>
          ) : (
            split.rows.map((r) => {
              const pct = split.total > 0 ? Math.round((r.minutes / split.total) * 100) : 0;
              return (
                <div className="st-split-row" key={r.key}>
                  <span className="st-split-pip" style={{ background: r.color }} />
                  <span className="st-split-name">{r.name}</span>
                  <span className="st-split-bar-track">
                    <span className="st-split-bar-fill" style={{ width: `${pct}%`, background: r.color }} />
                  </span>
                  <span className="st-split-val">{fmtH(r.minutes)}h · {pct}%</span>
                </div>
              );
            })
          )}
        </div>

        {/* Streak */}
        <div className="st-card">
          <div className="st-card-head">
            <span className="st-card-title">Study streak</span>
            <span className="st-card-note">last 14 days</span>
          </div>
          <div className="st-hero">
            <span className="st-hero-val">{streak.count}</span>
            <span className="st-hero-unit">{streak.count === 1 ? 'day' : 'days'} in a row</span>
          </div>
          <div className="st-streak-dots" aria-hidden="true">
            {streak.last14.map((on, i) => (
              <span key={i} className={'st-streak-dot' + (on ? ' on' : '')} />
            ))}
          </div>
        </div>

        {/* GPA trend */}
        <div className="st-card">
          <div className="st-card-head">
            <span className="st-card-title">{mode === 'ib' ? 'IB average trend' : 'GPA trend'}</span>
            <span className="st-card-note">{mode === 'ib' ? '1–7 scale' : '4.0 scale'}</span>
          </div>
          {gpaTrend.points.length < 2 ? (
            <div className="st-empty">
              Log grades across more than one month to see your trend.
            </div>
          ) : (
            <GpaSparkline points={gpaTrend.points} min={gpaTrend.min} max={gpaTrend.max} />
          )}
        </div>

        {!hasAnySessions && gpaTrend.points.length === 0 && (
          <div className="st-empty" style={{ textAlign: 'center', paddingTop: 28 }}>
            Log a focus session or a grade and your stats will fill in here.
          </div>
        )}
      </div>
    </>
  );
}

function GpaSparkline({ points, min, max }) {
  const W = 320, H = 90, padX = 8, padY = 12;
  // Pad the value range so a flat line doesn't sit on the floor/ceiling.
  const lo = Math.floor(min * 10) / 10 - 0.1;
  const hi = Math.ceil(max * 10) / 10 + 0.1;
  const span = Math.max(0.1, hi - lo);
  const n = points.length;
  const x = (i) => padX + (i / (n - 1)) * (W - padX * 2);
  const y = (v) => padY + (1 - (v - lo) / span) * (H - padY * 2);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.gpa).toFixed(1)}`).join(' ');
  const last = points[n - 1];

  return (
    <div className="st-gpa-line">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ display: 'block' }}>
        <path d={path} fill="none" stroke="var(--text)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.gpa)} r={i === n - 1 ? 3.5 : 2} fill="var(--text)" />
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted2)' }}>
          {points[0].month}
        </span>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 16 }}>
          {last.gpa.toFixed(2)}
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted2)' }}>
          {last.month}
        </span>
      </div>
    </div>
  );
}

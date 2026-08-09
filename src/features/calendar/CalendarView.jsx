// v1.9 Item 14a — the calendar. Month sheet, week sheet, day agenda.
//
// The flagship of StudyDesk's desktop edition, and the one surface the app has
// never really had: the Plan screen's mini-grid draws 64px cells with a title
// crammed into 9px type, which is a month *indicator*, not a month you can
// plan against.
//
// Hand-built rather than pulled from a calendar library, for the reason the
// build plan gives: the shape is a fixed 7-column grid and a stack of hour
// rows, all the geometry lives in `lib/calendar.js` behind 130 assertions, and
// a dependency would arrive with its own date library, its own theme system
// and its own opinions about a design language this app has already settled.
//
// What is deliberately NOT here: creating a *planned* study block. StudyDesk
// has no planned-session model — every study session is logged after the fact
// (`startedAt` + `durationMinutes`, written by the timer). Dragging a block
// therefore corrects when a session actually happened, which is a real need
// the log view already supports through a form. Inventing a planned-block
// model would mean a new Supabase table under `P1`/`P2`, which is an owner
// call and not something to smuggle in under a UI item.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Download, Printer } from 'lucide-react';
import {
  resolveWeekStart, weekdayLabels, monthGrid, weekGrid, startOfWeek,
  buildEvents, sortDayItems, layoutBands, layoutDayColumn, sessionsOn, allDayOn,
} from '../../lib/calendar.js';
import { parseLocalDate, toLocalISO, addDays, fmtTime, formatLocale } from '../../lib/dates.js';
import { downloadIcs } from '../../lib/ics.js';
import * as outbox from '../../lib/outbox.js';
import '../../styles/calendar.css';

const MAX_CHIPS = 3;
// Drag snapping. 15 minutes matches the granularity a study block is actually
// remembered at; finer just makes the block jitter under the cursor.
const SNAP_MIN = 15;

function todayIso() { return toLocalISO(new Date()); }

/** Hour range the week grid draws. Always covers a normal day, and widens to
 *  contain anything logged outside it — a 06:00 session must not be clipped
 *  off the top of the sheet just because the default window starts at 07. */
function hourRange(sessions) {
  let from = 7, to = 22;
  for (const s of sessions) {
    const startH = Math.floor(s.startMin / 60);
    const endH = Math.ceil((s.startMin + (s.durationMinutes || 0)) / 60);
    if (startH < from) from = startH;
    if (endH > to) to = endH;
  }
  return { from: Math.max(0, from), to: Math.min(24, Math.max(to, from + 4)) };
}

function relativeDayLabel(iso, t) {
  const diff = Math.round((parseLocalDate(iso) - parseLocalDate(todayIso())) / 86400000);
  if (diff === 0) return t('cal.today');
  if (diff === 1) return t('cal.tomorrow');
  if (diff === -1) return t('cal.yesterday');
  if (diff > 0) return t('cal.inDays', { n: diff });
  return t('cal.daysAgo', { n: Math.abs(diff) });
}

function minutesLabel(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

// ── Chips ──────────────────────────────────────────────────────────────────

function Chip({ item, onOpen, t }) {
  const label = item.kind === 'session'
    ? `${fmtTime(item.startedAt)} · ${item.courseName || t('cal.study')}`
    : item.title;
  return (
    <button
      type="button"
      className={`cal-chip is-${item.kind}${item.done ? ' done' : ''}`}
      style={item.color ? { '--chip-color': item.color } : undefined}
      title={item.courseName ? `${label} — ${item.courseName}` : label}
      onClick={(e) => { e.stopPropagation(); onOpen(item); }}
    >
      {item.kind === 'assignment' && <span className="cal-pip" aria-hidden="true" />}
      <span className="cal-chip-label">{label}</span>
    </button>
  );
}

// ── Month ──────────────────────────────────────────────────────────────────

function MonthSheet({ rows, bands, byDay, weekStart, locale, selected, onSelect, onOpen, t }) {
  const dow = useMemo(() => weekdayLabels(weekStart, locale), [weekStart, locale]);
  const today = todayIso();
  // Weekend columns depend on where the week starts, so they are derived, not
  // hardcoded to the last two columns.
  const isWeekendCol = (i) => { const d = (weekStart + i) % 7; return d === 0 || d === 6; };

  return (
    <div className="cal-sheet">
      <div className="cal-dow">{dow.map((d, i) => <div key={i}>{d}</div>)}</div>
      {rows.map((row, ri) => {
        const laid = layoutBands(bands, row);
        return (
          <div className="cal-week" key={ri} style={{ '--cal-lanes': laid.lanes }}>
            {row.map((cell, ci) => {
              const items = sortDayItems(byDay.get(cell.iso) || []);
              const shown = items.slice(0, MAX_CHIPS);
              const hidden = items.length - shown.length;
              return (
                <div
                  key={cell.iso}
                  role="gridcell"
                  tabIndex={0}
                  aria-label={parseLocalDate(cell.iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
                  className={'cal-cell'
                    + (cell.inMonth ? '' : ' outside')
                    + (cell.iso === today ? ' today' : '')
                    + (cell.iso === selected ? ' selected' : '')
                    + (isWeekendCol(ci) ? ' weekend' : '')}
                  onClick={() => onSelect(cell.iso)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(cell.iso); } }}
                >
                  <div className="cal-daynum"><span>{cell.day}</span></div>
                  <div className="cal-bandspace" aria-hidden="true" />
                  <div className="cal-items">
                    {shown.map((it) => <Chip key={`${it.kind}-${it.id}`} item={it} onOpen={onOpen} t={t} />)}
                    {hidden > 0 && (
                      <button type="button" className="cal-more" onClick={(e) => { e.stopPropagation(); onSelect(cell.iso); }}>
                        {t('cal.more', { n: hidden })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="cal-bands">
              {laid.segments.map((seg) => {
                const c = seg.band.color;
                return (
                  <div
                    key={seg.band.id}
                    className={'cal-band'
                      + (seg.continuesLeft ? ' cont-start' : '')
                      + (seg.continuesRight ? ' cont-end' : '')}
                    style={{
                      gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
                      gridRow: seg.lane + 1,
                      // Colour lives in the hatch and the edge; the label stays
                      // ink, because a 9px pastel on cream is not readable and
                      // the course is already identified by the hatch.
                      '--band-tint': c ? `${c}55` : 'rgba(26,24,20,0.18)',
                      '--band-wash': c ? `${c}12` : 'rgba(26,24,20,0.04)',
                      '--band-edge': c ? `${c}44` : 'var(--border2)',
                      '--band-ink': 'var(--text)',
                    }}
                    title={t('cal.revisionFor', { title: seg.band.title })}
                    onClick={() => onSelect(row[seg.startCol].iso)}
                  >
                    {t('cal.revise')} · {seg.band.title}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Week ───────────────────────────────────────────────────────────────────

function WeekSheet({ days, byDay, weekStart, locale, onOpen, onMoveSession, t }) {
  const gridRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [nowMin, setNowMin] = useState(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });

  useEffect(() => {
    const id = setInterval(() => { const d = new Date(); setNowMin(d.getHours() * 60 + d.getMinutes()); }, 60000);
    return () => clearInterval(id);
  }, []);

  const allSessions = useMemo(
    () => days.flatMap((d) => sessionsOn(byDay, d.iso)),
    [days, byDay],
  );
  const { from, to } = useMemo(() => hourRange(allSessions), [allSessions]);
  const hours = useMemo(
    () => Array.from({ length: to - from }, (_, i) => from + i),
    [from, to],
  );
  const isWeekendCol = (i) => { const d = (weekStart + i) % 7; return d === 0 || d === 6; };
  const today = todayIso();

  // Geometry is measured from the DOM rather than recomputed from CSS values,
  // because the hour height is a tier token (44 / 52px) and the column width
  // depends on the shell width. Reading it back is the only way the drag maths
  // and the rendered grid cannot disagree.
  const measure = useCallback(() => {
    const el = gridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const gutter = el.querySelector('.cal-gutter');
    const gw = gutter ? gutter.getBoundingClientRect().width : 0;
    const colW = (rect.width - gw) / 7;
    const hourH = (rect.height) / Math.max(1, hours.length);
    // In RTL the columns run right-to-left, so a rightward drag means an
    // EARLIER day. Without this, an Arabic user dragging a block towards
    // Thursday would move it to Tuesday.
    const rtl = getComputedStyle(el).direction === 'rtl';
    return { rect, gw, colW, hourH, rtl };
  }, [hours.length]);

  const onPointerDown = (e, item) => {
    if (e.button !== undefined && e.button !== 0) return;
    const g = measure();
    if (!g) return;
    // Capture keeps the drag alive when the pointer leaves the block, which it
    // does immediately on any real drag. Guarded: it throws NotFoundError for a
    // pointer id that is not currently active, and losing capture only costs a
    // drag that ends early — it must not take the handler down with it.
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* drag still tracks via the grid listener */ }
    setDrag({
      id: item.id,
      item,
      originX: e.clientX,
      originY: e.clientY,
      startMin: item.startMin,
      iso: item.iso,
      targetMin: item.startMin,
      targetIso: item.iso,
      shiftPx: 0,
      moved: false,
    });
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    const g = measure();
    if (!g) return;
    const dy = e.clientY - drag.originY;
    const dx = e.clientX - drag.originX;
    const moved = drag.moved || Math.abs(dy) > 3 || Math.abs(dx) > 3;

    const deltaMin = Math.round((dy / g.hourH) * 60 / SNAP_MIN) * SNAP_MIN;
    const dur = Math.max(SNAP_MIN, drag.item.durationMinutes || SNAP_MIN);
    // Clamped so a block cannot be dragged past midnight in either direction
    // and silently land on the wrong calendar day.
    const targetMin = Math.max(0, Math.min(24 * 60 - dur, drag.startMin + deltaMin));

    const rawShift = Math.round(dx / g.colW) * (g.rtl ? -1 : 1);
    const baseIdx = days.findIndex((d) => d.iso === drag.iso);
    const idx = Math.max(0, Math.min(6, baseIdx + rawShift));
    // Derived from the CLAMPED index, so the block cannot slide visually past
    // the edge of the week while its landing day stays pinned to the last
    // column. `transform` is physical, so RTL needs the sign flipped back.
    const shiftPx = (idx - baseIdx) * g.colW * (g.rtl ? -1 : 1);
    setDrag((d) => (d ? { ...d, targetMin, targetIso: days[idx].iso, shiftPx, moved } : d));
  };

  const endDrag = () => {
    if (!drag) return;
    const changed = drag.moved && (drag.targetMin !== drag.startMin || drag.targetIso !== drag.iso);
    if (changed) onMoveSession(drag.item, drag.targetIso, drag.targetMin);
    else if (!drag.moved) onOpen(drag.item);
    setDrag(null);
  };

  const top = (min) => ((min - from * 60) / 60) * 100 / Math.max(1, hours.length);
  const height = (mins) => (mins / 60) * 100 / Math.max(1, hours.length);

  return (
    <div className="cal-sheet cal-weekwrap">
      <div className="cal-weekhead">
        <div />
        {days.map((d, i) => (
          <div key={d.iso} className={`cal-weekhead-day${d.iso === today ? ' today' : ''}${isWeekendCol(i) ? ' weekend' : ''}`}>
            <div className="cal-weekhead-dow">{weekdayLabels(weekStart, locale)[i]}</div>
            <div className="cal-weekhead-num">{d.day}</div>
          </div>
        ))}
      </div>

      <div className="cal-allday">
        <div className="cal-allday-gutter">{t('cal.allDay')}</div>
        {days.map((d) => (
          <div key={d.iso} className="cal-allday-col">
            {allDayOn(byDay, d.iso).map((it) => (
              <Chip key={`${it.kind}-${it.id}`} item={it} onOpen={onOpen} t={t} />
            ))}
          </div>
        ))}
      </div>

      <div
        className="cal-hours"
        ref={gridRef}
        style={{ '--cal-hour-count': hours.length }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
      >
        <div className="cal-gutter">
          {hours.map((h) => (
            <div key={h} className="cal-gutter-hour">{String(h).padStart(2, '0')}</div>
          ))}
        </div>
        {days.map((d, ci) => {
          const laid = layoutDayColumn(sessionsOn(byDay, d.iso));
          return (
            <div key={d.iso} className={`cal-daycol${isWeekendCol(ci) ? ' weekend' : ''}`}>
              {hours.map((h) => <div key={h} className="cal-hourline" />)}
              {d.iso === today && nowMin >= from * 60 && nowMin <= to * 60 && (
                <div className="cal-now" style={{ top: `${top(nowMin)}%` }} aria-hidden="true" />
              )}
              {laid.map(({ item, col, of }) => {
                const isDragging = drag?.id === item.id;
                const min = isDragging ? drag.targetMin : item.startMin;
                const dur = Math.max(SNAP_MIN, item.durationMinutes || SNAP_MIN);
                const c = item.color;
                // A block being dragged to another day STAYS MOUNTED in its
                // origin column and is translated across, rather than being
                // unmounted here and re-mounted there. Unmounting mid-gesture
                // destroys the element the pointer is captured on, and with it
                // the pointerup that commits the drop — the drag would appear
                // to work and then silently discard itself.
                //
                // It also takes the full column width while dragging: a block
                // sharing a column with an overlap at its origin would
                // otherwise arrive on an empty day still half-width.
                const shiftX = isDragging ? drag.shiftPx : 0;
                const lead = isDragging ? 0 : (col / of) * 100;
                const span = isDragging ? 100 : (1 / of) * 100;
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={`cal-block${isDragging ? ' dragging' : ''}${height(dur) < 5 ? ' compact' : ''}`}
                    style={{
                      top: `${top(min)}%`,
                      height: `${height(dur)}%`,
                      insetInlineStart: `calc(${lead}% + 3px)`,
                      width: `calc(${span}% - 6px)`,
                      transform: shiftX ? `translateX(${shiftX}px)` : undefined,
                      '--block-color': c || 'var(--border2)',
                      '--block-wash': c ? `${c}14` : 'var(--surface2)',
                      '--block-edge': c ? `${c}3a` : 'var(--border2)',
                    }}
                    onPointerDown={(e) => onPointerDown(e, item)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(item); } }}
                    title={`${fmtTime(item.startedAt)} · ${minutesLabel(dur)}${item.courseName ? ` · ${item.courseName}` : ''}`}
                  >
                    <div className="cal-block-time">
                      {String(Math.floor(min / 60)).padStart(2, '0')}:{String(min % 60).padStart(2, '0')} · {minutesLabel(dur)}
                    </div>
                    <div className="cal-block-title">{item.courseName || t('cal.study')}</div>
                  </div>
                );
              })}
              {/* No separate drop ghost: the block itself is what moves, so a
                  second marker would be two things claiming the same landing
                  spot. The target day is legible from where the block is. */}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Day agenda ─────────────────────────────────────────────────────────────

function DayAgenda({ iso, byDay, locale, onOpen, onClose, t }) {
  const items = sortDayItems(byDay.get(iso) || []);
  const timed = items.filter((i) => i.kind === 'session');
  const dated = items.filter((i) => i.kind !== 'session');
  const totalMin = timed.reduce((n, s) => n + (s.durationMinutes || 0), 0);

  return (
    <div className="cal-agenda-pane">
      <div className="cal-agenda-head">
        <div>
          <div className="cal-agenda-title">
            {parseLocalDate(iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <div className="cal-agenda-rel">{relativeDayLabel(iso, t)}</div>
        </div>
        <button type="button" className="cal-agenda-close" onClick={onClose} aria-label={t('common.close')}>×</button>
      </div>

      {items.length === 0 && <div className="cal-agenda-empty">{t('cal.dayEmpty')}</div>}

      {dated.length > 0 && (
        <div className="cal-agenda-group">
          {dated.map((it) => (
            <div
              key={`${it.kind}-${it.id}`}
              className="cal-row"
              role="button"
              tabIndex={0}
              style={{ '--row-color': it.color || 'var(--border2)' }}
              onClick={() => onOpen(it)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(it); } }}
            >
              <div className="cal-row-mark" aria-hidden="true" />
              <div className="cal-row-body">
                <div className={`cal-row-title${it.done ? ' done' : ''}`}>{it.title}</div>
                <div className="cal-row-meta">
                  <span>{it.kind === 'exam' ? t('cal.exam') : t('cal.due')}</span>
                  {it.courseName && <span>· {it.courseName}</span>}
                  {it.kind === 'assignment' && it.type && <span>· {t(`av.assignType.${it.type}`, { defaultValue: it.type })}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {timed.length > 0 && (
        <div className="cal-agenda-group">
          <div className="cal-agenda-rel">{t('cal.loggedTotal', { total: minutesLabel(totalMin) })}</div>
          {timed.map((it) => (
            <div key={it.id} className="cal-row" style={{ '--row-color': it.color || 'var(--border2)' }}>
              <div className="cal-row-mark" aria-hidden="true" />
              <div className="cal-row-body">
                <div className="cal-row-title">{it.courseName || t('cal.study')}</div>
                <div className="cal-row-meta">
                  <span>{fmtTime(it.startedAt)}</span>
                  <span>· {minutesLabel(it.durationMinutes || 0)}</span>
                  {it.focusRating != null && <span>· {t('cal.focus', { n: it.focusRating })}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── View ───────────────────────────────────────────────────────────────────

export default function CalendarView({ state, dispatch, session, showFlash, tier, onOpenItem, onAddAsgn, onAddExam }) {
  const { t } = useTranslation();
  const locale = formatLocale();
  const weekStart = useMemo(() => resolveWeekStart(locale), [locale]);

  const [mode, setMode] = useState('month');
  const [anchor, setAnchor] = useState(todayIso);
  // Opens on today rather than on nothing. A calendar whose detail pane starts
  // empty asks the user to click before it tells them anything, and the day
  // they almost always want first is the one they are standing in.
  const [selected, setSelected] = useState(todayIso);

  const { byDay, bands } = useMemo(() => buildEvents(state), [state]);

  const anchorDate = parseLocalDate(anchor);
  const rows = useMemo(
    () => monthGrid(anchorDate.getFullYear(), anchorDate.getMonth(), weekStart),
    // Keyed on the month rather than the day: paging within a month must not
    // rebuild the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [anchorDate.getFullYear(), anchorDate.getMonth(), weekStart],
  );
  const days = useMemo(() => weekGrid(anchor, weekStart), [anchor, weekStart]);

  const step = (dir) => {
    if (mode === 'week') { setAnchor((a) => addDays(a, 7 * dir)); return; }
    const d = parseLocalDate(anchor);
    // Anchored to the 1st before stepping, so paging from the 31st does not
    // skip a short month the way `setMonth` on a 31 would.
    setAnchor(toLocalISO(new Date(d.getFullYear(), d.getMonth() + dir, 1)));
  };

  const title = useMemo(() => {
    if (mode === 'week') {
      const start = parseLocalDate(startOfWeek(anchor, weekStart));
      const end = parseLocalDate(addDays(startOfWeek(anchor, weekStart), 6));
      // `formatRange` rather than two formatted dates joined by a dash. Hand-
      // joining produced "9–August 15" in English, because a day-plus-month
      // format puts the month FIRST in en and last in fi — the join order that
      // reads correctly is a property of the locale, not something to hardcode.
      // Intl already knows it: "August 9 – 15", "9.–15. elokuuta".
      const fmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long' });
      try {
        return fmt.formatRange(start, end);
      } catch {
        // formatRange is very widely supported but is not in the oldest
        // WebViews this app can land in; the fallback is merely plainer.
        return `${fmt.format(start)} – ${fmt.format(end)}`;
      }
    }
    return parseLocalDate(anchor).toLocaleDateString(locale, { month: 'long' });
  }, [mode, anchor, weekStart, locale]);

  const year = parseLocalDate(anchor).getFullYear();

  const onMoveSession = useCallback((item, targetIso, targetMin) => {
    const d = parseLocalDate(targetIso);
    d.setHours(Math.floor(targetMin / 60), targetMin % 60, 0, 0);
    const startedAt = d.toISOString();
    dispatch({ type: 'EDIT_SESSION', id: item.id, startedAt });
    // Partial patch: `updateStudySession` only writes the fields present, so
    // this moves started_at without touching notes, focus or the AI debrief.
    if (session) outbox.enqueue('update_session', { id: item.id, startedAt });
    showFlash?.(t('cal.sessionMoved'));
  }, [dispatch, session, showFlash, t]);

  const openItem = useCallback((item) => {
    setSelected(item.iso);
    onOpenItem?.(item);
  }, [onOpenItem]);

  const exportIcs = () => {
    const n = downloadIcs(state, { locale });
    // -1 is the native platform declining, not a failure to find anything —
    // reporting it as "nothing to export" would be a lie about the user's data.
    if (n < 0) showFlash?.(t('cal.exportNative'));
    else showFlash?.(n > 0 ? t('cal.exported', { n }) : t('cal.exportEmpty'));
  };

  // Keyboard navigation. Deliberately a CONTAINER listener rather than one on
  // `document`: a document listener would page the calendar underneath an open
  // modal, and every single-letter shortcut here is a letter someone is going
  // to type into the assignment-title field it opens.
  //
  // The container therefore takes focus itself (tabIndex -1, focused on mount
  // above the phone tier) so the arrows work on arrival rather than only after
  // something inside has been clicked. `preventScroll` because focusing a tall
  // element otherwise jumps the page to it.
  const rootRef = useRef(null);
  useEffect(() => {
    if (tier === 'phone') return;
    rootRef.current?.focus?.({ preventScroll: true });
  }, [tier]);

  const onKeyDown = (e) => {
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected((s) => addDays(s || anchor, 7)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected((s) => addDays(s || anchor, -7)); }
    else if (e.key === 't' || e.key === 'T') { setAnchor(todayIso()); setSelected(todayIso()); }
    else if (e.key === 'm' || e.key === 'M') setMode('month');
    else if (e.key === 'w' || e.key === 'W') setMode('week');
    else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); onAddAsgn?.(); }
    else if (e.key === 'e' || e.key === 'E') { e.preventDefault(); onAddExam?.(); }
    else if (e.key === 'Escape' && selected) setSelected(null);
  };

  const sheet = mode === 'month'
    ? (
      <MonthSheet
        rows={rows} bands={bands} byDay={byDay} weekStart={weekStart} locale={locale}
        selected={selected} onSelect={setSelected} onOpen={openItem} t={t}
      />
    )
    : (
      <WeekSheet
        days={days} byDay={byDay} weekStart={weekStart} locale={locale}
        onOpen={openItem} onMoveSession={onMoveSession} t={t}
      />
    );

  return (
    <div className="cal" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} role="application" aria-label={t('cal.title')}>
      <div className="cal-bar">
        <div className="cal-title">
          {title} <span className="cal-title-year">{year}</span>
        </div>
        <div className="cal-bar-spacer" />
        <div className="cal-modes" role="tablist" aria-label={t('cal.viewMode')}>
          <button type="button" role="tab" aria-selected={mode === 'month'} className={mode === 'month' ? 'active' : ''} onClick={() => setMode('month')}>{t('cal.month')}</button>
          <button type="button" role="tab" aria-selected={mode === 'week'} className={mode === 'week' ? 'active' : ''} onClick={() => setMode('week')}>{t('cal.week')}</button>
        </div>
        <div className="cal-nav">
          <button type="button" onClick={() => step(-1)} aria-label={t('cal.prev')}><ChevronLeft size={14} strokeWidth={1.75} className="rtl-mirror" /></button>
          <button type="button" onClick={() => { setAnchor(todayIso()); setSelected(todayIso()); }}>{t('cal.today')}</button>
          <button type="button" onClick={() => step(1)} aria-label={t('cal.next')}><ChevronRight size={14} strokeWidth={1.75} className="rtl-mirror" /></button>
        </div>
        <div className="cal-nav">
          <button type="button" onClick={exportIcs} title={t('cal.exportIcsHint')}>
            <Download size={13} strokeWidth={1.75} /> {t('cal.exportIcs')}
          </button>
          <button type="button" onClick={() => window.print()} title={t('cal.printHint')}>
            <Printer size={13} strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* One structure at every tier; CSS decides whether the agenda sits beside
          the sheet or under it. `.cal-split` is applied only when there IS an
          agenda — with an empty second grid column the sheet would sit narrow
          against dead space, which is the thing the wide tier exists to avoid.
          The empty-state placeholder this replaced is gone on purpose: the
          agenda opens on today, so there is nothing to place-hold. */}
      <div className={selected ? 'cal-split' : undefined}>
        {sheet}
        {selected && (
          <DayAgenda iso={selected} byDay={byDay} locale={locale} onOpen={openItem} onClose={() => setSelected(null)} t={t} />
        )}
      </div>
    </div>
  );
}

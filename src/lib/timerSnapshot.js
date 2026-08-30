// v1.12 Item 8e — read the running timer from outside TimerView.
//
// **Why this is a reader and not a state lift.** The build plan says "lift
// running state to app level". It turns out that is already done, just not
// named as such: TimerView persists everything the pill needs to `sd-timer` on
// every change — `running`, `mode`, `phase`, `task`, and crucially `startedAt`
// + `secsAtStart`. Wall-clock is the source of truth for elapsed time, not a
// React tick, which is what makes the timer survive the tab being backgrounded.
//
// So the pill does not need TimerView's state hoisted into a context or store.
// It needs to read the same key and apply the same arithmetic. That is a much
// smaller change than restructuring a 900-line component, and it removes a
// whole class of bug: there is one source of truth, so the pill and the timer
// screen cannot drift apart.
//
// **The arithmetic below is deliberately identical to TimerView's own restore
// path.** If one is changed the other must change with it — that is the cost of
// this approach, and it is cheaper than the alternative. It is a handful of
// lines and both are commented to point at each other.

const KEY = 'sd-timer';

/** Fired by TimerView whenever it persists. localStorage does NOT raise the
 *  native `storage` event for writes made by the same document, only for other
 *  tabs, so a same-document signal is required. Mirrors the outbox's
 *  CustomEvent pattern rather than inventing a second one. */
export const TIMER_CHANGE_EVENT = 'studydesk:timer-change';

function readRaw() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

/**
 * The running timer as of `now`, or null when nothing is running.
 *
 * Returns null rather than a zeroed object when idle, so callers render nothing
 * by simply checking for null — a paused-at-zero pill would be worse than none.
 *
 * @returns {null | {
 *   mode: 'timer'|'stopwatch', phase: 'focus'|'short'|'long',
 *   task: string|null, secs: number, display: string, isBreak: boolean
 * }}
 */
export function readTimerSnapshot(now = Date.now()) {
  const rec = readRaw();
  if (!rec || !rec.running) return null;
  if (!rec.startedAt || rec.secsAtStart == null) return null;

  const mode = rec.mode === 'stopwatch' ? 'stopwatch' : 'timer';
  // Identical to TimerView's `_initSecs`. A stopwatch counts up from where it
  // was; a countdown counts down and floors at zero.
  const elapsed = Math.floor((now - rec.startedAt) / 1000);
  const secs = mode === 'stopwatch'
    ? rec.secsAtStart + elapsed
    : Math.max(0, rec.secsAtStart - elapsed);

  // A countdown that reached zero while the user was elsewhere is finished, not
  // running. TimerView makes the same call on restore (it refuses to auto-
  // resume a timer that ran out), so the pill must not advertise it either.
  if (mode !== 'stopwatch' && secs <= 0) return null;

  const phase = rec.phase === 'short' || rec.phase === 'long' ? rec.phase : 'focus';
  return {
    mode,
    phase,
    isBreak: phase !== 'focus',
    task: typeof rec.task === 'string' && rec.task.trim() ? rec.task.trim() : null,
    secs,
    display: formatClock(secs),
  };
}

/** mm:ss, or h:mm:ss once past an hour — a 2-hour Lock In block (Item 8a) would
 *  otherwise render as "120:00", which reads as minutes at a glance. */
export function formatClock(totalSecs) {
  const s = Math.max(0, Math.floor(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Subscribe to timer start/stop. Returns an unsubscriber.
 *
 * Events only — deliberately no interval here. Advancing the displayed clock is
 * the caller's job and is only needed while something is actually running; a
 * 1 Hz timer that ticks all day so it can re-read "nothing is running" is a
 * battery cost on a phone for no benefit. `startedAt` does the real counting,
 * so a tick is pure presentation.
 */
export function subscribeTimer(listener) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(TIMER_CHANGE_EVENT, listener);
  // Cross-tab: the desktop edition can have the timer open in another window.
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(TIMER_CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

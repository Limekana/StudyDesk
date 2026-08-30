// v1.12 Item 8e — the in-app half of the persistent timer.
//
// The out-of-app half (the Now Bar / status-bar chip) shipped in v1.10 as
// `FocusModePlugin`. This is its counterpart: before this, a running block was
// visible from the phone's home screen but NOT from the Assignments tab of the
// app that owns it, because timer state lived inside TimerView and died on
// navigation.
//
// Issue #39 is the argument for building it. That report is a user whose system
// chip never worked — because the OS was blocking notifications, which no
// amount of native code can override. The in-app pill depends on no OEM
// behaviour and no permission, so it is the half that always works.
//
// Reads `sd-timer` through `timerSnapshot` rather than holding state of its
// own. See that module for why this is a reader and not a state lift.

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { readTimerSnapshot, subscribeTimer } from '../../lib/timerSnapshot.js';

export default function TimerPill({ onOpen, hidden = false }) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState(() => readTimerSnapshot());

  const refresh = useCallback(() => setSnap(readTimerSnapshot()), []);

  // Start/stop arrive as events; see `subscribeTimer`.
  useEffect(() => subscribeTimer(refresh), [refresh]);

  // The clock only needs advancing while something is running. Keyed on
  // `running` rather than on `snap` so the interval is not torn down and
  // rebuilt on every single tick.
  const running = !!snap;
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(refresh, 1000);
    return () => clearInterval(id);
  }, [running, refresh]);

  // Re-read on foreground: a phone can sit in a pocket for an hour, and the
  // interval above is throttled or suspended while backgrounded. The snapshot
  // is derived from wall-clock, so one read on resume is enough to be correct.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // `hidden` is the timer screen itself — showing a pill that points at the
  // page you are already on is noise, and it is the only in-app double-up the
  // acceptance criteria call out.
  if (!snap || hidden) return null;

  const label = snap.mode === 'stopwatch'
    ? t('av.tm.pill.stopwatch')
    : snap.isBreak ? t('av.tm.pill.break') : t('av.tm.pill.focus');

  return (
    <button
      type="button"
      className={`timer-pill timer-pill-${snap.phase}`}
      onClick={onOpen}
      title={snap.task ? t('av.tm.pill.openWith', { task: snap.task }) : t('av.tm.pill.open')}
      aria-label={t('av.tm.pill.aria', { label, time: snap.display })}
    >
      <span className="timer-pill-dot" aria-hidden="true" />
      <span className="timer-pill-time">{snap.display}</span>
      <span className="timer-pill-label">{snap.task || label}</span>
    </button>
  );
}

// The Pomodoro timer — SD-6.
//
// Extracted from App.jsx verbatim. At 347 lines it was the single largest
// component in a 2,216-line file, and it is self-contained: it takes `state`
// and an `onTimerComplete` callback, and reaches nothing else in App's closure.
//
// fmtMMSS came with it — it was declared at module scope in App.jsx but only
// ever called from here. So did the three duration constants, which sat
// directly above the component for the reason the original comment gives.

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { fmtTime } from '../../lib/dates.js';
import '../../styles/timer.css';

function fmtMMSS(sec){ return String(Math.floor(sec/60)).padStart(2,"0")+":"+String(sec%60).padStart(2,"0"); }

// ── Pomodoro Timer ────────────────────────────────────────────────────────────
// Module scope so the hooks below can close over them without the exhaustive-deps
// rule flagging them — they are literal constants, but declared inside the
// component the rule cannot prove they are stable across renders.
const FOCUS_SECS = 25*60, SHORT_SECS = 5*60, LONG_SECS = 15*60;

export default function TimerView({ state, onTimerComplete }) {
  const { t } = useTranslation();

  // Restore persisted timer state from localStorage so tab-switching doesn't reset
  const _saved = (() => { try { return JSON.parse(localStorage.getItem('sd-timer')||'{}'); } catch { return {}; } })();

  const [customFocus, setCustomFocus] = useState(_saved.customFocus||25);
  const [phase, setPhase] = useState(_saved.phase||"focus"); // focus | short | long
  // If timer was running when user left, compute corrected secsLeft
  const _initSecs = (() => {
    if (_saved.running && _saved.startedAt && _saved.secsAtStart) {
      const elapsed = Math.floor((Date.now() - _saved.startedAt) / 1000);
      const corrected = _saved.secsAtStart - elapsed;
      return corrected > 0 ? corrected : 0;
    }
    return _saved.secsLeft || FOCUS_SECS;
  })();
  const [secsLeft, setSecsLeft] = useState(_initSecs);
  // If timer ran out while away, don't auto-resume
  const [running, setRunning] = useState(_saved.running && _initSecs > 0 ? true : false);
  const [session, setSession] = useState(_saved.session||0); // 0-3, cycles every 4
  const [focusDone, setFocusDone] = useState(_saved.focusDone||0); // total focus sessions today
  const [task, setTask] = useState(_saved.task||"");
  const [timerDone, setTimerDone] = useState(false);
  // Lock In: a no-break, no-nav, no-distraction focus mode. Persists
  // across tab switches so coming back to Timer keeps you in flow.
  const [lockedIn, setLockedIn] = useState(_saved.lockedIn || false);
  // Track when the current focus phase started, so SaveSessionSheet
  // can write an accurate `started_at` timestamp to Supabase.
  const phaseStartedAtRef = useRef(_saved.phaseStartedAt || null);
  const intervalRef = useRef(null);
  const phaseRef = useRef(phase);
  const sessionRef = useRef(session);
  const focusDoneRef = useRef(focusDone);
  const taskRef = useRef(task);
  const customFocusRef = useRef(customFocus);
  useEffect(()=>{ phaseRef.current=phase; },[phase]);
  useEffect(()=>{ sessionRef.current=session; },[session]);
  useEffect(()=>{ focusDoneRef.current=focusDone; },[focusDone]);
  useEffect(()=>{ taskRef.current=task; },[task]);
  useEffect(()=>{ customFocusRef.current=customFocus; },[customFocus]);

  // Persist timer state to localStorage so tab-switching preserves it
  useEffect(() => {
    try {
      localStorage.setItem('sd-timer', JSON.stringify({
        customFocus, phase, secsLeft, running, session, focusDone, task, lockedIn,
        startedAt: startedAtRef.current,
        secsAtStart: secsAtStartRef.current,
        phaseStartedAt: phaseStartedAtRef.current,
      }));
    } catch {}
  }, [customFocus, phase, secsLeft, running, session, focusDone, task, lockedIn]);

  // Background-safe elapsed tracking refs
  const startedAtRef = useRef(null);
  const secsAtStartRef = useRef(null);

  // Vibration + beep on phase end
  const fireCompletionAlert = useCallback(() => {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const beep = (freq, start, dur) => {
        const osc = ctx.createOscillator(); const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'sine';
        gain.gain.setValueAtTime(0.35, ctx.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + start + dur + 0.05);
      };
      beep(880, 0, 0.18); beep(880, 0.25, 0.18); beep(1100, 0.5, 0.35);
    } catch {}
  }, []);

  const lockedInRef = useRef(lockedIn);
  useEffect(()=>{ lockedInRef.current = lockedIn; }, [lockedIn]);

  const handlePhaseEnd = useCallback(() => {
    clearInterval(intervalRef.current);
    startedAtRef.current = null;
    setRunning(false);
    setTimerDone(true);
    setTimeout(()=>setTimerDone(false), 1500);
    fireCompletionAlert();
    const p=phaseRef.current, sess=sessionRef.current, fd=focusDoneRef.current, cf=customFocusRef.current;
    if (p==='focus') {
      setFocusDone(fd+1);
      // Raise the SaveSessionSheet — user explicitly opts in to logging.
      const startedAtIso = phaseStartedAtRef.current
        ? new Date(phaseStartedAtRef.current).toISOString()
        : new Date(Date.now() - cf*60*1000).toISOString();
      onTimerComplete?.({
        durationMinutes: cf,
        task: taskRef.current,
        startedAt: startedAtIso,
      });
      phaseStartedAtRef.current = null;
      // Lock In skips break cycling — stays on focus, ready for the next block.
      // Regular Pomodoro cycles short / long breaks every 4 focus sessions.
      if (lockedInRef.current) {
        setPhase('focus');
        setSecsLeft(cf*60);
      } else {
        const nextSession=(sess+1)%4;
        setSession(nextSession);
        const nextPhase=nextSession===0?'long':'short';
        setPhase(nextPhase);
        setSecsLeft(nextPhase==='long'?LONG_SECS:SHORT_SECS);
      }
    } else {
      setPhase('focus');
      setSecsLeft(cf*60);
    }
  }, [fireCompletionAlert, onTimerComplete]);

  const tick = useCallback(() => {
    setSecsLeft(s => { if (s <= 1) { handlePhaseEnd(); return 0; } return s - 1; });
  }, [handlePhaseEnd]);

  // Background correction: recalculate elapsed on app resume
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && running && startedAtRef.current !== null) {
        const elapsed = Math.floor((Date.now() - startedAtRef.current) / 1000);
        const corrected = (secsAtStartRef.current || 0) - elapsed;
        if (corrected <= 0) { handlePhaseEnd(); }
        else {
          setSecsLeft(corrected);
          startedAtRef.current = Date.now();
          secsAtStartRef.current = corrected;
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [running, handlePhaseEnd]);

  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const totalSecs = phase==="focus" ? customFocus*60 : phase==="short" ? SHORT_SECS : LONG_SECS;
  const pct = secsLeft / totalSecs;
  const R = 100, CIRC = 2*Math.PI*R;
  const phaseColor = phase==="focus" ? "#1a1814" : phase==="short" ? "#2e7d52" : "#1a5c9e";

  useEffect(() => {
    if (running) {
      startedAtRef.current = Date.now();
      secsAtStartRef.current = secsLeft;
      // The actual 1s tick — without this the timer doesn't advance.
      intervalRef.current = setInterval(tick, 1000);
      // Capture the phase start so onTimerComplete can report an accurate started_at.
      // For focus phases, only set this if we're actually beginning a fresh phase
      // (not resuming from a pause mid-phase). Approximation: if secsLeft equals
      // the full duration, treat as a fresh start.
      if (phaseRef.current === 'focus' && secsLeft === customFocusRef.current*60) {
        phaseStartedAtRef.current = Date.now();
      } else if (phaseRef.current === 'focus' && phaseStartedAtRef.current == null) {
        // Resuming a paused focus that never had a start recorded — back-compute.
        phaseStartedAtRef.current = Date.now() - (customFocusRef.current*60 - secsLeft) * 1000;
      }
    } else {
      clearInterval(intervalRef.current);
      startedAtRef.current = null;
    }
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, tick]);

  const toggle = () => setRunning(r=>!r);
  const reset = () => { setRunning(false); setSecsLeft(phase==="focus"?customFocus*60:phase==="short"?SHORT_SECS:LONG_SECS); };
  const skip = () => {
    setRunning(false);
    if (phase==="focus") { const np=(session+1)%4===0?"long":"short"; setPhase(np); setSecsLeft(np==="long"?LONG_SECS:SHORT_SECS); setSession(s=>(s+1)%4); }
    else { setPhase("focus"); setSecsLeft(customFocus*60); }
  };
  const changeCustom = (v) => { if(!running){ setCustomFocus(v); if(phase==="focus") setSecsLeft(v*60); } };

  // Toggle Lock In: force a clean focus phase, hide nav, no breaks.
  // Exiting Lock In stops the timer cleanly so the user explicitly chooses
  // whether to keep going in regular mode.
  const toggleLockIn = () => {
    setLockedIn(li => {
      const next = !li;
      if (next) {
        // Entering Lock In — reset to a fresh focus block at current custom duration.
        setPhase("focus");
        setSecsLeft(customFocus * 60);
        setSession(0);
      } else {
        // Exiting Lock In — stop and let the user reorient.
        setRunning(false);
      }
      return next;
    });
  };

  // While locked in we add a body class so the bottom mobile tab bar and
  // desktop sidebar can hide via CSS. Cleans up on unmount / toggle-off.
  useEffect(() => {
    if (lockedIn) document.body.classList.add('locked-in');
    else document.body.classList.remove('locked-in');
    return () => document.body.classList.remove('locked-in');
  }, [lockedIn]);

  // v1.9 Item 14a follow-up — Lock In takes the whole screen, not just the
  // app's own chrome. On desktop the browser's tab strip and address bar are
  // exactly the distraction this mode exists to remove.
  //
  // Failures are swallowed on purpose and are NOT edge cases: requestFullscreen
  // is gated on a user gesture, and browsers reject it outright when the page
  // is not focused or the user has denied it. Lock In must still work as a
  // focus mode when the request is refused — losing fullscreen is a smaller
  // loss than the timer not starting. Android's WebView has no fullscreen
  // concept here either, so the same path covers it.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const el = document.documentElement;
    if (lockedIn) {
      if (!document.fullscreenElement && el.requestFullscreen) {
        Promise.resolve(el.requestFullscreen()).catch(() => { /* denied — carry on */ });
      }
    } else if (document.fullscreenElement && document.exitFullscreen) {
      Promise.resolve(document.exitFullscreen()).catch(() => {});
    }
    // Leaving fullscreen by pressing Escape must not strand the app in a
    // locked-in state whose exit affordance the user just bypassed.
    const onFsChange = () => {
      if (!document.fullscreenElement && lockedIn) setLockedIn(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [lockedIn]);

  // ── Lock In takeover view ───────────────────────────────────────────────
  if (lockedIn) {
    return <div className="lockin-wrap">
      <div className="lockin-top">
        <span className="lockin-badge">{t('av.tm.lockIn')}</span>
        <span className="lockin-task">{task || t('av.tm.deepFocus')}</span>
      </div>
      <div className={"pomo-ring-wrap lockin-ring"+(timerDone?" pomo-ring-done":"")}>
        <svg className="pomo-ring-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
          <circle cx="110" cy="110" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6"/>
          <circle cx="110" cy="110" r={R} fill="none"
            stroke="#faf8f4" strokeWidth="6" strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC*(1-pct)}
            transform="rotate(-90 110 110)"/>
        </svg>
        <div className="pomo-ring-label">
          <div className={"pomo-time"+(timerDone?" pomo-time-flash":"")} style={{color:"#faf8f4"}}>{fmtMMSS(secsLeft)}</div>
          <div className="pomo-phase" style={{color:"rgba(250,248,244,0.5)"}}>{t('av.tm.focusDone',{n:focusDone})}</div>
        </div>
      </div>
      <input
        type="text"
        className="lockin-task-input"
        placeholder={t('av.tm.lockPlaceholder')}
        value={task}
        onChange={e=>setTask(e.target.value)}
      />
      <div className="lockin-controls">
        <button className="lockin-btn-main" onClick={toggle} aria-label={running?t('av.tm.pause'):t('av.tm.start')}>
          {running
            ? <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><polygon points="6,3 20,12 6,21"/></svg>
          }
        </button>
      </div>
      <div className="lockin-presets">
        {[25,45,60,90].map(m=><button key={m} className={"lockin-preset"+(customFocus===m?" active":"")} onClick={()=>changeCustom(m)} disabled={running}>{m}m</button>)}
      </div>
      <button className="lockin-exit" onClick={toggleLockIn}>{t('av.tm.endSession')}</button>
    </div>;
  }

  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",paddingTop:24,paddingBottom:32}}>
    <div className={"pomo-ring-wrap"+(timerDone?" pomo-ring-done":"")}>
      <svg className="pomo-ring-svg" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg">
        <circle cx="110" cy="110" r={R} fill="none" stroke="var(--border)" strokeWidth="8"/>
        <circle cx="110" cy="110" r={R} fill="none"
          stroke={phaseColor} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC*(1-pct)}
          transform="rotate(-90 110 110)"/>
      </svg>
      <div className="pomo-ring-label">
        <div className={"pomo-time"+(timerDone?" pomo-time-flash":"")} style={{color:phaseColor}}>{fmtMMSS(secsLeft)}</div>
        <div className="pomo-phase">{phase==="focus"?t('av.tm.focus'):phase==="short"?t('av.tm.shortBreak'):t('av.tm.longBreak')}</div>
      </div>
    </div>
    <div className="pomo-segments">
      {[0,1,2,3].map(i=><div key={i} className={"pomo-seg"+(i<focusDone%4?"done":i===session&&phase==="focus"?"current":"")}/>)}
    </div>
    <div className="pomo-controls">
      <button className="pomo-btn-sec" onClick={reset} title={t('av.tm.reset')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3.3-6.7"/><polyline points="3 3 3 8 8 8"/></svg>
      </button>
      <button className={"pomo-btn-main"+(!running && secsLeft < totalSecs?" paused":"")} onClick={toggle}>
        {running
          ? <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><rect x="5" y="4" width="4" height="16" rx="1"/><rect x="15" y="4" width="4" height="16" rx="1"/></svg>
          : <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true"><polygon points="6,3 20,12 6,21"/></svg>
        }
      </button>
      <button className="pomo-btn-sec" onClick={skip} title={t('av.tm.skip')}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><polygon points="5,4 15,12 5,20"/><rect x="17" y="4" width="3" height="16" rx="1"/></svg>
      </button>
    </div>
    {phase==="focus"&&<div className="pomo-presets">
      {[15,20,25,30,45,60].map(m=><button key={m} className={"pomo-preset-btn"+(customFocus===m?" active":"")} onClick={()=>changeCustom(m)}>{m}m</button>)}
    </div>}
    <button className="lockin-enter" onClick={toggleLockIn} title={t('av.tm.lockInTitle')}>
      🔒 {t('av.tm.lockInBtn')}
    </button>
    <div className="pomo-task-row">
      <div className="pomo-task-label">{t('av.tm.studying')}</div>
      <input type="text" placeholder={t('av.tm.workingPlaceholder')} value={task} onChange={e=>setTask(e.target.value)} style={{fontSize:14,padding:"10px 12px"}}/>
      {courses.length>0&&<select aria-label={t('av.tm.quickFillAria')} value="" onChange={e=>setTask(e.target.value)} style={{marginTop:6}}>
        <option value="">{t('av.tm.quickFillOption')}</option>
        {courses.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}
      </select>}
    </div>
    {(()=>{
      const sessions = (state.studySessions||[]).filter(s=>!s.deletedAt);
      if (sessions.length === 0) return null;
      const today = new Date().toISOString().slice(0,10);
      const dateKey = (iso) => iso ? iso.slice(0,10) : null;
      const todayList = sessions
        .filter(s => dateKey(s.startedAt) === today)
        .sort((a,b)=> (b.startedAt||"").localeCompare(a.startedAt||""));
      // Weekly summary: group by ISO Monday-week
      const getWeekKey = (iso) => {
        if(!iso) return null;
        const d = new Date(iso); if (isNaN(d.getTime())) return null;
        const day = d.getDay(); const diff = d.getDate() - day + (day===0?-6:1);
        const mon = new Date(d); mon.setDate(diff);
        return mon.toISOString().slice(0,10);
      };
      const weekMap = {};
      sessions.forEach(s => {
        const wk = getWeekKey(s.startedAt); if(!wk) return;
        weekMap[wk] = (weekMap[wk]||0) + (Number(s.durationMinutes)||0);
      });
      const weeks = Object.entries(weekMap).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,8);
      const thisWeekKey = getWeekKey(new Date().toISOString());
      return <div className="pomo-session-log">
        <div className="section-label" style={{marginTop:24}}>{t('av.tm.weeklyHours')}</div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:16}}>
          {weeks.map(([wk,mins])=>{
            const hrs = (mins/60).toFixed(1);
            const label = wk===thisWeekKey?t('av.tm.thisWeek'):t('av.tm.wk',{n:wk.slice(5)});
            const barH = Math.max(4, Math.round((mins/600)*48));
            return <div key={wk} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3,minWidth:44}}>
              <span style={{fontFamily:"var(--font-mono)",fontSize:9,color:"var(--muted2)"}}>{hrs}h</span>
              <div style={{width:28,height:barH,background:wk===thisWeekKey?"var(--text)":"var(--border2)",borderRadius:2,alignSelf:"flex-end"}}/>
              <span style={{fontFamily:"var(--font-mono)",fontSize:8,color:"var(--muted2)",textAlign:"center"}}>{label}</span>
            </div>;
          })}
        </div>
        {todayList.length>0 && <>
          <div className="section-label">{t('av.tm.todaysSessions')}</div>
          {todayList.map(s=>{
            const c = s.subjectId ? state.courses[s.subjectId] : null;
            const ts = fmtTime(s.startedAt);
            return <div key={s.id} className="pomo-log-entry">
              <span className="pomo-log-badge">{ts}</span>
              <span>{c?.name || s.notes || "—"}</span>
              <span style={{marginLeft:"auto",fontFamily:"var(--font-mono)",fontSize:10,color:"var(--muted2)"}}>{s.durationMinutes}m</span>
            </div>;
          })}
        </>}
      </div>;
    })()}
  </div>;
}

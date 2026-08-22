// Data for the desktop glance widget.
//
// The widget runs its own Supabase client rather than being fed over IPC from
// the main window, and that is the whole design. The value of a floating
// widget is glancing at it WITHOUT the app open; an IPC-tethered one only has
// data while the main window is alive, which makes it a small second copy of
// the app rather than a glance.
//
// Sharing the session works because both windows are the same origin now
// (studydesk://app — see electron/main.cjs). Before v1.11 the shell served
// from a random port, so there was no stable origin to share and this could
// not have worked at all.
//
// On running two Supabase clients against one stored session: this is the
// ordinary multi-tab case, which supabase-js handles with the Web Locks API —
// refreshes are serialised per origin, so the two windows cannot race each
// other into burning the refresh-token chain. That failure mode is on record
// in this suite (rapid reloads signing all three apps out at once), which is
// why it is called out here rather than assumed away.
//
// Polling, not Realtime: "what is next" changes on the order of hours. A
// subscription would hold a websocket open all day to deliver almost nothing.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { applyRemotePull } from '../lib/merge.js';
import { toLocalISO } from '../lib/dates.js';

const POLL_MS = 60_000;

// applyRemotePull dereferences subjects/grades/sessions without a default, and
// defaults the rest. Passing a complete shape keeps the widget honest about
// what it did and did not ask the server for: an empty array here means "not
// queried", not "none exist", and nothing in the widget reads those.
const EMPTY_REMOTE = {
  subjects: [], grades: [], sessions: [], assignments: [], exams: [],
  actions: [], plannedSessions: [], academicTerms: [], timetableEntries: [],
  attachments: [], commitments: [],
};

function dayBounds(now) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchGlance(now) {
  const { start, end } = dayBounds(now);

  // Five tables, not the eleven a full sync pulls. Terms and timetable entries
  // come in whole because lesson resolution needs the term tree to decide which
  // level's schedule wins; the other three are scoped.
  //
  // Assignments are NOT filtered on `done` server-side: a row where the column
  // is null rather than false would drop out of `.eq('done', false)` and the
  // widget would silently omit real homework. Filtering locally on Boolean()
  // matches how the rest of the app reads that column.
  const [subjects, assignments, planned, terms, timetable] = await Promise.all([
    supabase.from('subjects').select('*'),
    supabase.from('assignments').select('*'),
    supabase.from('planned_sessions').select('*').gte('starts_at', start).lt('starts_at', end),
    supabase.from('academic_terms').select('*'),
    supabase.from('timetable_entries').select('*'),
  ]);

  for (const res of [subjects, assignments, planned, terms, timetable]) {
    if (res.error) throw res.error;
  }

  return applyRemotePull({}, {
    ...EMPTY_REMOTE,
    subjects: subjects.data || [],
    assignments: assignments.data || [],
    plannedSessions: planned.data || [],
    academicTerms: terms.data || [],
    timetableEntries: timetable.data || [],
  });
}

/**
 * @returns {{status: 'loading'|'signedOut'|'error'|'ready', state: object|null,
 *            todayIso: string, now: Date, refresh: () => void}}
 */
export function useGlance() {
  const [status, setStatus] = useState('loading');
  const [state, setState] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const [signedIn, setSignedIn] = useState(null); // null = not yet resolved
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSignedIn(Boolean(data?.session));
    }).catch(() => {
      if (!cancelled) setSignedIn(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
    });
    return () => { cancelled = true; sub?.subscription?.unsubscribe(); };
  }, []);

  const load = useCallback(async () => {
    // A slow poll must not stack on itself. Without this a request that takes
    // longer than the interval would queue another every 60s indefinitely.
    if (inFlight.current) return;
    inFlight.current = true;
    const at = new Date();
    try {
      const next = await fetchGlance(at);
      setState(next);
      setNow(at);
      setStatus('ready');
    } catch {
      // Keep whatever is on screen. A dropped Wi-Fi connection should leave the
      // last known plan visible rather than blanking a widget the user glances
      // at — the error state is only for when there is nothing to show yet.
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (signedIn === null) return;
    if (!signedIn) { setStatus('signedOut'); setState(null); return; }

    load();
    const poll = setInterval(load, POLL_MS);
    // The clock has to advance even when the data does not: "what is still to
    // come" is a function of the time, so a widget left open past a lesson
    // would otherwise keep showing it as upcoming until the next fetch.
    const tick = setInterval(() => setNow(new Date()), 30_000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [signedIn, load]);

  return { status, state, todayIso: toLocalISO(now), now, refresh: load };
}

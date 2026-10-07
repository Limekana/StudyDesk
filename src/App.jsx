import { useState, useEffect, useCallback, useReducer, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { fmtToday } from "./lib/dates.js";
import { App as CapApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { supabase } from "./lib/supabase.js";
import AuthGate from "./features/auth/AuthGate.jsx";
import SetPasswordScreen from "./features/auth/SetPasswordScreen.jsx";
import { isRecoveryPending, subscribeRecovery } from "./lib/passwordRecovery.js";
import { isGuestMode, setGuestMode } from "./lib/guestMode.js";
import { scheduleOriginStamp } from "./lib/originMarker.js";
import { watchAppOpens } from "./lib/appOpens.js";
import { refreshEntitlement } from "./lib/entitlement.js";
import { downloadExport } from "./lib/dataRights.js";
import StorageAlert from "./features/settings/StorageAlert.jsx";
import FdroidUpdateNote from "./features/update/FdroidUpdateNote.jsx";
import TimerPill from "./features/timer/TimerPill.jsx";
import { useAccountAvatar } from "./lib/useAccountAvatar.js";
import ReferralPrompt from "./features/referral/ReferralPrompt.jsx";
import PolicyUpdatedNote from "./features/errors/PolicyUpdatedNote.jsx";
import { setReportScreen } from "./lib/errorReports.js";
import { inheritFromNexus } from "./lib/suiteSso.js";
import { hydrateOnboardedFromCloud, markOnboardedCloud } from "./lib/onboardingCloud.js";
import * as sync from "./lib/sync.js";
import * as outbox from "./lib/outbox.js";
import { reconcileUnsynced } from "./lib/reconcile.js";
import { stampsFromPull, shouldPull } from "./lib/syncStamps.js";
import SaveSessionSheet from "./features/sessions/SaveSessionSheet.jsx";
import { pastSessionDraft } from "./lib/pastSession.js";
import "./styles/notebook.css";
import CoursePicker from "./lib/CoursePicker.jsx";
import { AddAsgnModal, AddExamModal, EditCourseModal } from "./features/plan/CourseModals.jsx";
import CourseDetailView from "./features/plan/CourseDetailView.jsx";
import PlanView from "./features/plan/PlanView.jsx";
import ActionsView from "./features/actions/ActionsView.jsx";
import { daysUntil } from "./lib/deadlines.js";
import { INITIAL, reducer, newSyncId } from "./lib/appReducer.js";
// Cascade order preserved from the old css+css2+css3+css4+cssOnboard concat.
import './styles/base.css';
/* Load order is load-bearing. base.css declares the free light palette on
   bare :root; modes.css scopes the two free dark palettes on [data-mode];
   themes.css scopes the two paid palettes on [data-theme]. All three are
   (0,1,0) or looser, so the LAST matching one wins — which is why a paid
   theme applied over a remembered dark preference resolves to the paid theme
   and not a hybrid. See the header comment in modes.css. */
import './styles/modes.css';
import './styles/themes.css';
import './styles/forms.css';
import './styles/cards.css';
import './styles/onboarding.css';
// v1.9 Item 14a — imported at the shell so the print rules apply to every
// screen, not only the ones that offer a print button.
import './styles/print.css';
import './styles/desktop.css';
import { COURSE_COLORS } from "./lib/courseColors.js";
import { NotebookPen, CalendarDays, Award, Timer, PanelLeftClose, PanelLeftOpen, BookOpen } from "lucide-react";
import { checkForDesktopUpdate, runDesktopUpdateAction, useDesktopUpdate } from "./lib/desktopUpdate.js";
import { AccountAvatar } from "./lib/avatar.jsx";
import { useShellTier, useSidebarRail } from "./lib/useShell.js";
import { enterSubmit } from "./lib/imeSubmit.js";
import { rehydrateState } from "./app/rehydrate.js";
import { usePersistState } from "./app/usePersistState.js";
import { useReminders } from "./app/useReminders.js";
import { useWidgets } from "./app/useWidgets.js";
import { useOutboxTriggers, useReminderActions } from "./app/useAppEvents.js";
import { useNoteSync } from "./app/useNoteSync.js";
import { useCloudPushers } from "./app/useCloudPushers.js";

// v1.17 (limecore#13): every feature view is its own chunk, loaded the first
// time its tab is opened. The views a launch opens on (actions, the plan list,
// the course pane) are imported statically above and stay in the entry chunk.
const GradesView = lazy(() => import("./features/grades/GradesView.jsx"));
const SessionsView = lazy(() => import("./features/sessions/SessionsView.jsx"));
const NotebookView = lazy(() => import("./features/notebook/NotebookView.jsx"));
const TimerView = lazy(() => import("./features/timer/TimerView.jsx"));
const StatsView = lazy(() => import("./features/stats/StatsView.jsx"));
const CalendarView = lazy(() => import("./features/calendar/CalendarView.jsx"));
const AnalyticsView = lazy(() => import("./features/analytics/AnalyticsView.jsx"));
const TimetableView = lazy(() => import("./features/timetable/TimetableView.jsx"));
const SettingsView = lazy(() => import("./features/settings/SettingsView.jsx"));
// v1.17 (limecore#12): only a first run ever shows onboarding.
const OnboardingView = lazy(() => import("./features/onboarding/OnboardingView.jsx"));

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL, rehydrateState);
  const { t } = useTranslation();

  // ── Auth session — DECLARED FIRST, DELIBERATELY ────────────────────────────
  //
  // `session` is read by dependency arrays scattered through this component,
  // and a dependency array is evaluated DURING RENDER. A `const` is in its
  // temporal dead zone until its own line runs, so any `[..., session]` above
  // this point throws `ReferenceError: Cannot access 'session' before
  // initialization` on the very first render. React unwinds, nothing is
  // committed into `#root`, and the user gets a blank page in the app's cream
  // ground — no crash, no console output in a release build, nothing.
  //
  // THIS HAS NOW SHIPPED TWICE. v1.10 hit it with the account-onboarding
  // effect; the fix then was a comment telling the next author to keep their
  // effect below the declaration. v1.13's notebook work added four more
  // `session` readers above it — the debounced note-push effect, its flush,
  // the note delete, and the export callback — and blanked the app again, this
  // time only discovered by installing a signed APK on a physical phone and
  // dumping the view hierarchy to find `#root` present with zero children.
  //
  // "Remember to declare your effect below this line" is not a fix, because it
  // asks every future author to know about a bug they have never seen. Hoisting
  // the declaration to the top of the component is: there is no longer anywhere
  // above it to put an effect. Keep it here.
  //
  // Why nothing caught it: `npm run build` succeeds (this is valid JS, the
  // error is at runtime), eslint's react-hooks rules do not model TDZ, and
  // `npm run dev` does not reproduce it — the dev server's unbundled ESM
  // evaluates the module differently from the production chunk. Only a
  // production build, actually loaded in a browser, shows it. That is what
  // `npm run check:boot` now does, and it runs in CI.
  //
  // undefined = auth still resolving · null = signed out · object = signed in.
  const [session, setSession] = useState(undefined);
  // StudyDesk#75 — for callbacks memoised with [] (onboarding) that must still
  // know whether a push can be queued. Written in an effect, like stateRef.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; });
  // v1.1 — guest mode flag. When `session === null` AND `guest === true`, the
  // app renders normally with cloud sync disabled (Supabase realtime + outbox
  // are already session-gated, so this is a pure UI bypass — no other code
  // changes needed). When the user signs in or signs out, the flag is cleared.
  const [guest, setGuest] = useState(() => isGuestMode());
  // #52 — a password-recovery session is a session, so without this flag the
  // gate below would open the whole app the moment the user proved they own the
  // mailbox, leaving the password they came to change still unknown: in on this
  // device, locked out on the next. Declared HERE, with the other gate state,
  // because the TDZ incident this app shipped twice came from exactly this kind
  // of binding being read by an effect above its declaration.
  const [recoveryPending, setRecoveryPending] = useState(() => isRecoveryPending());
  useEffect(() => subscribeRecovery(() => setRecoveryPending(isRecoveryPending())), []);

  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem("studydesk-onboarded") === "1"; } catch { return false; }
  });
  // v1.10 - ask the ACCOUNT whether onboarding is already done, not just this
  // device. The effect that does the asking lives further down, immediately
  // after `session` is declared -- it reads `session`, and a dependency array
  // is evaluated during render, so up here it referenced the binding before
  // its useState had run.
  const [onboardChecked, setOnboardChecked] = useState(false);
  usePersistState(state);

  useReminders({ onboarded, state, t });

  useWidgets({ state, t, dispatch });

  // ── Sync bookkeeping shared by the effects below (StudyDesk#72) ─────────
  // Declared up here, ahead of the first effect that names them: hook
  // dependency arrays are read during render, so a later `const` would be in
  // its temporal dead zone (scripts/check-dep-tdz.mjs).
  //
  // `pulledOnce` — the first pull of this session has settled, as state, for
  // effects that must RE-RUN when it flips rather than merely read it (the
  // note autosave). `pulledOnceRef` below is the same fact for the reconciler.
  const [pulledOnce, setPulledOnce] = useState(false);
  // What the last pull said about each row the effects below push unprompted.
  // Written BEFORE `MERGE_REMOTE` is dispatched, so the effects that re-run on
  // the merged state already see it. See src/lib/syncStamps.js.
  const remoteStampsRef = useRef(null);
  // A throttled "pull now", set by the sync effect while a session exists
  // and called when the user comes back to the window.
  const requestPullRef = useRef(null);

  useOutboxTriggers(requestPullRef);

  useReminderActions(dispatch);
  // Notifications are only scheduled after onboarding completes — never on first open
  const handleOnboardingComplete = useCallback((courseData, opts = {}) => {
    if (courseData) {
      // StudyDesk#75 — this was the one course-creation path that never queued
      // its push. Onboarding runs signed in, so the course stayed local-only
      // while the user's first assignments, grades and notes on it failed the
      // server's foreign key and were quarantined. The id is minted here so the
      // local row and the queued push agree on it.
      const id = newSyncId();
      dispatch({type:"ADD_COURSE", id, name:courseData.name, color:courseData.color});
      if (sessionRef.current) outbox.enqueue("upsert_subject", { id, name: courseData.name, color: courseData.color });
    }
    // `notifications` carries which of the two step-3 buttons was pressed.
    // Default true so any caller that omits it (or a skip that never reaches
    // step 3) behaves as before; only an explicit false opts out.
    dispatch({type:"SET_NOTIF_ENABLED", on: opts.notifications !== false});
    try { localStorage.setItem("studydesk-onboarded","1"); } catch {}
    void markOnboardedCloud();
    setOnboarded(true);
    // Notifications scheduled via useEffect watching onboarded — avoids stale closure (#21)
  }, []);

  const [flash, setFlash] = useState(null);
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [editingCourse, setEditingCourse] = useState(null);
  const [showAddAsgn, setShowAddAsgn] = useState(false);
  const [showAddExam, setShowAddExam] = useState(false);
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseColor, setNewCourseColor] = useState(COURSE_COLORS[0]);
  const showFlash = useCallback((msg) => { setFlash(msg); setTimeout(()=>setFlash(null),2200); }, []);

  const { onDeleteNote } = useNoteSync({ state, session, pulledOnce, remoteStampsRef, dispatch });

  // v1.13 Item 1a — the escape hatch offered by StorageAlert.
  //
  // Reads from `state`, which is IN MEMORY and still correct, rather than
  // from localStorage, which is the thing that just failed. That is the whole
  // point of the button: it is the one action that does not depend on
  // anything currently broken. `downloadExport` builds a blob and hands it to
  // the browser, touching no persistent storage on the way.
  const onExportFromAlert = useCallback(async () => {
    try {
      const name = await downloadExport(state, session);
      showFlash(t('settings.exportDone', { name }));
    } catch (e) {
      showFlash(t('settings.exportFailed', { msg: e.message }));
    }
  }, [state, session, showFlash, t]);

  // ── Auth session ─────────────────────────────────────────────────────────────
  // `session` and `guest` are DECLARED AT THE TOP of this component, with the
  // other state, not here. See the block comment there — it is the reason.

  // v1.10 - the account-level onboarding check. Declared HERE, below `session`,
  // rather than beside the `onboardChecked` state it drives: the dependency
  // array `[session]` is evaluated on every render, so with this block above
  // `const [session, ...] = useState(...)` it read `session` inside its
  // temporal dead zone and threw "Cannot access 'session' before
  // initialization", blanking the app on first paint.
  //
  // That failure was invisible to `npm run build` and to eslint, and did not
  // reproduce under `npm run dev` -- only a production preview of the built
  // bundle showed it. Keep this effect below the declaration.
  //
  // Gated so a signed-in user never sees a frame of the wizard before the
  // answer lands; a guest or signed-out user resolves immediately, because
  // there is no account to ask.
  useEffect(() => {
    if (session === undefined) return;   // auth still resolving
    if (!session) { setOnboardChecked(true); return; }
    let cancelled = false;
    setOnboardChecked(false);
    hydrateOnboardedFromCloud().then((done) => {
      if (cancelled) return;
      if (done) setOnboarded(true);
      setOnboardChecked(true);
    });
    return () => { cancelled = true; };
  }, [session]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let { data } = await supabase.auth.getSession();

      // v1.1 — auto-inherit from NCC on cold start when no local session.
      //
      // Why: Supabase rotates refresh_tokens on every refresh. NCC and
      // StudyDesk share ONE logical session via the SSO bundle but each
      // app's supabase client persists its own copy. When NCC's background
      // auto-refresh rotates the token, StudyDesk's stored refresh_token
      // becomes stale; its next refresh attempt fails; onAuthStateChange
      // fires SIGNED_OUT. Symptom: every cold start lands the user on
      // AuthGate needing to tap Continue with Nexus again.
      //
      // Fix: when getSession() returns null, probe NCC's ContentProvider
      // and silently inherit. As long as NCC is signed in, this re-syncs
      // StudyDesk to the latest published bundle without user-visible
      // re-auth. Guest mode and the web platform short-circuit this path.
      if (!data.session && !isGuestMode() && Capacitor.isNativePlatform()) {
        try {
          const result = await inheritFromNexus();
          if (result.ok) {
            ({ data } = await supabase.auth.getSession());
          }
        } catch (e) {
          console.warn("[studydesk] auto-inherit on init failed:", e);
        }
      }

      if (!cancelled) setSession(data.session);
      // ACT-5 — cover the restored-session path too, not just fresh sign-ins.
      // Every account that predates this instrumentation only ever appears here.
      scheduleOriginStamp(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      scheduleOriginStamp(s?.user ?? null);
      // v1.1 — any successful sign-in clears guestMode so the user resumes
      // normal session-based flow. Without this, a user who signed out
      // (which sets guestMode=true to prevent next-launch auto-inherit
      // undoing the sign-out) and later signs back in would keep
      // guestMode=true. The gate would still work (session wins), but if
      // the session expired the next cold start would silently land them
      // in guest mode rather than attempting auto-inherit. Centralizing
      // the clear here means every sign-in path (Nexus inherit, Google,
      // email, restored session) converges to the same state.
      if (event === "SIGNED_IN") {
        setGuestMode(false);
        window.dispatchEvent(new CustomEvent("studydesk:guest-mode-changed"));
      }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);
  // Listen for guest-mode flag changes triggered by AuthGate (set) or the
  // sign-out path below (clear). localStorage doesn't emit change events
  // within the same tab, so we use a CustomEvent contract on `window`.
  useEffect(() => {
    const onChange = () => setGuest(isGuestMode());
    window.addEventListener("studydesk:guest-mode-changed", onChange);
    return () => window.removeEventListener("studydesk:guest-mode-changed", onChange);
  }, []);

  // v1.7 — true once the first pull of this session has settled. The push
  // reconciler below stays disarmed until then.
  const pulledOnceRef = useRef(false);

  // The pull effect below deliberately re-subscribes only when the user id
  // changes, so its closure holds a stale `state`. The reconcile needs the
  // CURRENT local rows to diff against what the pull returned — hence a ref.
  // Written in an effect rather than during render: refs must not be mutated
  // while rendering, and this commits before any pull callback can resolve.
  // v1.12 Item 9 — the topbar avatar must show what the user actually chose,
  // not just their initials. Re-resolves on any profile edit.
  const accountAvatar = useAccountAvatar(session);

  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });

  // ── Sync: initial pull + Realtime, gated on sign-in ─────────────────────────
  useEffect(() => {
    if (!session) {
      sync.stopRealtime();
      pulledOnceRef.current = false;
      setPulledOnce(false);
      remoteStampsRef.current = null;
      requestPullRef.current = null;
      return;
    }
    let cancelled = false;
    let lastPullAt = NaN;
    const doPull = async () => {
      lastPullAt = Date.now();
      try {
        const remote = await sync.pullAllStudyData();
        // StudyDesk#72 — stamps first, merge second. The merge re-runs the
        // push effects, and they must already know which rows are just the
        // server's own copy coming back.
        if (!cancelled) remoteStampsRef.current = stampsFromPull(remote);
        if (!cancelled) dispatch({ type: "MERGE_REMOTE", remote });
        // v1.12 Item 1 (#38) — repair rows that never reached the server.
        // Every enqueue site is gated on `session`, so anything written while
        // the session was null (every cold start; and for hours a day under
        // `SESS-1`) was dropped rather than queued, with no path back. Diffing
        // local against the pull is what finds them; `outbox.drain`'s
        // dependency ranking is what lets a rescued course push before the
        // exams that have been failing on its foreign key.
        //
        // Runs against the PRE-merge local state on purpose: the merge only
        // adds remote rows, and local-only is precisely what we are looking
        // for. Cheap when there is nothing to do — two set builds and a walk.
        if (!cancelled) {
          const queued = reconcileUnsynced(stateRef.current, remote, outbox);
          if (queued) console.warn(`[StudyDesk] reconcile: re-queued ${queued} unsynced row(s)`);
        }
      } catch (e) {
        console.error("[StudyDesk] pull failed:", e);
      } finally {
        // v1.7 — arm the push reconciler on SETTLE, not on success. If the pull
        // failed we still want later local edits to sync; blocking on a healthy
        // pull would mean one flaky launch silently stops pushing for the whole
        // session. LWW plus the outbox already handle a stale starting point.
        if (!cancelled) {
          pulledOnceRef.current = true;
          setPulledOnce(true);
        }
      }
    };
    // StudyDesk#72 — the launch pull used to be the only one. Realtime was
    // meant to cover the rest, and its channel has delivered nothing since
    // v1.7 (Limekana/limecore#24), so an open tab or a resumed app showed the
    // data it launched with until it was restarted. Coming back to the window
    // now pulls, throttled, since that is when a user looks for the change
    // they just made on their other device.
    requestPullRef.current = () => {
      if (cancelled || !shouldPull(lastPullAt, Date.now())) return;
      void doPull();
    };
    doPull();
    sync.startRealtime(doPull, session.user?.id);
    return () => { cancelled = true; requestPullRef.current = null; sync.stopRealtime(); };
  // Only re-subscribe when the signed-in user id changes — not on every
  // session refresh (token refresh shouldn't tear down Realtime).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // ── Save-session sheet (raised when timer's focus phase ends) ───────────────
  const [pendingSession, setPendingSession] = useState(null); // { durationMinutes, task, startedAt } | null
  // v1.3 — sub-tab within the Timer view (Timer / Log / Stats), so Log + Stats
  // don't need their own bottom-bar slots.
  const [timerSub, setTimerSub] = useState("timer");
  // v1.9 Item 14a — sub-tab within Plan (List / Calendar), same shape as the
  // Timer hub above rather than a fifth bottom tab: the four-tab bar was sized
  // and tuned in v1.9 Item 6 against the longest label the app ships, and a
  // fifth slot would undo that on a 360px screen.
  //
  // `null` means "follow the tier" — the calendar is the point of a wide
  // screen, and the list is the better read on a phone. Once the user picks
  // one, their choice wins at every width. Same 'auto until you touch it'
  // semantics as the sidebar rail, so the two preferences behave alike.
  const [planSubPref, setPlanSubPref] = useState(() => {
    try {
      const v = localStorage.getItem("studydesk-plan-sub");
      // v1.10 adds "timetable". An unrecognised value falls back to null (=
      // follow the tier) rather than being written through, so a downgrade
      // leaves a working screen instead of an empty sub-tab.
      return v === "list" || v === "calendar" || v === "timetable" ? v : null;
    } catch { return null; }
  });
  // v1.9 Item 14a — Grades / Trends. Not tier-defaulted like the Plan sub-tab:
  // the grade list is the answer to "what did I get", which is what this screen
  // is opened for at every width; Trends is the follow-up question.
  const [gradesSub, setGradesSub] = useState("grades");
  const choosePlanSub = useCallback((v) => {
    try { localStorage.setItem("studydesk-plan-sub", v); } catch { /* private mode */ }
    setPlanSubPref(v);
  }, []);
  // Stale persisted nav: pre-v1.3 builds could have state.view === "log"/"stats"
  // (now removed as top-level views). Re-home them into the Timer hub so the
  // routed area never renders blank after upgrading.
  useEffect(() => {
    if (state.view === "log" || state.view === "stats") {
      setTimerSub(state.view);
      dispatch({ type: "SET_VIEW", view: "timer" });
    }
  }, [state.view]);

  useCloudPushers({ session, state, pulledOnceRef, remoteStampsRef, showFlash, t });

  // NOTE: the sign-out handler lives in SettingsView.onSignOut (identical logic
  // incl. the guestMode=true anti-auto-re-sign-in fix). An earlier duplicate
  // copy here was dead (never wired to a control) and was removed in the v1.7
  // audit to avoid two divergent sign-out paths.

  // v1.12 Item 0 — retention. Mount-only and deliberately independent of the
  // auth effect: the trigger is the app being foregrounded, not a session
  // arriving. Guests and same-day repeats are filtered inside recordAppOpen.
  useEffect(() => watchAppOpens(), []);

  // v1.12 Item 5 — supporter entitlement. Keyed on the user id rather than the
  // session object so a token refresh does not re-ask; `refreshEntitlement`
  // additionally serves from cache for six hours, so this is close to free on
  // an ordinary launch. A network failure keeps whatever was cached — losing a
  // supporter's perk because their train went into a tunnel is the wrong
  // failure mode, and the module is written that way deliberately.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    void refreshEntitlement(uid);
  }, [session?.user?.id]);

  // #26 — Android back button: dismiss modals first, then navigate home, then exit
  useEffect(() => {
    const handler = CapApp.addListener("backButton", () => {
      if (showAddCourse||showAddAsgn||showAddExam||editingCourse) {
        setShowAddCourse(false); setShowAddAsgn(false); setShowAddExam(false); setEditingCourse(null);
      } else if (state.view !== "actions") {
        dispatch({type:"SET_VIEW", view:"actions"});
      } else {
        CapApp.exitApp();
      }
    });
    return () => { handler.then(h=>h.remove()); };
  }, [showAddCourse,showAddAsgn,showAddExam,editingCourse,state.view]);
  const courses = Object.values(state.courses).filter(c => !c.deletedAt);
  const todayStr = fmtToday();
  const urgent = state.assignments.filter(a=>{ if(a.done) return false; const d=daysUntil(a.dueDate); return d!==null&&d<=0; });
  const urgentExams = state.exams.filter(e=>!e.done&&daysUntil(e.dueDate)!==null&&daysUntil(e.dueDate)<=3);
  const addCourse = () => {
    if(!newCourseName.trim()) return;
    const id = newSyncId();
    const name = newCourseName.trim();
    const color = newCourseColor;
    dispatch({type:"ADD_COURSE", id, name, color});
    // Advance to the next preset so adding several courses in a row gives each
    // a different colour — what the old index-based picker did with
    // setColorIdx(i => i + 1). A custom colour is not in the list, so indexOf
    // returns -1 and this lands on COURSE_COLORS[0]: a deliberate reset rather
    // than carrying a one-off colour into the next course.
    setNewCourseColor(COURSE_COLORS[(COURSE_COLORS.indexOf(color) + 1) % COURSE_COLORS.length]);
    setNewCourseName(""); setShowAddCourse(false); showFlash(t('av.flash.courseAdded'));
    if (session) outbox.enqueue("upsert_subject", { id, name, color });
  };

  // v1.9 (Item 14, Phase 1) — desktop shell. `tier` is phone/tablet/desktop;
  // `rail` is whether the sidebar is the 64px icon rail. Declared here rather
  // than lower down because the early returns below (auth gate, loading) must
  // not sit between a hook and its call site.
  const shellTier = useShellTier();
  const [rail, toggleRail] = useSidebarRail(shellTier);
  // v1.16 (limecore#16) — an error report says which view was open. StudyDesk
  // routes by reducer state, not URL, so the reporter is told directly.
  useEffect(() => { setReportScreen(state.view); }, [state.view]);

  // v1.15 (Item 12) — one update check per launch; a no-op off desktop. When
  // GitHub has something newer the sidebar says so; a click downloads it, then
  // "Restart to update" installs it. Nothing downloads until the user asks.
  const update = useDesktopUpdate();
  useEffect(() => { checkForDesktopUpdate(); }, []);
  const updateShown = ["available", "downloading", "ready"].includes(update.status);
  const updateLabel =
    update.status === "downloading" ? t("av.chrome.updateDownloading", { percent: update.percent })
    : update.status === "ready" ? t("av.chrome.updateReady")
    : t("av.chrome.updateShort");
  // Resolved here rather than stored, so a user who has never chosen follows
  // the tier as it changes (resizing a window, rotating a tablet) instead of
  // being pinned to whatever tier they first loaded at.
  const planSub = planSubPref ?? (shellTier === "desktop" ? "calendar" : "list");

  // v1.14 — where each first-step suggestion goes. It lives here because the
  // timetable is a SUB-TAB of Plan, and `SET_VIEW` alone would drop the user
  // on whichever Plan sub-tab they last used — usually the list, which is not
  // the thing the card just offered to show them. Routing knowledge stays in
  // the one file that already has it.
  const goFirstStep = useCallback((step) => {
    if (step === "timetable") { dispatch({type:"SET_VIEW",view:"plan"}); choosePlanSub("timetable"); return; }
    if (step === "session") { dispatch({type:"SET_VIEW",view:"timer"}); return; }
    if (step === "grade") dispatch({type:"SET_VIEW",view:"grades"});
  }, [dispatch, choosePlanSub]);

  // v1.9 (Item 6) — icons are back, but not the ones that were dropped.
  // SD-F2 removed a set of emoji/text glyphs in v1.6.0 because they were
  // inconsistent and crowded the label. These are lucide line icons at the
  // size and stroke weight LimeLog uses, which is the treatment the suite is
  // converging on. The labels stay: they carry the nav, the icon supports it.
  const views = [
    {id:"actions",  label:t('nav.study'),  Icon:NotebookPen},
    {id:"plan",     label:t('nav.plan'),   Icon:CalendarDays},
    // Award rather than a chart: Grades is where a result lands, and the
    // chart reading already belongs to the Stats sub-tab under Timer.
    {id:"grades",   label:t('nav.grades'), Icon:Award},
    // v1.3 — Timer now hosts Log + Stats as sub-tabs (see TimerView), so they
    // no longer take their own bottom-bar slots — keeps the nav uncrowded.
    {id:"timer",    label:t('nav.timer'),  Icon:Timer},
    // v1.13 Item 1b — Notebook. `railOnly` keeps it OUT of the mobile bottom
    // bar and in the desktop sidebar, which is a deliberate departure from
    // §10's "a nav entry for Notebook" and is worth stating plainly.
    //
    // The bottom bar is four tabs because v1.9 Item 6 sized it that way
    // against the longest label the app ships — Spanish "Temporizador", 12
    // characters, needing ~65px of the ~90px each tab gets on a 360px screen.
    // A fifth tab drops that to 72px and the longest label no longer fits.
    // The same constraint is why Log and Stats became Timer sub-tabs in v1.3
    // and why the Plan calendar became a sub-tab in v1.9, both documented in
    // this file — so this follows the app's own established answer rather
    // than inventing one.
    //
    // On mobile the notebook is a Timer sub-tab instead, which is where §3
    // wants it anyway: "one tap from a running timer, no search."
    {id:"notebook", label:t('nav.notebook'), Icon:BookOpen, railOnly:true},
    // v1.3.1 — Settings is no longer a nav tab; it opens from the top-right
    // profile avatar (matches NCC/LimeLog). Still a valid `state.view`.
  ];
  const activeView = views.find(v=>v.id===state.view);

  // Auth gate: show login UI until Supabase confirms a session.
  // (session === undefined while the initial getSession() call is in flight.)
  if (session === undefined) {
    return <><div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",fontFamily:"var(--font-mono)",fontSize:11,color:"var(--muted)",letterSpacing:"0.1em"}}>{t('av.chrome.loading')}</div></>;
  }
  // v1.1 — bypass AuthGate when the user opted into guest mode. The rest of
  // the app runs identically; cloud sync remains gated on `session` which is
  // still null, so realtime stays off and outbox enqueue calls are no-ops.
  if (session === null && !guest) {
    return <><AuthGate/></>;
  }
  // #52 — a recovery session must not become an ordinary signed-in session
  // until a new password has actually been set. This sits AFTER the gate (there
  // is nothing to set a password on without a session) and BEFORE everything
  // else, because letting the app open here is the whole defect: the user is
  // signed in on this device and still locked out of the next one.
  if (session && recoveryPending) {
    return <><SetPasswordScreen/></>;
  }

  return (<>
    
    {!onboarded && onboardChecked && (
      <Suspense fallback={null}><OnboardingView onComplete={handleOnboardingComplete}/></Suspense>
    )}
    {onboarded && (
      <div className={"app"+(rail?" is-rail":"")} data-tier={shellTier}>
      {/* ── Desktop sidebar ──
          v1.9 Item 14: `.rail-hide` marks everything that has no room in the
          64px icon rail. `aria-label` is unconditional — when railed the label
          text is display:none and would otherwise take the accessible name
          with it — while `title` is added only when railed, since a tooltip
          repeating a label you can already read is just noise. */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo-wrap">
            <img src="/logo.png" alt="StudyDesk" className="sidebar-logo" />
            <div className="rail-hide">
              <div className="sidebar-wordmark">Studydesk</div>
              <div className="sidebar-sub">{t('av.chrome.subtitle')}</div>
            </div>
          </div>
        </div>
        <nav className="sidebar-nav">
          {views.map(v=><div key={v.id} role="button" tabIndex={0} aria-label={v.label} title={rail?v.label:undefined} className={"nav-item"+(state.view===v.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:v.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
            {/* The sidebar tracks the mobile bar: it dropped glyphs with it in
                v1.6.0 and takes the lucide icons back with it now. `.nav-item`
                is already a horizontal flex row with a 10px gap, so the icon
                sits inline before the label rather than above it. */}
            <v.Icon size={16} strokeWidth={1.75} aria-hidden="true"/>
            <span className="rail-hide">{v.label}</span>
          </div>)}
        </nav>
        <div className="sidebar-courses">
          {courses.length>0&&<div className="courses-label rail-hide">{t('av.chrome.coursesLabel')}</div>}
          {courses.map(c=>{
            const open=state.assignments.filter(a=>a.courseId===c.id&&!a.done).length;
            const exams=state.exams.filter(e=>e.courseId===c.id&&!e.done).length;
            return <div key={c.id} role="button" tabIndex={0} aria-label={c.name} title={rail?c.name:undefined} className={"course-item"+(state.activeCourse===c.id?" active":"")} onClick={()=>dispatch({type:"SET_VIEW",view:"status",course:c.id})} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:"status",course:c.id})}>
              {/* The count survives into the rail — an unread-style badge is
                  the one thing on this row that still reads at 64px. The name
                  and the edit affordance do not, so they go. */}
              <div className="course-pip" style={{background:c.color}}/><span className="course-name rail-hide">{c.name}</span>
              {(open+exams)>0&&<span className="course-count">{open+exams}</span>}
              <span className="course-edit-btn rail-hide" onClick={e=>{e.stopPropagation();setEditingCourse({id:c.id,name:c.name,color:c.color});}} title={t('av.pl.edit')}>✎</span>
            </div>;
          })}
          <div className="add-course-btn" role="button" tabIndex={0} aria-label={t('av.chrome.addCourse')} title={rail?t('av.chrome.addCourse'):undefined} onClick={()=>setShowAddCourse(true)} onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&setShowAddCourse(true)}><span style={{fontSize:16}}>+</span> <span className="rail-hide">{t('av.chrome.addCourse')}</span></div>
        </div>
        <div className="sidebar-foot">
          {updateShown && (
            <button type="button" className="rail-toggle update-notice" onClick={runDesktopUpdateAction}
              disabled={update.status === "downloading"}
              aria-label={`${updateLabel} · v${update.latest}`} title={`${updateLabel} · v${update.latest}`}>
              <span className="update-notice-dot" aria-hidden="true"/>
              <span className="rail-hide">{updateLabel}</span>
              <span className="rail-hide update-notice-ver">v{update.latest}</span>
              {update.status === "downloading" && (
                <span className="update-notice-bar" style={{ width: `${update.percent}%` }} aria-hidden="true"/>
              )}
            </button>
          )}
          <button type="button" className="rail-toggle" onClick={toggleRail}
            aria-expanded={!rail}
            aria-label={rail?t('av.chrome.expandSidebar'):t('av.chrome.collapseSidebar')}
            title={rail?t('av.chrome.expandSidebar'):t('av.chrome.collapseSidebar')}>
            {rail
              ? <PanelLeftOpen size={16} strokeWidth={1.75} aria-hidden="true"/>
              : <PanelLeftClose size={16} strokeWidth={1.75} aria-hidden="true"/>}
            <span className="rail-hide">{t('av.chrome.collapseSidebar')}</span>
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="main">
        <div className="topbar">
          {/* v1.9 Item 14 — the inner wrapper carries the gutter and shares
              `.content`'s max-width, so the title stays aligned with the column
              it labels instead of drifting to the window edge on wide screens. */}
          <div className="topbar-inner">
          {/* `status` has no entry in `views` (it is reached by picking a course,
              not from the nav), so it fell through to `undefined` here — the
              visible half of the dead-route bug fixed below. It names the
              course, which is what the pane is showing. */}
          <h1 className="topbar-title">{
            state.view==="actions" ? t('topbar.nextUp')
            : state.view==="status" ? (state.courses[state.activeCourse]?.name || t('nav.plan'))
            : activeView?.label
          }</h1>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            {/* v1.12 Item 8e — a running block is visible from every route.
                Hidden on the timer screen itself: pointing at the page you are
                already on is the one in-app double-up worth avoiding. */}
            <TimerPill
              hidden={state.view==="timer"}
              onOpen={()=>dispatch({type:"SET_VIEW",view:"timer"})}
            />
            <div className="topbar-date">{todayStr}</div>
            {/* v1.3.1 — profile avatar opens Settings (matches NCC/LimeLog).
                Sign in / sign out now live inside Settings. Guests show "·". */}
            <button
              className={"topbar-avatar"+(state.view==="settings"?" active":"")}
              style={state.view==="settings"?undefined:accountAvatar.tintStyle}
              onClick={()=>dispatch({type:"SET_VIEW",view:"settings"})}
              /* v1.14 Item 12 — the name the user chose, when they have chosen
                 one; the address only as the fallback it always was. */
              title={(accountAvatar.displayName || session?.user?.email)
                ? t('av.chrome.settingsWith', { who: accountAvatar.displayName || session.user.email })
                : t('av.chrome.settings')}
              aria-label={t('av.chrome.openSettings')}>
              <AccountAvatar avatar={accountAvatar} session={session} />
            </button>
          </div>
          </div>
        </div>
        {/* v1.9 Item 14a — `.content-wide` (added in Phase 1 as the documented
            opt-out) is claimed by the two surfaces that genuinely want the
            shell width rather than a reading measure: the calendar sheet and
            the multi-pane course detail. Everything else keeps the measure. */}
        <div className={"content"+(((state.view==="plan"&&(planSub==="calendar"||planSub==="timetable"))||state.view==="status")?" content-wide":"")}>
          {/* v1.13 Item 1a — renders nothing unless a critical local write has
              failed. Inside `.content` so it appears on every route: the
              window in which the data still exists in memory is the only
              window in which the user can save it, and they will not
              necessarily be on Settings when it opens. */}
          <StorageAlert onExport={onExportFromAlert} />
          {/* v1.16 (#67) — Android only, once a day, off in Settings. Renders
              nothing unless F-Droid has a newer build than this one. */}
          <FdroidUpdateNote />
          {(urgent.length>0||urgentExams.length>0)&&state.view==="plan"&&(
            <div className="urgent-banner"><span>⚠️</span><div>
              <strong>{t('av.chrome.urgent')}</strong> —{" "}
              {urgentExams.map((e,i)=><span key={e.id} style={{color:"var(--exam)"}}>{t('av.chrome.examPrefix',{title:e.title})}{i<urgentExams.length-1?", ":""}</span>)}
              {urgent.length>0&&urgentExams.length>0&&", "}
              {urgent.map((a,i)=><span key={a.id}>{a.title}{i<urgent.length-1?", ":""}</span>)}
            </div></div>
          )}
          {/* v1.15 Item 2 — the phone had no equivalent of the sidebar's course
              list; its only copy sat at the bottom of Plan, under Assignments
              and Exams. Shown on Plan's list and on course detail, which is
              where it leads. Tapping the course already open goes back to Plan,
              so a course page is never a dead end on a phone. Hidden above the
              phone tier by CSS, where the sidebar does this job. */}
          {((state.view==="plan"&&planSub==="list")||state.view==="status")&&(
            <div className="mobile-courses-bar">
              <div className="mobile-courses-scroll" role="group" aria-label={t('av.chrome.coursesLabel')}>
                {courses.map(c=>{
                  const on=state.view==="status"&&state.activeCourse===c.id;
                  return <button key={c.id} type="button" className={"mobile-course-chip"+(on?" active":"")} aria-pressed={on}
                    onClick={()=>dispatch(on?{type:"SET_VIEW",view:"plan"}:{type:"SET_VIEW",view:"status",course:c.id})}>
                    <span className="mobile-course-dot" style={{background:c.color}} aria-hidden="true"/>{c.name}
                  </button>;
                })}
                <button type="button" className="mobile-course-add" onClick={()=>setShowAddCourse(true)}>+ {t('av.chrome.addCourse')}</button>
              </div>
            </div>
          )}
          {/* v1.3 — keyed wrapper triggers the page-turn cross-fade on view switch.
              The urgent banner above stays sticky (lives outside the wrapper), so
              only the routed view animates. */}
          <div className="page-turn" key={state.view}>
          {/* v1.17 (limecore#13) — the feature views are lazy chunks. Nothing
              is shown while one loads (a frame or two from local assets); the
              header, rail and tab bar stay put because they are outside. The
              sub-tab panels have their own boundaries so their tab rows stay
              put as well. */}
          <Suspense fallback={null}>
          {state.view==="plan"   &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label={t('cal.viewMode')}>
                {/* Timetable is a third sub-tab rather than a fifth bottom tab,
                    for the reason the calendar was: Item 6 sized that bar
                    against the longest label the app ships, and the recurring
                    skeleton of the week belongs beside the plan it shapes. */}
                {[["list","cal.planList"],["calendar","cal.planCalendar"],["timetable","tt.tab"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={planSub===id}
                    className={"timer-subtab"+(planSub===id?" active":"")}
                    onClick={()=>choosePlanSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={planSub}>
                <Suspense fallback={null}>
                {planSub==="calendar" &&
                  <CalendarView state={state} dispatch={dispatch} session={session} showFlash={showFlash} tier={shellTier} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)}/>}
                {planSub==="timetable" &&
                  <TimetableView state={state} dispatch={dispatch} session={session} showFlash={showFlash}/>}
                {planSub==="list" &&
                  <PlanView state={state} dispatch={dispatch} session={session} showFlash={showFlash} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)} onAddCourse={()=>setShowAddCourse(true)} onEditCourse={(c)=>setEditingCourse(c)} onOpenCalendar={()=>choosePlanSub("calendar")}/>}
                </Suspense>
              </div>
            </>
          )}
          {/* v1.9 Item 14a — `status` was a DEAD ROUTE: clicking a course in the
              desktop sidebar has always dispatched view:"status", and nothing
              rendered it, so the content area went blank and the topbar title
              read `undefined`. StatusView existed but was never mounted. It is
              the course-detail pane of the three-pane layout, so it lands here
              rather than being patched out of the sidebar. */}
          {state.view==="status" &&<CourseDetailView state={state} dispatch={dispatch} session={session} showFlash={showFlash} tier={shellTier} onAddAsgn={()=>setShowAddAsgn(true)} onAddExam={()=>setShowAddExam(true)} onEditCourse={(c)=>setEditingCourse(c)}/>}
          {state.view==="actions" &&<ActionsView state={state} dispatch={dispatch} showFlash={showFlash} onAddCourse={()=>setShowAddCourse(true)} onFirstStep={goFirstStep}/>}
          {/* v1.9 Item 14a — Grades gains a Trends sub-tab. The analytics read
              grades AND study sessions together, and "how am I doing" is the
              question this screen already answers, so it belongs here rather
              than as a sixth destination in a four-tab bar. */}
          {state.view==="grades"  &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label={t('nav.grades')}>
                {[["grades","nav.grades"],["trends","an.trends"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={gradesSub===id}
                    className={"timer-subtab"+(gradesSub===id?" active":"")}
                    onClick={()=>setGradesSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={gradesSub}>
                <Suspense fallback={null}>
                {gradesSub==="trends"
                  ? <AnalyticsView state={state}/>
                  : <GradesView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
                </Suspense>
              </div>
            </>
          )}
          {state.view==="timer"   &&(
            <>
              <div className="timer-subtabs" role="tablist" aria-label="Timer sections">
                {[["timer","av.tm.timerTab"],["notes","nav.notebook"],["log","av.tm.logTab"],["stats","av.tm.statsTab"]].map(([id,key])=>(
                  <button key={id} type="button" role="tab" aria-selected={timerSub===id}
                    className={"timer-subtab"+(timerSub===id?" active":"")}
                    onClick={()=>setTimerSub(id)}>{t(key)}</button>
                ))}
              </div>
              <div className="page-turn" key={timerSub}>
                <Suspense fallback={null}>
                {timerSub==="timer" &&<TimerView   state={state} dispatch={dispatch} session={session} showFlash={showFlash} onTimerComplete={(payload)=>setPendingSession(payload)}/>}
                {timerSub==="log"   &&<SessionsView state={state} dispatch={dispatch} showFlash={showFlash} session={session} onLogPast={()=>setPendingSession(pastSessionDraft())}/>}
                {timerSub==="stats" &&<StatsView    state={state}/>}
                {/* The mobile home for the notebook. Same component as the
                    desktop route below — one implementation, two entry
                    points, so the two cannot drift. */}
                {timerSub==="notes" &&<NotebookView state={state} dispatch={dispatch} onDeleteNote={onDeleteNote} onOpenTimer={()=>setTimerSub("timer")}/>}
                </Suspense>
              </div>
            </>
          )}
          {state.view==="notebook"&&(
            <NotebookView
              state={state}
              dispatch={dispatch}
              onDeleteNote={onDeleteNote}
              onOpenTimer={()=>{ setTimerSub("timer"); dispatch({type:"SET_VIEW",view:"timer"}); }}
            />
          )}
          {state.view==="settings"&&<SettingsView state={state} dispatch={dispatch} showFlash={showFlash} session={session}/>}
          </Suspense>
          </div>
        </div>
      </main>

      {/* ── Mobile: collapsible course strip + bottom tab bar ── */}
      <nav className="mobile-tabbar">
        {/* `status` has no tab of its own; on a phone it is reached from Plan's
            course strip (v1.15 Item 2), so Plan stays lit there. */}
        {views.filter(v=>!v.railOnly).map(v=><div key={v.id} role="button" tabIndex={0} className={"mobile-tab"+((state.view===v.id||(v.id==="plan"&&state.view==="status"))?" active":"")}
          onClick={()=>dispatch({type:"SET_VIEW",view:v.id})}
          onKeyDown={e=>(e.key==="Enter"||e.key===" ")&&dispatch({type:"SET_VIEW",view:v.id})}>
          <v.Icon size={20} strokeWidth={1.75} aria-hidden="true"/>
          <span className="mobile-tab-label">{v.label}</span>
        </div>)}
      </nav>
      </div>
    )}

    {/* ── Modals ── */}
    {showAddCourse&&<div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t('av.md.addCourse')} onClick={()=>setShowAddCourse(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
      <div className="modal-title">{t('av.md.addCourse')}</div>
      <div className="input-group"><div className="input-label">{t('course.name')}</div><input type="text" placeholder={t('course.namePlaceholder')} value={newCourseName} onChange={e=>setNewCourseName(e.target.value)} {...enterSubmit(addCourse)} autoFocus/></div>
      <div style={{marginBottom:16}}><CoursePicker value={newCourseColor} onChange={setNewCourseColor}/></div>
      <div style={{display:"flex",gap:8}}><button className="btn" onClick={addCourse}>{t('av.chrome.addCourse')}</button><button className="btn-outline" onClick={()=>setShowAddCourse(false)}>{t('common.cancel')}</button></div>
    </div></div>}
    {showAddAsgn&&<AddAsgnModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_ASSIGNMENT",title:data.title,courseId:data.courseId,assignType:data.type,dueDate:data.dueDate,dueTime:data.dueTime,notes:data.notes});setShowAddAsgn(false);showFlash(t('av.flash.assignmentAdded'));}} onClose={()=>setShowAddAsgn(false)}/>}
    {showAddExam&&<AddExamModal courses={courses} activeCourse={state.activeCourse} onAdd={(data)=>{dispatch({type:"ADD_EXAM",...data});setShowAddExam(false);showFlash(t('av.flash.examAdded'));}} onClose={()=>setShowAddExam(false)}/>}
    {editingCourse&&<EditCourseModal
      course={state.courses[editingCourse.id] || editingCourse}
      courses={state.courses}
      onSave={(name,color,credits,semester,schoolYear)=>{
        dispatch({type:"EDIT_COURSE",id:editingCourse.id,name,color,credits,semester,schoolYear});
        setEditingCourse(null); showFlash(t('av.flash.courseUpdated'));
        if (session) outbox.enqueue("upsert_subject", { id:editingCourse.id, name, credits, semester, schoolYear, color });
      }}
      onDelete={()=>{
        const id=editingCourse.id;
        dispatch({type:"DELETE_COURSE",id});
        setEditingCourse(null); showFlash(t('av.flash.courseDeleted'));
        if (session) outbox.enqueue("delete_subject", { id });
      }}
      onClose={()=>setEditingCourse(null)}/>}
    {pendingSession && (
      <SaveSessionSheet
        pending={pendingSession}
        courses={courses}
        canDebrief={!!session && state.aiEnabled}
        onClose={()=>setPendingSession(null)}
        onSave={async ({subjectId, durationMinutes, notes, startedAt, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary}) => {
          const id = newSyncId();
          dispatch({type:"ADD_SESSION", id, subjectId: subjectId||null, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary});
          setPendingSession(null);
          showFlash(t('av.flash.logged', { n: durationMinutes }));
          if (session) outbox.enqueue("log_session", { id, subjectId, startedAt, durationMinutes, notes, focusRating, aiDebriefRaw, aiSubjectCovered, aiComprehension, aiConfusionFlags, aiSessionSummary });
        }}
      />
    )}
    {flash&&<div className="flash">{flash}</div>}
    {/* Item 8 — asks once per account, only inside the account-age window,
        and only once onboarding is out of the way. Guests have no auth
        metadata to write to, so `session?.user` is the whole gate. */}
    {onboarded && session?.user && <ReferralPrompt user={session.user}/>}
    {/* v1.16 (limecore#16) — once, for people who used StudyDesk under the
        old policy; pinned to the top edge, clear of the referral corner. */}
    {onboarded && <PolicyUpdatedNote/>}
  </>);
}

import { useState, useEffect, useCallback, useReducer, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { fmtToday, formatLocale } from "./lib/dates.js";
import { pushWidgetSnapshot, consumeWidgetLaunchView, onWidgetNavigate } from "./lib/widgetBridge.js";
import { WIDGET_PALETTE_EVENT } from "./lib/theme.js";
import { LocalNotifications } from "@capacitor/local-notifications";
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
import { writeJson } from "./lib/localStore.js";
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
import { stampsFromPull, isInSync, isRemoteTombstone, shouldPull } from "./lib/syncStamps.js";
import SaveSessionSheet from "./features/sessions/SaveSessionSheet.jsx";
import { pastSessionDraft } from "./lib/pastSession.js";
import "./styles/notebook.css";
import { isGradeMode, normalizeScale, DEFAULT_CUSTOM_SCALE } from "./lib/gradeScale.js";
import CoursePicker from "./lib/CoursePicker.jsx";
import { AddAsgnModal, AddExamModal, EditCourseModal } from "./features/plan/CourseModals.jsx";
import CourseDetailView from "./features/plan/CourseDetailView.jsx";
import PlanView from "./features/plan/PlanView.jsx";
import ActionsView from "./features/actions/ActionsView.jsx";
import { daysUntil } from "./lib/deadlines.js";
import { ACTION_DONE_ID, cancelAllNotifications, scheduleNotifications } from "./lib/planNotifications.js";
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
import { startPlanReminderLoop, webNotifySupported } from "./lib/webNotify.js";
import { enterSubmit } from "./lib/imeSubmit.js";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, INITIAL, (init) => {
    try {
      const raw = localStorage.getItem("studydesk-v1");
      const saved = raw ? JSON.parse(raw) : {};
      // Normalize legacy course rows that pre-date credits/semester/timestamps.
      // v1.2 adds archivedAt — defaults to null (active) on rehydration.
      // Guard each field's shape independently so a single malformed field
      // (e.g. a non-array `assignments` from a partial write) falls back to
      // empty for THAT field only — never throwing out to the catch, which
      // would blank ALL local data and let the persist effect overwrite it.
      const savedCourses = saved.courses && typeof saved.courses === "object" ? saved.courses : {};
      const courses = {};
      for (const [id, c] of Object.entries(savedCourses)) {
        courses[id] = {
          notes: [],
          credits: 1,
          semester: null,
          schoolYear: null,
          updatedAt: null,
          deletedAt: null,
          archivedAt: null,
          ...c,
        };
      }
      const gradeMode = (() => {
        try {
          const raw = localStorage.getItem("studydesk-grade-mode");
          return isGradeMode(raw) ? raw : "ib";
        } catch { return "ib"; }
      })();
      const customScale = (() => {
        try {
          const raw = localStorage.getItem("studydesk-grade-scale");
          return raw ? normalizeScale(JSON.parse(raw)) : DEFAULT_CUSTOM_SCALE;
        } catch { return DEFAULT_CUSTOM_SCALE; }
      })();
      // Absent key reads as false, so every existing install starts opted out
      // rather than inheriting an "on" it was never asked about.
      const aiEnabled = (() => {
        try { return localStorage.getItem("studydesk-ai-enabled") === "1"; } catch { return false; }
      })();
      // Lock In's native extras. The chip's key is absent for everyone who
      // installed before v1.10, and absent must mean ON there — it is the
      // half of the feature the owner actually asked for. Pinning's absent
      // key means OFF, because nobody consents to being locked in by default.
      const focusChip = (() => {
        try { return localStorage.getItem("studydesk-focus-chip") !== "0"; } catch { return true; }
      })();
      const focusPin = (() => {
        try { return localStorage.getItem("studydesk-focus-pin") === "1"; } catch { return false; }
      })();
      // Study-until. Absent means the default is in force, which is the right
      // reading for every install that predates the setting — the evening was
      // never deliberately excluded, it just fell off the end of the window.
      // An explicit "off" is the only thing that disables it.
      const studyUntil = (() => {
        try {
          const raw = localStorage.getItem("studydesk-study-until");
          if (raw === null) return 21*60;
          if (raw === "off") return null;
          const n = Number(raw);
          return Number.isFinite(n) ? Math.max(0, Math.min(24*60, Math.round(n))) : 21*60;
        } catch { return 21*60; }
      })();
      // Planned-session reminders. Absent keys mean the defaults, which is the
      // right reading for an install that predates the feature — nobody there
      // declined it, it did not exist.
      const planRemindLead = (() => {
        try {
          const raw = localStorage.getItem("studydesk-plan-lead");
          if (raw === null) return 30;
          if (raw === "off") return null;
          const n = Number(raw);
          return Number.isFinite(n) ? Math.max(1, Math.min(24*60, Math.round(n))) : 30;
        } catch { return 30; }
      })();
      const planRemindStart = (() => {
        try { return localStorage.getItem("studydesk-plan-start") !== "0"; } catch { return true; }
      })();
      // Reminders. The key is absent for everyone who onboarded before this
      // preference existed, and those users have already been through the
      // permission prompt — so absent-but-onboarded means keep scheduling, and
      // only an explicit "Maybe later" writes a "0". A blanket default of false
      // would silently stop reminders for every existing install.
      const notifEnabled = (() => {
        try {
          const raw = localStorage.getItem("studydesk-notifications");
          if (raw !== null) return raw === "1";
          return localStorage.getItem("studydesk-onboarded") === "1";
        } catch { return true; }
      })();

      // ── v1.0.4 UUID migration ────────────────────────────────────────────────
      // Earlier versions used short uid() strings for IDs. Supabase columns are
      // `uuid` type and reject them ("invalid input syntax for type uuid: ...").
      // This pass detects non-UUID local IDs and rewrites them — keeping all
      // cross-references intact (grade.subjectId, session.subjectId,
      // assignment.courseId, exam.courseId, action.courseId, activeCourse).
      // Marks `studydesk-needs-initial-push` so the App runs a one-shot push
      // of the migrated rows after auth lands.
      let needsPush = localStorage.getItem("studydesk-needs-initial-push") === "1";
      const subjectIdMap = {};
      const migratedCourses = {};
      for (const [oldId, c] of Object.entries(courses)) {
        if (UUID_RE.test(oldId)) {
          migratedCourses[oldId] = c;
          subjectIdMap[oldId] = oldId;
        } else {
          const newId = crypto.randomUUID();
          subjectIdMap[oldId] = newId;
          migratedCourses[newId] = { ...c, id: newId };
          needsPush = true;
        }
      }
      const migratedGrades = (Array.isArray(saved.grades) ? saved.grades : []).map(g => {
        const idOk = UUID_RE.test(g.id);
        const subjIdMapped = subjectIdMap[g.subjectId];
        const subjOk = !subjIdMapped || subjIdMapped === g.subjectId;
        if (idOk && subjOk) return g;
        needsPush = true;
        return {
          ...g,
          id: idOk ? g.id : crypto.randomUUID(),
          subjectId: subjIdMapped || g.subjectId,
        };
      });
      const migratedSessions = (Array.isArray(saved.studySessions) ? saved.studySessions : []).map(s => {
        const idOk = UUID_RE.test(s.id);
        const subjIdMapped = s.subjectId ? subjectIdMap[s.subjectId] : null;
        const subjOk = !s.subjectId || subjIdMapped === s.subjectId;
        if (idOk && subjOk) return s;
        needsPush = true;
        return {
          ...s,
          id: idOk ? s.id : crypto.randomUUID(),
          subjectId: s.subjectId ? (subjIdMapped || s.subjectId) : null,
        };
      });
      // ── v1.7 assignment/exam/action UUID migration (StudyDesk#6) ────────────
      // These were local-only until v1.7 and used short uid() ids, which the
      // new `uuid` columns reject outright. Re-key them here, exactly as the
      // v1.0.4 pass above did for courses/grades/sessions, and mark the batch
      // for the one-shot push so a user's existing homework reaches the cloud
      // rather than only newly created items.
      //
      // asgnIdMap/examIdMap are kept because manual actions can carry a
      // sourceId pointing at an assignment or exam. Re-keying the target
      // without remapping the reference would silently break "mark done" on
      // the suggested-action row.
      const asgnIdMap = {};
      const examIdMap = {};
      const migratedAssignments = (Array.isArray(saved.assignments) ? saved.assignments : []).map(a => {
        const idOk = UUID_RE.test(a.id);
        const mappedCourse = subjectIdMap[a.courseId];
        const courseOk = !mappedCourse || mappedCourse === a.courseId;
        if (!idOk) asgnIdMap[a.id] = crypto.randomUUID();
        if (idOk && courseOk) return a;
        needsPush = true;
        return {
          ...a,
          id: idOk ? a.id : asgnIdMap[a.id],
          courseId: mappedCourse || a.courseId,
        };
      });
      const migratedExams = (Array.isArray(saved.exams) ? saved.exams : []).map(e => {
        const idOk = UUID_RE.test(e.id);
        const mappedCourse = subjectIdMap[e.courseId];
        const courseOk = !mappedCourse || mappedCourse === e.courseId;
        if (!idOk) examIdMap[e.id] = crypto.randomUUID();
        if (idOk && courseOk) return e;
        needsPush = true;
        return {
          ...e,
          id: idOk ? e.id : examIdMap[e.id],
          courseId: mappedCourse || e.courseId,
        };
      });
      const migratedActions = (Array.isArray(saved.actions) ? saved.actions : []).map(a => {
        const idOk = UUID_RE.test(a.id);
        const mappedCourse = a.courseId ? subjectIdMap[a.courseId] : null;
        const courseOk = !a.courseId || mappedCourse === a.courseId;
        const mappedSource = a.sourceId ? (asgnIdMap[a.sourceId] || examIdMap[a.sourceId]) : null;
        if (idOk && courseOk && !mappedSource) return a;
        needsPush = true;
        return {
          ...a,
          id: idOk ? a.id : crypto.randomUUID(),
          courseId: a.courseId ? (mappedCourse || a.courseId) : null,
          sourceId: mappedSource || a.sourceId || null,
        };
      });
      const migratedActiveCourse = saved.activeCourse && subjectIdMap[saved.activeCourse]
        ? subjectIdMap[saved.activeCourse]
        : saved.activeCourse || null;

      if (needsPush) {
        try { localStorage.setItem("studydesk-needs-initial-push", "1"); } catch {}
      }

      return {
        ...init,
        ...saved,
        courses: migratedCourses,
        assignments: migratedAssignments,
        exams: migratedExams,
        actions: migratedActions,
        grades: migratedGrades,
        studySessions: migratedSessions,
        // v1.10. No UUID migration pass for these four: they were born after
        // v1.0.4, so every id they have ever held came from crypto.randomUUID.
        // Shape-guarded individually for the same reason as the lists above —
        // one malformed array must not blank the others.
        plannedSessions: Array.isArray(saved.plannedSessions) ? saved.plannedSessions : [],
        academicTerms: Array.isArray(saved.academicTerms) ? saved.academicTerms : [],
        timetableEntries: Array.isArray(saved.timetableEntries) ? saved.timetableEntries : [],
        attachments: Array.isArray(saved.attachments) ? saved.attachments : [],
        commitments: Array.isArray(saved.commitments) ? saved.commitments : [],
        notes: Array.isArray(saved.notes) ? saved.notes : [],
        noteAttachments: Array.isArray(saved.noteAttachments) ? saved.noteAttachments : [],
        attendance: Array.isArray(saved.attendance) ? saved.attendance : [],
        activeCourse: migratedActiveCourse,
        gradeMode,
        customScale,
        aiEnabled,
        notifEnabled,
        focusChip,
        focusPin,
        studyUntil,
        planRemindLead,
        planRemindStart,
        view: "actions",
      };
    } catch { return init; }
  });
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
  // v1.13 Item 1a — THE five-hours bug.
  //
  // This write is the app's database, and until now it was
  // `try { ... } catch {}`. When it failed the app carried on with in-memory
  // state that would not survive the next cold start: the user kept studying,
  // the timer kept logging, and everything since the last successful write
  // vanished at relaunch. Offline, none of it had reached the server either,
  // so it was gone from every device — which is the report verbatim.
  //
  // `writeJson` marks this critical, so a failure raises the app-wide storage
  // health state that `StorageAlert` renders. See src/lib/localStore.js for
  // why an app update is not special here: it is simply the relaunch at which
  // the user finds out.
  useEffect(() => {
    writeJson("studydesk-v1", {
      courses:state.courses,
      assignments:state.assignments,
      actions:state.actions,
      exams:state.exams,
      grades:state.grades,
      studySessions:state.studySessions,
      plannedSessions:state.plannedSessions,
      academicTerms:state.academicTerms,
      timetableEntries:state.timetableEntries,
      attachments:state.attachments,
      commitments:state.commitments,
      notes:state.notes,
      noteAttachments:state.noteAttachments,
      attendance:state.attendance,
    }, { critical: true });
  }, [state.courses,state.assignments,state.actions,state.exams,state.grades,state.studySessions,state.plannedSessions,state.academicTerms,state.timetableEntries,state.attachments,state.commitments,state.notes,state.noteAttachments,state.attendance]);
  // gradeMode is UI-only — persist separately so it doesn't trigger a v1 rewrite on every toggle.
  useEffect(() => {
    try { localStorage.setItem("studydesk-grade-mode", state.gradeMode); } catch {}
  }, [state.gradeMode]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-grade-scale", JSON.stringify(state.customScale)); } catch {}
  }, [state.customScale]);
  // Same treatment for the AI opt-in: device-level, not synced academic data.
  useEffect(() => {
    try { localStorage.setItem("studydesk-ai-enabled", state.aiEnabled ? "1" : "0"); } catch {}
  }, [state.aiEnabled]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-focus-chip", state.focusChip ? "1" : "0"); } catch {}
  }, [state.focusChip]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-focus-pin", state.focusPin ? "1" : "0"); } catch {}
  }, [state.focusPin]);
  useEffect(() => {
    try { localStorage.setItem("studydesk-notifications", state.notifEnabled ? "1" : "0"); } catch {}
  }, [state.notifEnabled]);
  useEffect(() => {
    try {
      localStorage.setItem("studydesk-study-until", state.studyUntil === null ? "off" : String(state.studyUntil));
    } catch {}
  }, [state.studyUntil]);
  useEffect(() => {
    try {
      localStorage.setItem("studydesk-plan-lead", state.planRemindLead === null ? "off" : String(state.planRemindLead));
      localStorage.setItem("studydesk-plan-start", state.planRemindStart ? "1" : "0");
    } catch {}
  }, [state.planRemindLead, state.planRemindStart]);

  // Schedule notifications after onboarding with fresh state (#21 fix)
  // Reschedule notifications whenever exams or assignments change (not just onboarding)
  useEffect(() => {
    if (!onboarded) return;
    // notifEnabled is what makes "Maybe later" mean anything. Before this gate
    // both onboarding buttons ran the same path, so declining still reached
    // scheduleNotifications — which calls requestPermissions() and therefore
    // raised the very OS prompt the user had just declined.
    if (state.notifEnabled) {
      scheduleNotifications(
        state.exams, state.assignments, state.courses,
        state.plannedSessions,
        { lead: state.planRemindLead, atStart: state.planRemindStart },
        t,
      );
    } else {
      // Turning them off must also clear anything already scheduled, or
      // reminders keep arriving from a previous session's schedule.
      cancelAllNotifications();
    }
    // state.courses belongs here: notification bodies carry the course name, so
    // renaming a course left stale text scheduled until an exam or assignment
    // happened to change.
    // plannedSessions and both reminder prefs belong here for the same reason
    // state.courses does: the schedule is derived from them, so changing one
    // without rescheduling leaves the OS holding a stale set of alarms.
  }, [onboarded, state.notifEnabled, state.exams, state.assignments, state.courses,
      state.plannedSessions, state.planRemindLead, state.planRemindStart, t]);

  // ── Web reminders (v1.10) ────────────────────────────────────────────────
  //
  // Android gets OS alarms through LocalNotifications; the browser has no
  // equivalent, so on web the same two preferences are served by a polling
  // loop. See lib/webNotify.js for why it polls rather than setTimeout, and
  // for the honest limit: this fires while StudyDesk is OPEN in a tab, hidden
  // or minimised included, and cannot fire once the tab is closed.
  //
  // The loop reads through a ref so it is started once. Passing state directly
  // would rebuild it on every plan edit and every keystroke in Settings, which
  // resets the tick and drops whatever was about to fire.
  const webNotifyState = useRef(null);
  webNotifyState.current = {
    enabled: onboarded && state.notifEnabled,
    plans: state.plannedSessions,
    courses: state.courses,
    prefs: { lead: state.planRemindLead, atStart: state.planRemindStart },
    labels: {
      fallback: t('notif.planFallback'),
      now: t('notif.planNowTitle'),
      soon: (n) => t('notif.planSoonTitle', { n }),
    },
  };
  useEffect(() => {
    if (Capacitor.isNativePlatform() || !webNotifySupported()) return undefined;
    return startPlanReminderLoop(() => webNotifyState.current);
  }, []);

  // v1.9 (Item 8) — keep the home-screen widgets in step with the same data,
  // on the same triggers as the notifications above. Both answer "what's next"
  // from outside the app, so they should never be able to disagree.
  //
  // Not gated on notifEnabled: a widget the user chose to place on their home
  // screen is not a notification, and declining reminders is not declining it.
  // The push itself no-ops off Android and when no widget is placed.
  //
  // v1.15 — and on a palette change: the widgets follow the app's look (or
  // the Settings override), so switching to Dark has to reach the home screen
  // without waiting for the next assignment edit.
  const [widgetPaletteTick, setWidgetPaletteTick] = useState(0);
  useEffect(() => {
    const bump = () => setWidgetPaletteTick((n) => n + 1);
    window.addEventListener(WIDGET_PALETTE_EVENT, bump);
    return () => window.removeEventListener(WIDGET_PALETTE_EVENT, bump);
  }, []);
  useEffect(() => {
    void pushWidgetSnapshot({
      assignments: state.assignments,
      exams: state.exams,
      courses: state.courses,
      t,
      locale: formatLocale(),
    });
  }, [state.assignments, state.exams, state.courses, t, widgetPaletteTick]);

  // v1.10 — widget taps land where the widget was about.
  //
  // Shipped 1.7.0 gave both widgets the same bare "open MainActivity" intent,
  // so a tap dropped the user on whatever screen they last left the app on —
  // reported as "doesnt take me to the right place both just open the app".
  // Next Up now opens the Next Up view, Upcoming opens the plan view.
  //
  // Two paths because Android delivers the two cases differently: a cold start
  // is queued natively and collected here on mount, a tap while the app is
  // already running arrives as an event. See WidgetBridgePlugin.
  useEffect(() => {
    let cancelled = false;

    void consumeWidgetLaunchView().then((view) => {
      if (!cancelled && view) dispatch({ type: "SET_VIEW", view });
    });

    // Await the handle before removing it — the same StrictMode ordering trap
    // that double-registered the notification listener in v1.7.
    const handlePromise = onWidgetNavigate((view) => {
      dispatch({ type: "SET_VIEW", view });
    });

    return () => {
      cancelled = true;
      void handlePromise?.then((h) => h.remove()).catch(() => {});
    };
  }, []);

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

  // v1.3 — outbox drain triggers. The outbox holds pending Supabase writes
  // when the device is offline or a sync call failed; this effect re-runs
  // drain on three signals:
  //
  //   1. App cold-start (mount) — catches anything queued in a prior
  //      session that hadn't drained yet.
  //   2. `online` window event — fires when the OS detects network
  //      restoration. Capacitor surfaces this in the Android WebView.
  //   3. `visibilitychange` → visible — fires when the app comes back to
  //      the foreground after being backgrounded. Capacitor maps Android's
  //      onResume here. Useful when the device was online but the user
  //      was away long enough for a retry to make sense.
  //
  // drain() is single-flight inside the outbox (coalesces overlapping
  // calls) so firing it from all three paths is safe.
  //
  // StudyDesk#72 — the same signals now also pull, after the drain, so local
  // edits reach the server before the server's view is merged back. Window
  // `focus` joins them for the desktop edition, where switching between
  // windows never changes `visibilityState`. The pull is throttled inside
  // `requestPullRef` (syncStamps.js), so an alt-tab habit costs nothing.
  useEffect(() => {
    // One-shot on mount.
    void outbox.drain();
    const drainThenPull = () => {
      void Promise.resolve(outbox.drain())
        .catch(() => { /* drain reports its own failures */ })
        .then(() => requestPullRef.current?.());
    };
    function onOnline() { drainThenPull(); }
    function onVisibility() {
      if (document.visibilityState === 'visible') drainThenPull();
    }
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', drainThenPull);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', drainThenPull);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Listen for "Mark done" action-button taps on assignment reminders.
  // The handler dispatches TOGGLE_ASSIGNMENT — since reschedules filter out
  // assignments where done===true, the next scheduling pass naturally drops
  // any further reminders for the just-completed assignment. The reducer's
  // toggle (rather than a one-way mark-done) is fine here because Android
  // auto-dismisses the notification on action tap, so accidental
  // double-taps that would un-toggle aren't reachable.
  useEffect(() => {
    // Hold the listener PROMISE and remove via it. With the old
    // `let handle=null; (async)=>{handle=await add()}` pattern, React 19
    // StrictMode's mount→cleanup→mount runs cleanup before the await resolves
    // (handle still null → .remove() skipped), orphaning the first listener and
    // double-registering — so "Mark done" fired TOGGLE_ASSIGNMENT twice (net
    // no-op). The backButton listener below already uses this safe idiom.
    const handlePromise = LocalNotifications.addListener(
          "localNotificationActionPerformed",
          (event) => {
            // v1.3.1 BUG-14 — body-tap navigation. @capacitor/local-notifications
            // fires this same event for both the "Mark done" action button AND
            // a tap on the notification body itself (actionId === 'tap'). The
            // existing handler only acted on 'done'; body taps fell through and
            // the app opened on whatever screen it was last on instead of the
            // relevant assignments view. Route body taps to the plan view so
            // the user lands on the full assignment list — same target as the
            // ActionsView ("Next Up") would imply but "plan" surfaces all
            // upcoming work, which matches the tap intent better.
            if (event.actionId === "tap") {
              dispatch({ type: "SET_VIEW", view: "plan" });
              return;
            }
            if (event.actionId !== ACTION_DONE_ID) return;
            const assignmentId = event.notification?.extra?.assignmentId;
            if (!assignmentId) return;
            dispatch({ type: "TOGGLE_ASSIGNMENT", id: assignmentId });
          },
        );
    handlePromise.catch((e) => console.warn("[StudyDesk] action listener failed:", e));
    return () => { handlePromise.then((h) => h.remove()).catch(() => {}); };
  }, []);
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

  // v1.13 Item 1a — the escape hatch offered by StorageAlert.
  //
  // Reads from `state`, which is IN MEMORY and still correct, rather than
  // from localStorage, which is the thing that just failed. That is the whole
  // point of the button: it is the one action that does not depend on
  // anything currently broken. `downloadExport` builds a blob and hands it to
  // the browser, touching no persistent storage on the way.
  // ── v1.13 Item 1b — pushing note edits ──────────────────────────────────
  //
  // A note changes on every keystroke, so it CANNOT be enqueued the way an
  // assignment is. Enqueueing per change would put hundreds of items in a
  // queue that persists to localStorage on every write — which is the exact
  // pressure that Item 1a identifies as the cause of the five-hours loss.
  //
  // So: debounce, and enqueue at most one item per note per idle window. The
  // outbox de-duplicates nothing, but `upsert_note` carries the whole note as
  // a snapshot, so a later item simply supersedes an earlier one under LWW —
  // which makes a stale queued copy harmless rather than a lost edit.
  //
  // The 1500ms window matches the realtime pull's own coalescing constant, so
  // the two do not fight: an edit settles, pushes, and the echo arrives after
  // the queue has already drained it.
  const noteTimers = useRef(new Map());
  useEffect(() => {
    if (!session) return undefined;
    // StudyDesk#72 — wait for the first pull to settle, as the v1.7
    // reconciler already does. Until then this effect cannot tell a note the
    // user just edited from a stale local copy, and it used to push them all
    // 1.5s after sign-in stamped `now()`: on a connection slower than the
    // debounce, an out-of-date copy overwrote a newer edit made on another
    // device. `pulledOnce` flips on success AND failure, so an offline launch
    // still pushes, and an edit made in the gap is picked up when it flips.
    if (!pulledOnce) return undefined;
    const timers = noteTimers.current;
    for (const n of state.notes || []) {
      if (n.deletedAt) continue;
      const prev = timers.get(n.id);
      if (prev?.updatedAt === n.updatedAt) continue;
      if (prev?.handle) clearTimeout(prev.handle);
      // StudyDesk#72 — this note is exactly the copy the last pull returned:
      // either it arrived from another device or it is our own push coming
      // back with its push-time stamp. Record the baseline, push nothing.
      // Pushing it would stamp a newer `updated_at`, which the next pull
      // returns, which lands here again — a loop once per pull, and every ~3s
      // per note once realtime works (Limekana/limecore#24). Cancelling the
      // pending timer above is correct too: the server's copy is newer than
      // the payload it captured.
      if (isInSync("notes", n, remoteStampsRef.current)) {
        timers.set(n.id, { updatedAt: n.updatedAt, handle: 0, payload: null });
        continue;
      }
      // The payload is captured HERE, alongside the timer, so `flush` below
      // can push it without the note being in scope. Without it the flush had
      // nothing to send — see blocker 3 on that effect.
      const payload = {
        id: n.id,
        courseId: n.courseId,
        title: n.title,
        lessonDate: n.lessonDate,
        content: n.content,
        sessionId: n.sessionId,
        layout: n.layout ?? null,
        // v1.16 (limecore#27): the note's own edit time — the keystroke, not
        // the debounce firing 1.5 s later. The outbox stamps from it.
        updatedAt: n.updatedAt,
      };
      const handle = setTimeout(() => {
        outbox.enqueue("upsert_note", payload);
        const cur = timers.get(n.id);
        if (cur) timers.set(n.id, { ...cur, handle: 0 });
      }, 1500);
      timers.set(n.id, { updatedAt: n.updatedAt, handle, payload });
    }
    return undefined;
  }, [state.notes, session, pulledOnce]);

  // Flush pending note pushes on unmount and on backgrounding.
  //
  // ── This CANCELLED them instead (v1.13 review, blocker 3) ──────────────
  //
  // It cleared every timer and enqueued nothing, so the edit it was written
  // to rescue was the exact edit it destroyed: type a line, press Home inside
  // the 1.5s debounce, and the write never left the device. It fired on
  // unmount too, so merely navigating out of the notebook did the same.
  //
  // Nor was reconcile the safety net the old comment claimed. `findUnsynced`
  // compares IDS: once a note has been pushed even once it exists remotely,
  // so a later lost edit is invisible to it. The note then sits locally with
  // a newer `updatedAt` that no one ever sees, until another device's older
  // copy wins LWW and overwrites it.
  //
  // That is the five-hours bug, in the data the build plan calls the most
  // precious in the app. It now enqueues.
  useEffect(() => {
    const flush = () => {
      for (const [, rec] of noteTimers.current) {
        if (!rec.handle) continue;
        clearTimeout(rec.handle);
        // Cancel the timer and do its job immediately. `enqueue` coalesces on
        // the note id, so a flush racing a timer that already fired replaces
        // one pending item rather than queueing a second.
        if (rec.payload) outbox.enqueue("upsert_note", rec.payload);
      }
      noteTimers.current.clear();
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    // `pagehide` as well as `visibilitychange`. iOS WKWebView does not reliably
    // deliver `visibilitychange` when the OS terminates a backgrounded app, and
    // this flush is the last thing standing between a debounced note edit and
    // losing it. `pagehide` fires on that path, and flushing twice is free —
    // `flush` clears the timer map, and `enqueue` coalesces on the note id.
    const onPageHide = () => flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flush();
    };
  }, []);

  // Deleting a note. v1.13 review, blocker 4.
  //
  // `DELETE_NOTE` existed in the reducer and `delete_note` in KIND_DISPATCH,
  // and NOTHING dispatched or enqueued either — the notebook shipped with no
  // way to delete a note at all. The half that would have bitten hardest is
  // the sync half: a note removed on one device would have stayed live on the
  // server and come back on the next reinstall.
  //
  // Sited here rather than in the view because this is where `session` and
  // the outbox live, matching every other delete path in this file.
  const onDeleteNote = useCallback((id) => {
    if (!id) return;
    const pending = noteTimers.current.get(id);
    // Drop any queued upsert for this note first: pushing an edit and then a
    // tombstone for the same note in one drain is two round trips to reach
    // the state one of them describes.
    if (pending?.handle) clearTimeout(pending.handle);
    noteTimers.current.delete(id);
    dispatch({ type: "DELETE_NOTE", id });
    if (session) outbox.enqueue("delete_note", { id });
  }, [session]);

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
    sync.startRealtime(doPull);
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

  // ── v1.0.4 one-shot post-migration push ─────────────────────────────────────
  // The UUID migration in the reducer init may have rewritten local IDs. Those
  // rewritten rows have never reached Supabase (the old short-ID pushes were
  // failing silently). Push everything once after sign-in. Subjects must go
  // before grades (FK), grades before sessions doesn't matter (no FK between).
  // Fire-and-forget per row, log failures — next user edit will retry.
  useEffect(() => {
    if (!session) return;
    if (localStorage.getItem("studydesk-needs-initial-push") !== "1") return;
    let cancelled = false;
    (async () => {
      let pushed = 0, failed = 0;
      const courses = Object.values(state.courses).filter(c => !c.deletedAt);
      for (const c of courses) {
        if (cancelled) return;
        try {
          await sync.upsertSubject({ id: c.id, name: c.name, credits: c.credits, semester: c.semester, schoolYear: c.schoolYear, color: c.color });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push subject failed:", c.id, e); }
      }
      const grades = (state.grades || []).filter(g => !g.deletedAt);
      for (const g of grades) {
        if (cancelled) return;
        try {
          await sync.upsertGrade({ id: g.id, subjectId: g.subjectId, grade: g.grade, weight: g.weight, date: g.date });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push grade failed:", g.id, e); }
      }
      const sessions = (state.studySessions || []).filter(s => !s.deletedAt);
      for (const s of sessions) {
        if (cancelled) return;
        try {
          await sync.logStudySession({ id: s.id, subjectId: s.subjectId, startedAt: s.startedAt, durationMinutes: s.durationMinutes, notes: s.notes });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push session failed:", s.id, e); }
      }
      // v1.7 (StudyDesk#6) — assignments/exams/actions. These run AFTER courses
      // because both carry a NOT NULL subject_id FK; a course that failed above
      // would take its homework down with it, which is why failures are counted
      // rather than thrown (the flag stays set and the whole batch retries).
      // Rows whose course no longer exists locally are skipped rather than
      // attempted: the FK would reject them and burn a retry every launch.
      for (const a of (state.assignments || [])) {
        if (cancelled) return;
        if (!a.courseId || !state.courses[a.courseId]) continue;
        try {
          await sync.upsertAssignment({ id: a.id, courseId: a.courseId, title: a.title, type: a.type, dueDate: a.dueDate, dueTime: a.dueTime, notes: a.notes, done: a.done });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push assignment failed:", a.id, e); }
      }
      for (const ex of (state.exams || [])) {
        if (cancelled) return;
        if (!ex.courseId || !state.courses[ex.courseId]) continue;
        try {
          await sync.upsertExam({ id: ex.id, courseId: ex.courseId, title: ex.title, dueDate: ex.dueDate, difficulty: ex.difficulty, notes: ex.notes, done: ex.done, topics: ex.topics });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push exam failed:", ex.id, e); }
      }
      // Only manual to-dos. The suggested ones are derived from assignments and
      // exams on every render and must never reach the cloud, or they would
      // come back as duplicate real rows alongside the freshly derived ones.
      for (const ac of (state.actions || []).filter(x => !x.suggested)) {
        if (cancelled) return;
        try {
          await sync.upsertAction({ id: ac.id, text: ac.text, bucket: ac.bucket, courseId: ac.courseId, done: ac.done });
          pushed++;
        } catch (e) { failed++; console.error("[StudyDesk] initial push action failed:", ac.id, e); }
      }
      if (failed === 0) {
        try { localStorage.removeItem("studydesk-needs-initial-push"); } catch {}
        if (pushed > 0) showFlash(t('av.flash.syncedLegacy', { n: pushed }));
      } else {
        showFlash(t('av.flash.syncedFailed', { pushed, failed }));
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // ── v1.7 push reconciler for assignments / exams / actions (StudyDesk#6) ────
  //
  // Courses, grades and sessions enqueue their own pushes at each call site.
  // These three deliberately do not, and the reason is structural: they are
  // mutated from ~15 places across AsgnItem, ExamCard and ActionsView, none of
  // which receive `session`. Threading it through every one of those props
  // would be a wide change to working components, and any call site missed
  // would be an edit that silently never syncs — the exact bug being fixed.
  //
  // Instead: diff the three arrays after every state change and enqueue what
  // actually moved. One place, no call sites to miss, and it picks up any
  // future mutation path for free.
  const pushBaseline = useRef(null);
  useEffect(() => {
    if (!session) { pushBaseline.current = null; return; }
    // Wait for the first pull to settle before arming. Pushing local rows
    // before knowing the remote state would stamp them updated_at = now and
    // let a stale device win against a newer edit made elsewhere.
    if (!pulledOnceRef.current) return;

    const snap = (list, fields) => {
      const m = new Map();
      for (const x of list || []) m.set(x.id, fields(x));
      return m;
    };
    // Compare on updatedAt, not deep equality — every mutation stamps it, so
    // this is both cheaper and immune to unrelated field churn.
    const stamp = (x) => x.updatedAt || '';
    const next = {
      assignments: snap(state.assignments, stamp),
      exams: snap(state.exams, stamp),
      actions: snap((state.actions || []).filter((a) => !a.suggested), stamp),
    };

    // First run after a pull: record the baseline, push nothing. What is on
    // screen right now is already reconciled with the cloud.
    if (!pushBaseline.current) { pushBaseline.current = next; return; }

    const prev = pushBaseline.current;
    const byId = (list) => new Map((list || []).map((x) => [x.id, x]));
    const assignmentsById = byId(state.assignments);
    const examsById = byId(state.exams);
    const actionsById = byId(state.actions);

    // StudyDesk#72 — `stamps` is what the last pull returned. A row whose
    // stamp moved because a pull brought the server's copy in is not a local
    // edit, and a row that left because the pull carried its tombstone was
    // deleted elsewhere; re-queueing either only moves the server's timestamp,
    // which the next pull brings back here (Limekana/limecore#24).
    const stamps = remoteStampsRef.current;

    for (const [id, s] of next.assignments) {
      if (prev.assignments.get(id) === s) continue;
      const a = assignmentsById.get(id);
      if (!a?.courseId) continue;
      if (isInSync('assignments', a, stamps)) continue;
      outbox.enqueue('upsert_assignment', { id, courseId: a.courseId, title: a.title, type: a.type, dueDate: a.dueDate, dueTime: a.dueTime, notes: a.notes, done: a.done, updatedAt: a.updatedAt });
    }
    for (const id of prev.assignments.keys()) {
      if (!next.assignments.has(id) && !isRemoteTombstone('assignments', id, stamps)) outbox.enqueue('delete_assignment', { id });
    }

    for (const [id, s] of next.exams) {
      if (prev.exams.get(id) === s) continue;
      const e = examsById.get(id);
      if (!e?.courseId) continue;
      if (isInSync('exams', e, stamps)) continue;
      outbox.enqueue('upsert_exam', { id, courseId: e.courseId, title: e.title, dueDate: e.dueDate, difficulty: e.difficulty, notes: e.notes, done: e.done, topics: e.topics, updatedAt: e.updatedAt });
    }
    for (const id of prev.exams.keys()) {
      if (!next.exams.has(id) && !isRemoteTombstone('exams', id, stamps)) outbox.enqueue('delete_exam', { id });
    }

    for (const [id, s] of next.actions) {
      if (prev.actions.get(id) === s) continue;
      const a = actionsById.get(id);
      if (!a) continue;
      if (isInSync('actions', a, stamps)) continue;
      outbox.enqueue('upsert_action', { id, text: a.text, bucket: a.bucket, courseId: a.courseId, done: a.done, updatedAt: a.updatedAt });
    }
    for (const id of prev.actions.keys()) {
      if (!next.actions.has(id) && !isRemoteTombstone('actions', id, stamps)) outbox.enqueue('delete_action', { id });
    }

    pushBaseline.current = next;
  // `session` is read for the sign-in gate only; the identity that matters is
  // the user id, which the pull effect already keys on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id, state.assignments, state.exams, state.actions]);

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

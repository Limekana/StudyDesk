// Writes the state back to localStorage: the app database and the device preferences.
// Moved out of App.jsx unchanged and called from the same place (limecore#12).
import { useEffect } from "react";
import { writeJson } from "../lib/localStore.js";

export function usePersistState(state) {
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
}

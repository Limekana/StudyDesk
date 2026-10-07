// Deadline arithmetic shared by the plan views and the reminder scheduler.
import { parseLocalDate, addDays } from "./dates.js";
import { DIFFICULTY_DAYS } from "./examDifficulty.js";

// Local midnight for "today", computed PER CALL — never frozen at module load.
// A Capacitor WebView backgrounded overnight and resumed without a cold restart
// would otherwise still think it's yesterday, mis-bucketing an assignment due
// "today" into "later" and staling every due-date urgency calc.
function todayMidnight(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
export function daysUntil(s){ if(!s) return null; return Math.round((parseLocalDate(s)-todayMidnight())/86400000); }
export function urgencyColor(d){ if(d===null) return "#aaa"; if(d<0) return "#c0392b"; if(d<=2) return "#c0392b"; if(d<=7) return "#d4860a"; return "#2e7d52"; }
export function urgencyLabel(d, t){ if(d===null||!t) return ""; if(d<0) return t('av.urgency.overdue',{n:Math.abs(d)}); if(d===0) return t('av.urgency.dueToday'); if(d===1) return t('av.urgency.dueTomorrow'); return t('av.urgency.daysLeft',{n:d}); }
export function studyStartDate(e){ return addDays(e.dueDate,-DIFFICULTY_DAYS[e.difficulty||"medium"]); }

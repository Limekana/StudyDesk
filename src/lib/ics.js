// v1.9 Item 14a — iCalendar export for exams and assignments.
//
// Flagged in the build plan as disproportionately high-value for its cost: it
// needs no calendar UI at all, and it puts StudyDesk's dates into the calendar
// the user actually lives in. `buildIcs` is pure and text-only so it can be
// asserted; only `downloadIcs` touches the DOM.
//
// RFC 5545 is unusually unforgiving for a text format, and the three things
// that break real-world .ics files are all handled explicitly below: CRLF line
// endings, folding long lines at 75 OCTETS (not characters), and escaping the
// four special characters in TEXT values. A Finnish course name with a comma
// in it, or any Chinese/Arabic title, will silently break a consumer that gets
// any of those wrong.

const PRODID = '-//Limecore//StudyDesk//EN';

/** RFC 5545 §3.3.11 TEXT escaping. Backslash first — escaping it after the
 *  others would double-escape the backslashes they just introduced. */
function esc(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold to 75 octets per line, continuation lines prefixed with one space.
 *  Counted in UTF-8 bytes and never split mid-character: a folded line that
 *  cuts a multi-byte sequence in half produces mojibake in the importing
 *  calendar, which is exactly the class of bug that only shows up in the
 *  non-English locales nobody tests. */
function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  // Iterating the string spreads it by code point, so surrogate pairs (emoji
  // in a course name) stay intact too.
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** YYYYMMDD for a local date string, for DTSTART;VALUE=DATE. */
function dateValue(iso) {
  return String(iso).replace(/-/g, '');
}

/** The day after `iso`, as a DATE value. All-day DTEND is EXCLUSIVE in RFC
 *  5545 — using the due date itself produces a zero-length event that some
 *  clients drop and others render on the previous day. */
function nextDateValue(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const n = new Date(y, m - 1, d + 1);
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
}

function stamp(date = new Date()) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}T${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}Z`;
}

/** A stable UID. Stable matters more than it looks: re-exporting after adding
 *  one assignment must UPDATE the existing entries in the user's calendar
 *  rather than creating a second copy of every exam they already imported. */
function uid(kind, id) {
  return `${kind}-${id}@studydesk.limecore.dev`;
}

/**
 * @param {object} state   the app reducer state
 * @param {object} [opts]
 * @param {boolean} [opts.includeDone=false]  export completed items too
 * @param {Date}   [opts.now]                 injectable for assertions
 * @returns {{ text: string, count: number }}
 */
export function buildIcs(state, opts = {}) {
  const { includeDone = false, now = new Date() } = opts;
  const dtstamp = stamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:StudyDesk',
  ];

  const courses = state.courses || {};
  const nameOf = (id) => {
    const c = courses[id];
    return c && !c.deletedAt ? c.name : null;
  };

  let count = 0;
  const addEvent = ({ kind, id, title, iso, courseName, description, categories }) => {
    if (!iso) return;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid(kind, id)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dateValue(iso)}`);
    lines.push(`DTEND;VALUE=DATE:${nextDateValue(iso)}`);
    lines.push(`SUMMARY:${esc(courseName ? `${title} — ${courseName}` : title)}`);
    if (description) lines.push(`DESCRIPTION:${esc(description)}`);
    if (categories) lines.push(`CATEGORIES:${esc(categories)}`);
    // TRANSPARENT: a due date should not mark the whole day busy in a shared
    // calendar. It is a deadline, not an appointment.
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
    count += 1;
  };

  for (const e of state.exams || []) {
    if (!includeDone && e.done) continue;
    addEvent({
      kind: 'exam',
      id: e.id,
      title: e.title,
      iso: e.dueDate,
      courseName: nameOf(e.courseId),
      description: e.notes || '',
      categories: 'StudyDesk,Exam',
    });
  }

  for (const a of state.assignments || []) {
    if (!includeDone && a.done) continue;
    addEvent({
      kind: 'assignment',
      id: a.id,
      title: a.title,
      iso: a.dueDate,
      courseName: nameOf(a.courseId),
      description: a.notes || '',
      categories: 'StudyDesk,Assignment',
    });
  }

  // ── Commitments (v1.10) ────────────────────────────────────────────────
  // The only TIMED events StudyDesk exports, and the only OPAQUE ones: a
  // training genuinely occupies 18:00–19:30 and should mark the user busy,
  // whereas a due date is a deadline and must not blank out someone's day in
  // a shared calendar.
  //
  // DTSTART is written as a FLOATING local time — no `Z`, no `TZID`. That is
  // not a shortcut around timezone handling, it is the correct encoding of
  // what the column stores: `start_time` is a wall-clock time, so "18:00"
  // means 18:00 wherever the user is, which is exactly what floating time
  // means in RFC 5545. Stamping it UTC would move every training by the
  // offset, and a TZID would need a timezone database this app does not ship.
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const hhmmss = (t) => String(t || '').slice(0, 8).replace(/:/g, '') || '000000';
  for (const c of state.commitments || []) {
    if (c.deletedAt || !c.startsOn || !c.startTime || !c.endTime) continue;
    const weekly = c.weekday !== null && c.weekday !== undefined && Number.isFinite(Number(c.weekday));
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid('commitment', c.id)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${dateValue(c.startsOn)}T${hhmmss(c.startTime)}`);
    lines.push(`DTEND:${dateValue(c.startsOn)}T${hhmmss(c.endTime)}`);
    if (weekly) {
      // UNTIL must share DTSTART's value type, so it stays floating too.
      const until = c.endsOn ? `;UNTIL=${dateValue(c.endsOn)}T235959` : '';
      lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[Number(c.weekday)]}${until}`);
    }
    lines.push(`SUMMARY:${esc(c.title)}`);
    if (c.notes) lines.push(`DESCRIPTION:${esc(c.notes)}`);
    lines.push('CATEGORIES:StudyDesk,Commitment');
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
    count += 1;
  }

  lines.push('END:VCALENDAR');

  // Logged study sessions are deliberately NOT exported. They are a record of
  // what happened, and pushing them into a calendar turns a forward-looking
  // planner into a diary the user did not ask for. Revision windows are also
  // left out: they are derived from difficulty and shift whenever the user
  // retunes an exam, so exporting them would leave stale blocks behind in a
  // calendar StudyDesk cannot reach back into.

  return { text: lines.map(fold).join('\r\n') + '\r\n', count };
}

/** Trigger a browser download. Returns the number of events written, or -1
 *  when the platform cannot save the file — see below. */
export function downloadIcs(state, opts = {}) {
  const { text, count } = buildIcs(state, opts);
  if (count === 0) return 0;

  // An Android WebView does not honour `<a download>`, and StudyDesk ships no
  // Filesystem or Share plugin — adding one would mean a new native dependency
  // in a reproducible F-Droid build, which is not a decision a calendar export
  // gets to make on its own. So native reports honestly instead of appearing
  // to succeed. Export is a desktop-edition feature until that call is made.
  const isNative = typeof window !== 'undefined'
    && window.Capacitor?.isNativePlatform?.() === true;
  if (isNative) return -1;

  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `studydesk-${new Date().toISOString().slice(0, 10)}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on the next tick rather than synchronously: Safari has not started
  // reading the blob by the time click() returns, and revoking immediately
  // gives an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return count;
}

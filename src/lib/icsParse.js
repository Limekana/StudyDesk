// iCalendar parsing, for subscribed calendar feeds.
//
// The counterpart to `ics.js`, which writes. Same RFC, opposite direction,
// and the same three things that break real-world files are handled here
// explicitly: unfolding continuation lines, unescaping the four TEXT
// specials, and the fact that DATE and DATE-TIME are different types.
//
// ── Scope, from the build plan ───────────────────────────────────────────
//
//   > "ICS carries titles, dates and descriptions — not assignment type,
//      points or submission status. This is 'due dates arrive on their own',
//      not 'X mirrored'."
//
// So this returns exactly what the format actually carries. It does not
// guess a type from a title, and it does not invent a points value. Anything
// it cannot honestly read, it leaves out.
//
// ── No vendor appears in this file ───────────────────────────────────────
//
// The build plan's decision, and it is a real engineering constraint rather
// than a naming preference: "build one generic feature — subscribe to a
// calendar feed — and [the vendor] never appears in the codebase. It appears
// in the help text. No vendor integration to maintain, one input covering
// every LMS a student might be handed." Every system a student is handed
// exports ICS, so the format is the integration.
//
// Pure and total. No network, no DOM.

// ── Unfolding ─────────────────────────────────────────────────────────────
//
// RFC 5545 §3.1: a line may be broken and continued by starting the next line
// with a space or a tab. Unfolding must happen BEFORE anything else, or a
// long DESCRIPTION arrives in pieces and every field after it in that line is
// lost. Servers fold aggressively; a description of any length will be folded.
function unfold(text) {
  return String(text ?? '')
    // Normalise line endings first. The spec says CRLF and the world sends
    // all three, so a parser that only handles CRLF silently reads a whole
    // LF-terminated file as one line.
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // A newline followed by a single space or tab is a fold, not a break.
    .replace(/\n[ \t]/g, '');
}

/** RFC 5545 §3.3.11, in reverse. Order matters for the same reason it does in
 *  `esc()`: `\\n` must become a newline before `\\\\` becomes a backslash, or
 *  an escaped backslash followed by an n turns into a line break. */
function unescapeText(value) {
  const src = String(value ?? '');
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '\\') { out += src[i]; continue; }
    const next = src[i + 1];
    if (next === 'n' || next === 'N') { out += '\n'; i++; }
    else if (next === '\\' || next === ';' || next === ',') { out += next; i++; }
    else out += src[i]; // a stray backslash is content
  }
  return out;
}

/**
 * Split one content line into name, params and value.
 *
 * The value may contain colons (a URL almost always does), so only the FIRST
 * colon separates. Params may contain a quoted colon too — `;TZID="X:Y"` —
 * which is why the scan tracks quoting rather than using indexOf.
 */
function splitLine(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      const head = line.slice(0, i);
      const value = line.slice(i + 1);
      const [name, ...paramParts] = head.split(';');
      const params = {};
      for (const p of paramParts) {
        const eq = p.indexOf('=');
        if (eq === -1) continue;
        params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
      }
      return { name: name.toUpperCase(), params, value };
    }
  }
  return null;
}

/**
 * A DATE or DATE-TIME value → `{ iso, allDay }`.
 *
 * `iso` is a local YYYY-MM-DD, matching how this app stores every due date.
 * The app's own convention, stated in calendar.js: a due date is a calendar
 * day, and a Date carries a time and a zone that will eventually shift one of
 * them across midnight.
 *
 * The three forms, and why the distinction is not pedantry:
 *   20260915           DATE      — an all-day event. Already local.
 *   20260915T140000Z   UTC       — converted to the reader's local day, which
 *                                  is what makes a 23:59 UTC deadline show on
 *                                  the right day for a reader in UTC+3.
 *   20260915T140000    floating  — no zone; local by definition, so it must
 *                                  NOT be run through a UTC conversion.
 */
export function parseIcsDate(value, params = {}) {
  const raw = String(value ?? '').trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    return { iso: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, allDay: true };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!dt) return null;

  const [, y, mo, d, h, mi, s, zulu] = dt;

  // VALUE=DATE with a time is malformed but occurs; trust the declared type.
  if (params.VALUE === 'DATE') {
    return { iso: `${y}-${mo}-${d}`, allDay: true };
  }

  if (zulu) {
    // Real instant → the reader's local calendar day.
    const at = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    const local = new Date(at.getTime());
    const pad = (n) => String(n).padStart(2, '0');
    return {
      iso: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
      allDay: false,
      time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    };
  }

  // Floating, or carrying a TZID this app does not resolve. Treated as local:
  // a TZID library is a large dependency for a case that is already the
  // common one, and being wrong by a few hours on a due DATE almost never
  // moves the day. Being wrong by a whole day, which is what a UTC
  // conversion of a floating time can do, would.
  return { iso: `${y}-${mo}-${d}`, allDay: false, time: `${h}:${mi}` };
}

/**
 * Parse an .ics document into events.
 *
 * @returns {{events: Array, name: string|null, errors: number}}
 *
 * Never throws. A feed is a third-party document fetched over the network,
 * and one malformed VEVENT in a term's worth of deadlines must not cost the
 * user the other two hundred. Bad events are counted and skipped.
 */
export function parseIcs(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let calendarName = null;
  let errors = 0;

  let current = null;
  // Nesting depth of non-VEVENT components — VALARM inside VEVENT, VTIMEZONE
  // at the top level. Without this an alarm's own SUMMARY ("Reminder")
  // overwrites the event's, and every event in the feed comes back named
  // "Reminder".
  let ignoreDepth = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = splitLine(line);
    if (!parsed) continue;
    const { name, params, value } = parsed;

    if (name === 'BEGIN') {
      if (value === 'VEVENT' && !current && ignoreDepth === 0) {
        current = { uid: null, summary: null, description: null, location: null, url: null };
      } else if (current || value !== 'VCALENDAR') {
        ignoreDepth++;
      }
      continue;
    }

    if (name === 'END') {
      if (ignoreDepth > 0) { ignoreDepth--; continue; }
      if (value === 'VEVENT' && current) {
        // A UID and a start are the minimum for an event to be usable: the
        // UID is what makes re-fetching idempotent, and without a date there
        // is nothing to put on a calendar.
        if (current.uid && current.start) events.push(current);
        else errors++;
        current = null;
      }
      continue;
    }

    if (ignoreDepth > 0) continue;

    if (!current) {
      // Calendar-level properties. The name is worth having: it is what the
      // feed calls itself, and showing it back is how a user confirms they
      // pasted the right URL.
      if (name === 'X-WR-CALNAME') calendarName = unescapeText(value);
      continue;
    }

    switch (name) {
      case 'UID': current.uid = value.trim(); break;
      case 'SUMMARY': current.summary = unescapeText(value); break;
      case 'DESCRIPTION': current.description = unescapeText(value); break;
      case 'LOCATION': current.location = unescapeText(value); break;
      case 'URL': current.url = value.trim(); break;
      case 'DTSTART': current.start = parseIcsDate(value, params); break;
      case 'DTEND': current.end = parseIcsDate(value, params); break;
      // Many LMS feeds publish a deadline as a zero-length VEVENT with only
      // DUE set, or as a VTODO-shaped VEVENT. Reading DUE as a start when
      // there is no DTSTART is what makes those feeds work at all.
      case 'DUE': if (!current.start) current.start = parseIcsDate(value, params); break;
      case 'STATUS': current.status = value.trim().toUpperCase(); break;
      case 'LAST-MODIFIED': current.lastModified = value.trim(); break;
      default: break;
    }
  }

  return { events, name: calendarName, errors };
}

/**
 * Feed events → the shape this app stores.
 *
 * Deliberately conservative about what it claims. Every field here is
 * something ICS actually carries; nothing is inferred. In particular there is
 * no `type` and no `points` — the build plan is explicit that promising those
 * is how "due dates arrive on their own" gets mistaken for a full mirror.
 */
export function toFeedItems(events, feedId) {
  const out = [];
  for (const e of events) {
    if (!e.start?.iso) continue;
    // CANCELLED events are published as tombstones by most systems. Keeping
    // them would put a cancelled exam on a student's calendar, which is worse
    // than not importing it.
    if (e.status === 'CANCELLED') continue;
    out.push({
      feedId,
      uid: e.uid,
      title: (e.summary || '').trim() || null,
      dueDate: e.start.iso,
      time: e.start.time || null,
      allDay: !!e.start.allDay,
      notes: (e.description || '').trim() || null,
      location: (e.location || '').trim() || null,
      url: e.url || null,
    });
  }
  return out;
}

/**
 * Merge a fetched set into the stored set, keyed by UID.
 *
 * The build plan asks for "dedupe by event UID", and the reason it matters is
 * that a feed is re-fetched on a schedule: without UID identity every poll
 * would duplicate the entire term.
 *
 * @returns {{items, added, updated, removed}}
 *
 * A UID that VANISHES from the feed is removed. That is deliberate and is the
 * behaviour a subscription implies — the institution withdrew the item — but
 * it is only safe because this runs on a SUCCESSFUL fetch. A failed fetch must
 * never reach here, or one flaky request would wipe a term of deadlines. The
 * caller enforces that; see `refreshFeed`.
 */
export function mergeFeedItems(existing, incoming) {
  const prev = new Map((existing || []).map((i) => [i.uid, i]));
  const next = new Map();
  let added = 0;
  let updated = 0;

  for (const item of incoming || []) {
    if (!item.uid) continue;
    const before = prev.get(item.uid);
    if (!before) added++;
    else if (
      before.title !== item.title ||
      before.dueDate !== item.dueDate ||
      before.time !== item.time ||
      before.notes !== item.notes
    ) updated++;
    // The incoming row wins outright: the feed is the source of truth for its
    // own events, and a local edit to an imported item is not a thing this
    // feature offers.
    next.set(item.uid, { ...before, ...item });
  }

  let removed = 0;
  for (const uid of prev.keys()) if (!next.has(uid)) removed++;

  return { items: Array.from(next.values()), added, updated, removed };
}

// v1.18.1 (StudyDesk#144) — the server's clock, as seen from this device.
//
// Every edit is stamped with the time it was made, and the newest stamp wins
// (on the server, set_updated_at(); on this device, merge.js). A device whose
// clock ran ahead stamped its edits in the future: the server clamped them on
// the way in, but this device kept its own future stamps and so ignored newer
// edits from other devices on every pull, then pushed over them. A dual-boot
// PC whose clock is off by the timezone offset is hours out.
//
// So stamps are made in server time: this device's clock plus the offset
// measured from the `Date` header of Supabase responses. How a sample is
// taken, and why:
//   - The header is the server's time somewhere between sending the request
//     and receiving the response, so it is compared with the midpoint of the
//     two, and a sample whose round trip took over 2 s is discarded: it says
//     too little about when the header was written.
//   - The header has whole seconds, so small offsets are noise. An offset is
//     applied once it reaches 5 s and kept until it falls below 2 s. The gap
//     is hysteresis: with one threshold, a clock 5 s out flapped between 0 and
//     ~5 s from one response to the next, as rounding and latency moved each
//     sample to either side of it.
//   - The applied offset is kept across launches, for edits made before the
//     first response arrives, as `{ offset, measuredAt }`. One measured more
//     than a day ago is ignored (0 until a fresh sample): the device clock may
//     have been corrected since, and an old offset would then skew every stamp.
// With no usable measurement the offset is 0, which is the old behaviour.
const KEY = 'studydesk-server-clock-offset';
const APPLY_FROM_MS = 5000;
const DROP_BELOW_MS = 2000;
const MAX_ROUND_TRIP_MS = 2000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A fresh sample re-saves an unchanged offset at most this often, so the
// stored one does not expire while the app is in use.
const RESAVE_AFTER_MS = 60 * 60 * 1000;

let offsetMs = 0;
let savedAt = NaN;

(() => {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    const age = Date.now() - stored?.measuredAt;
    if (Number.isFinite(stored?.offset) && age >= 0 && age <= MAX_AGE_MS) {
      offsetMs = stored.offset;
      savedAt = stored.measuredAt;
    }
  } catch { /* nothing usable stored: 0 until the first sample */ }
})();

function save(measuredAt) {
  savedAt = measuredAt;
  try {
    localStorage.setItem(KEY, JSON.stringify({ offset: offsetMs, measuredAt }));
  } catch { /* the offset is then re-measured next launch */ }
}

/**
 * Record the server's `Date` header from a request sent at `sentAt` whose
 * response arrived at `receivedAt` (device clock, ms). An unreadable header
 * or a slow round trip changes nothing.
 */
export function noteServerDate(header, sentAt, receivedAt = Date.now()) {
  const server = Date.parse(header || '');
  if (!Number.isFinite(server) || !Number.isFinite(sentAt)) return;
  const roundTrip = receivedAt - sentAt;
  if (!(roundTrip >= 0 && roundTrip <= MAX_ROUND_TRIP_MS)) return;
  const measured = server - (sentAt + receivedAt) / 2;
  const size = Math.abs(measured);
  const applying = offsetMs !== 0;
  const next = size >= APPLY_FROM_MS || (applying && size >= DROP_BELOW_MS) ? Math.round(measured) : 0;
  if (next !== offsetMs) {
    offsetMs = next;
    save(receivedAt);
  } else if (next !== 0 && !(receivedAt - savedAt < RESAVE_AFTER_MS)) {
    save(receivedAt);
  }
}

/**
 * `fetch`, noting the server's clock from each response. Given to the
 * Supabase client (supabase.js). The request and the response pass through
 * untouched, and a failed request fails as it would have.
 */
export function fetchNotingServerTime(input, init) {
  const sentAt = Date.now();
  return fetch(input, init).then((res) => {
    try {
      noteServerDate(res?.headers?.get?.('date'), sentAt, Date.now());
    } catch { /* a clock sample must never cost the response */ }
    return res;
  });
}

/** Milliseconds, in server time. */
export function serverNow() {
  return Date.now() + offsetMs;
}

/** An ISO stamp, in server time, for an edit made now. */
export function stampNow() {
  return new Date(serverNow()).toISOString();
}

/** Test seam. */
export function resetServerClock() {
  offsetMs = 0;
  savedAt = NaN;
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
}

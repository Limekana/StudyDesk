-- StudyDesk v1.14 Item 6a (#51) — a lesson that meets on several weekdays.
--
--   > "there's no way to say this is the same course, just also on Wednesday"
--
-- ── NOT YET APPLIED ──────────────────────────────────────────────────────
-- Written 2026-09-13. Unlike the two migrations beside it, this one has not
-- been applied: the owner authorised those two specifically, and DDL against
-- production is a per-migration decision, not a standing one.
--
-- Shipping ahead of it is not an outage. `upsertTimetableEntry` goes through
-- `upsertTolerant`, which catches PostgREST's PGRST204 ("no such column") and
-- retries once without the optional columns. Until this is applied, a
-- multi-weekday lesson still works locally and still syncs — the rows arrive
-- on the second device as N independent lessons, which is exactly what they
-- were before this feature and is correct, just ungrouped.
--
-- ── Why a series id and not a weekday LIST ───────────────────────────────
--
-- The obvious shape is `weekday smallint[]`, and it is the one thing `P1`
-- rules out. `weekday` is a single `smallint` that every shipped version reads
-- to decide which column of the grid a lesson is drawn in; changing its type
-- breaks all of them, and old builds live on F-Droid indefinitely.
--
-- The other tempting shape — keep `weekday` AND add `weekdays` beside it — is
-- worse than it looks. Two columns would then encode the same fact and could
-- disagree, and an older client editing the row would write only `weekday`,
-- silently dropping the other days. A column that a supported client can
-- corrupt by behaving correctly is not an additive column.
--
-- So the rows stay one-per-weekday, exactly as they are today, and gain a
-- nullable pointer saying which ones belong together. Nothing existing changes
-- shape or meaning. NULL means "not part of a set", which is what every one of
-- the 226 existing rows is.
--
-- ── What the client does with it ─────────────────────────────────────────
--
-- The editor loads the whole series, shows a weekday multi-select, and on save
-- reconciles the set — KEYED ON THE WEEKDAY, never positionally. That matters
-- more than it sounds: `lesson_attendance` is keyed on the ENTRY id, so a row
-- that loses its id loses its attendance history. Matching "the first selected
-- day to the first existing row" silently reassigns ids the moment a day is
-- added or removed in the middle, which would move one lesson's attendance
-- onto another day. `planSeriesWrite` in src/lib/timetable.js is the authority
-- and is asserted against exactly that case.
--
-- ── Index ────────────────────────────────────────────────────────────────
--
-- Partial, on the non-null values only. Every existing row is NULL and most
-- lessons will stay single-day, so a full index would be mostly empty entries
-- for a lookup that never asks about them.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- Unchanged. `timetable_entries` already enforces user_id = auth.uid() and
-- adding a column does not touch its policies (`P2`). Note the series id is
-- deliberately NOT a foreign key to anything: it is a grouping label, there is
-- no parent row, and inventing a `lesson_series` table to point at would add a
-- second table to keep in step for no behaviour anyone asked for.

alter table public.timetable_entries
  add column if not exists series_id uuid;

create index if not exists timetable_entries_series_idx
  on public.timetable_entries (series_id)
  where series_id is not null;

comment on column public.timetable_entries.series_id is
  'v1.14. Groups the one-row-per-weekday entries of a single lesson that meets '
  'on several days, or NULL for a lesson that meets on one. Not a foreign key — '
  'there is no parent row, it is a shared label. `weekday` is unchanged and '
  'remains the single source of which day a row is drawn on, so a client that '
  'does not know this column sees N independent lessons, which is correct.';

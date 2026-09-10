-- StudyDesk v1.13 — make (user_id, timetable_entry_id, date) the real identity
-- of a lesson_attendance row.
--
-- FORWARD-ONLY. 20260903_timetable_v113.sql was recorded as applied by d1789fb
-- and then edited in place by af3d6cd, so the edit never ran anywhere: an
-- already-applied migration does not re-run. Whatever that file says today,
-- the live database still has what the ORIGINAL version created. This file is
-- the one that actually changes it, and it must be the last word on this index.
--
-- Three things are wrong on the live database right now:
--
--   1. The unique index there is PARTIAL — `where deleted_at is null` — and is
--      named `lesson_attendance_entry_date_uidx`. Postgres cannot infer a
--      partial index from the bare column list PostgREST's `onConflict` sends,
--      so every `upsertAttendance` raises 42P10. Attendance writes fail for
--      every user, on the first mark, permanently.
--
--   2. `20260903_timetable_v113.sql` as it now reads creates
--      `lesson_attendance_entry_date_full_uidx`, while its own comment and
--      src/lib/sync.js both named `v113_lesson_attendance_full_unique_idx`.
--      Three names for one index, at most one of which exists.
--
--   3. Nothing drops the partial index, and nothing dedupes before creating a
--      total one. The partial index existed PRECISELY so a soft-deleted row and
--      a live row for the same lesson could coexist, so any database where a
--      user has cleared and re-marked a lesson holds exactly the pair that a
--      total unique index rejects. Creating it without a dedupe in front fails
--      the migration on real user data.
--
-- ── The deliberate modelling decision ────────────────────────────────────
--
-- The soft-deleted-plus-live pair is NOT kept representable. One lesson on one
-- date is ONE row forever: clearing a mark soft-deletes that row, and
-- re-marking revives it (`deleted_at: null`) rather than inserting a second.
--
-- The alternative was to keep the index partial and drop `onConflict`, doing a
-- select-then-insert-or-update in the client. That loses atomicity — two
-- devices can both see "no live row" and both insert — which is the duplicate
-- this index exists to prevent. Two rows for one fact were never correct, so
-- the total index is the right shape and the client is what moves.
--
-- src/App.jsx (SET_ATTENDANCE) and src/lib/merge.js are changed in the same
-- commit to use the same identity, so local state cannot hold a pair the
-- server has no way to represent.

-- ── 1. Dedupe, before anything can reject it ─────────────────────────────
--
-- Keep the most recently updated row per natural key; soft-delete the rest
-- rather than deleting them outright, so a device still holding one of the
-- losing ids learns it is gone on its next pull instead of silently
-- re-enqueueing it.
--
-- `updated_at desc, id desc` — the id tie-break is not cosmetic. Two rows
-- written in the same statement can share a timestamp, and without a total
-- ordering the row that survives would differ between a dry run and the real
-- one.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, timetable_entry_id, date
      order by updated_at desc, id desc
    ) as rn
  from public.lesson_attendance
  where deleted_at is null
)
update public.lesson_attendance a
   set deleted_at = now(),
       updated_at = now()
  from ranked r
 where a.id = r.id
   and r.rn > 1;

-- Soft-deleting the losers above is not enough on its own: the index is TOTAL,
-- so it also rejects two soft-deleted rows sharing a natural key. Collapse
-- those to one, keeping the most recent, and hard-delete the remainder. These
-- rows are already invisible to every client — a soft-deleted row is dropped
-- by `mergeList` on pull — so nothing observable is lost.
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, timetable_entry_id, date
      order by updated_at desc, id desc
    ) as rn
  from public.lesson_attendance
)
delete from public.lesson_attendance a
 using ranked r
 where a.id = r.id
   and r.rn > 1;

-- ── 2. Drop every previous spelling of this index ────────────────────────
--
-- All three names, unconditionally, so this migration lands the same way on a
-- database that got the original partial index, one that got the manually
-- applied `v113_` name, and one built fresh from the migration files.
drop index if exists public.lesson_attendance_entry_date_uidx;
drop index if exists public.v113_lesson_attendance_full_unique_idx;
drop index if exists public.lesson_attendance_entry_date_full_uidx;

-- ── 3. The canonical index ───────────────────────────────────────────────
--
-- `lesson_attendance_entry_date_full_uidx` is THE name from here on. It matches
-- the convention of the other indexes on this table
-- (`lesson_attendance_user_updated_idx`, `_date_idx`, `_entry_idx`) and it is
-- the name src/lib/sync.js references. If you rename it, rename it there too —
-- the whole point of this migration is that those two stopped agreeing.
--
-- Total, not partial: `onConflict` sends a bare column list and Postgres can
-- only infer a non-partial index from one.
create unique index lesson_attendance_entry_date_full_uidx
  on public.lesson_attendance (user_id, timetable_entry_id, date);

comment on index public.lesson_attendance_entry_date_full_uidx is
  'The identity of an attendance fact. TOTAL, not partial: PostgREST onConflict sends a bare column list and Postgres cannot infer a partial index from one — a partial index here raises 42P10 on every upsert. One lesson on one date is one row forever; clearing soft-deletes it and re-marking revives it.';

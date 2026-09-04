-- StudyDesk v1.13 Tier 2 — alternating weeks, and lesson attendance.
--
-- ── APPLIED 2026-09-04, on the owner's instruction ────────────────────────
-- Live on Nexus OS Suite as `v113_timetable_week_parity_and_lesson_attendance`
-- (the covering index below went as `v113_lesson_attendance_fk_covering_index`).
-- Kept here as the readable record of what was run and why. The client
-- degraded cleanly before it landed — see the notes on each change below.
--
-- Additive only. One new nullable column and one new table. Nothing is
-- altered or dropped, so no shipped app version can regress from applying it,
-- which is `P1`'s standing requirement now that old builds live indefinitely
-- on F-Droid.

-- ── Alternating weeks ─────────────────────────────────────────────────────
--
-- Reported 2026-09-02, 5/5: "I have classes every two weeks but I didn't find
-- a way to make it happen in timetable here." `timetable_entries` had a
-- weekday and no notion of week parity.
--
-- NULL means "every week", which is what every existing row already means, so
-- the column needs no backfill and an app version that predates it reads the
-- row and shows the lesson weekly. That is the correct degradation: an old
-- build shows too MANY lessons, never too few, and a student who turns up to
-- a lesson that is not running loses ten minutes rather than missing one.
--
-- 1 = odd weeks, 2 = even weeks, counted from the START OF THE TERM the entry
-- belongs to — not the ISO week number. See `weekParityOf` in
-- src/lib/timetable.js for why: a term spanning New Year would otherwise flip
-- its own parity halfway through for no reason a student could see.
alter table public.timetable_entries
  add column if not exists week_parity smallint;

-- Constrained rather than left open. The only values the app can produce are
-- null, 1 and 2, and a check constraint is what stops a future client bug
-- writing a 3 that every reader then has to defend against.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'timetable_entries_week_parity_ck'
  ) then
    alter table public.timetable_entries
      add constraint timetable_entries_week_parity_ck
      check (week_parity is null or week_parity in (1, 2));
  end if;
end $$;

-- ── Attendance (issue #31) ────────────────────────────────────────────────
--
-- `deflate8818` — the project's first supporter — has been waiting since
-- 2026-08-25.
--
-- One additive table keyed to (timetable_entry_id, date), exactly as the
-- build plan specifies. The percentage is NOT stored: it is a client
-- aggregate over these rows (see src/lib/attendance.js for why a counter that
-- four sync paths can increment will eventually be wrong).
create table if not exists public.lesson_attendance (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  -- Cascade: an attendance record for a lesson that no longer exists in the
  -- timetable has nothing to attach to and no way to be displayed.
  timetable_entry_id uuid not null references public.timetable_entries(id) on delete cascade,
  -- The DATE the lesson fell on. A date, not a timestamptz: "was I in Tuesday's
  -- maths" is a calendar-day question in the student's own timezone, and a
  -- timestamp would make the same lesson land on different days for a user who
  -- travels.
  date               date not null,
  -- present | absent | cancelled | rescheduled.
  --
  -- Text rather than an enum, matching `assignments.type`: a value from a
  -- newer client must not fail the upsert, and an enum would need a migration
  -- to add a fifth state. The client ignores states it does not know.
  --
  -- CANCELLED IS NOT AN ABSENCE. A cancelled lesson did not happen, so it is
  -- in neither the numerator nor the denominator; counting it would punish a
  -- student for their timetable. Rescheduled is the same — the instance that
  -- happened is recorded on its own date.
  status             text not null,
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

-- The identity of the fact. The same lesson on the same day is ONE record
-- whatever device wrote it, so two devices marking the same lesson converge
-- under LWW instead of producing a duplicate that would count twice in the
-- percentage. Partial, so a soft-deleted row does not block re-marking the
-- lesson later.
create unique index if not exists lesson_attendance_entry_date_uidx
  on public.lesson_attendance (user_id, timetable_entry_id, date)
  where deleted_at is null;

create index if not exists lesson_attendance_user_updated_idx on public.lesson_attendance (user_id, updated_at);
create index if not exists lesson_attendance_date_idx         on public.lesson_attendance (user_id, date);

-- Covers the FK on its own. The unique index above leads on user_id, so it
-- does not — and without this, deleting a timetable entry sequentially scans
-- this table to find the rows to cascade. Caught by the performance advisor
-- on the first run after applying, which is why it is a second migration.
create index if not exists lesson_attendance_entry_idx
  on public.lesson_attendance (timetable_entry_id);

-- `auth.uid()` wrapped in a scalar subquery, per
-- `rls_initplan_wrap_auth_uid_in_select` — unwrapped it is re-evaluated once
-- per row and the advisor flags it.
--
-- `P2`: RLS enabled with its policies in the same migration. No exceptions.
alter table public.lesson_attendance enable row level security;

create policy lesson_attendance_select on public.lesson_attendance for select using ((select auth.uid()) = user_id);
create policy lesson_attendance_insert on public.lesson_attendance for insert with check ((select auth.uid()) = user_id);
create policy lesson_attendance_update on public.lesson_attendance for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy lesson_attendance_delete on public.lesson_attendance for delete using ((select auth.uid()) = user_id);

comment on column public.timetable_entries.week_parity is 'NULL = every week (what every pre-v1.13 row means, so no backfill). 1 = odd weeks, 2 = even weeks, counted from the start of the entry''s academic term — not the ISO week number.';
comment on table public.lesson_attendance is 'StudyDesk-owned. One row per (timetable_entry, date). status is present|absent|cancelled|rescheduled as free text, not an enum, so a newer client cannot fail the upsert. CANCELLED IS NOT AN ABSENCE — the percentage is a client aggregate and counts neither cancelled nor rescheduled in either half.';

-- Advisors after applying: security clean (no new findings — the one
-- outstanding WARN is `auth_leaked_password_protection`, an auth setting that
-- predates this and is unrelated). Performance clean for these tables once the
-- covering index above was added; the `unused_index` INFOs are the expected
-- state of an index on an empty table.

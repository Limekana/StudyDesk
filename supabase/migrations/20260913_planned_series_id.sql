-- StudyDesk v1.14 Item 7a (#51) — planned study blocks that repeat.
--
--   > "planned study sessions can't repeat, only the blockers can"
--
-- ── NOT YET APPLIED ──────────────────────────────────────────────────────
-- Written 2026-09-13, alongside 20260913_timetable_series_id.sql and not
-- applied for the same reason: the owner authorised the two v1.14 migrations
-- specifically, and production DDL is a per-migration decision.
--
-- Shipping ahead of it is not an outage. `upsertPlannedSession` goes through
-- `upsertTolerant`, which catches PGRST204 and retries without the optional
-- columns, so until this lands a repeating plan still writes all its blocks and
-- still syncs them — they simply arrive on a second device ungrouped, so the
-- "stop repeating" button is unavailable there and each is deleted on its own.
--
-- ── Why the recurrence is MATERIALISED, and this is only a label ─────────
--
-- A blocker recurs by rule: one row says "every other Thursday" and the
-- calendar derives the rest (see `commitments.interval_weeks`). That works
-- because a blocker has no per-occurrence state.
--
-- A planned session is the opposite case, and it is the point of the feature:
-- each block is either DONE — which writes a `study_sessions` row and links
-- back through `fulfilled_by` — or dismissed, or still owed. A rule would need
-- somewhere to record that per instance, which means a template table plus an
-- exceptions table and every calendar read path learning about both.
--
-- So a repeating plan writes N ordinary `planned_sessions` rows at creation.
-- Each is a completely normal plan and every existing path works on it
-- unchanged. This column is NOT a parent pointer and there is no series table:
-- it is a shared label, and the only thing that reads it is "stop repeating",
-- which needs to find the blocks that are still owed.
--
-- NULL means a one-off, which is what all 5 existing rows are.
--
-- ── What "stop repeating" is allowed to remove ───────────────────────────
--
-- Only blocks still owed, and only from the one you are looking at forwards.
-- A block already logged carries the `fulfilled_by` pointer to a real study
-- session — deleting it to tidy up an intention would orphan evidence of study
-- that actually happened. `laterInSeries` in src/lib/planRepeat.js is the
-- authority and is asserted on exactly that.
--
-- ── Index ────────────────────────────────────────────────────────────────
--
-- Partial, on the non-null values only: every existing row is NULL and most
-- plans will stay one-off, so a full index would be mostly empty entries for a
-- lookup that never asks about them.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- Unchanged. `planned_sessions` already enforces user_id = auth.uid() and
-- adding a column does not touch its policies (`P2`).

alter table public.planned_sessions
  add column if not exists series_id uuid;

create index if not exists planned_sessions_series_idx
  on public.planned_sessions (series_id)
  where series_id is not null;

comment on column public.planned_sessions.series_id is
  'v1.14. Groups the blocks written together by a repeating plan, or NULL for a '
  'one-off. Not a foreign key and not a template — the occurrences are ordinary '
  'independent rows, each separately loggable, movable and dismissable, and this '
  'is only the label that lets "stop repeating" find the ones still owed. '
  'StudyDesk-only; NCC must not read this table as study time.';

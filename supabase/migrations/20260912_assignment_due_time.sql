-- StudyDesk v1.14 Item 5 (#51, "EDITED ADDITION") — assignments get a due TIME.
--
--   > "It would also be great if you could put the time when an assignment is
--      due, not just the date."
--
-- ── NOT YET APPLIED ──────────────────────────────────────────────────────
-- Awaiting the owner's instruction, like 20260911_notebook_layout.sql before
-- it. Apply this before tagging v1.14.
--
-- Unlike the notebook migration, shipping ahead of this one is NOT an outage.
-- That file warns that PostgREST rejects the whole row when an insert names a
-- column the table does not have — true, and it would have failed the push for
-- EVERY assignment, timed or not. So `upsertAssignment` catches that one error
-- code (PGRST204) and retries once without `due_time`: the user loses the
-- time, which they can see, instead of losing the assignment, which they
-- cannot. A warning in a comment is not a mechanism, and this trap has now
-- been documented twice.
--
-- The fallback is a safety net, not a plan. Until this is applied, times are
-- local-only and do not reach a second device.
--
-- ── Additive only, per `P1` ──────────────────────────────────────────────
--
-- One new nullable column. No ALTER of an existing column, no rename, no drop.
--
-- The build plan proposed widening `due_date` into a full timestamp instead.
-- That is not available to us: `due_date` is `date NOT NULL`, every shipped
-- version of StudyDesk reads it, and old versions live on F-Droid
-- indefinitely. Changing its type would change what `due_date = <today>`
-- means in each of them — a silent, retroactive behaviour change on 317 live
-- rows across real accounts, which is exactly what `P1` exists to prevent.
--
-- With a separate column an older client is not merely safe, it is CORRECT:
-- it selects `*`, ignores the key it does not know, and shows the assignment
-- on the right day with no time — which is all it could honestly show.
--
-- ── Shape ────────────────────────────────────────────────────────────────
--
-- `time without time zone`: a wall-clock reading, the same decision
-- `commitments.start_time` records. An essay is due at 09:00 local, whatever
-- the UTC offset happens to be that week, so DST is a non-event here rather
-- than something every read has to be careful about. The date half is already
-- a `date` for the same reason; a `timestamptz` would have made the pair
-- disagree about what a deadline is.
--
-- NULL means "no time given", not midnight. The client treats that as
-- end-of-day when ordering (see src/lib/dueAt.js, which is the authority) —
-- because "due Friday" has always meant some time on Friday, and filing it at
-- 00:00 would sort it ahead of a 09:00 deadline the user actually typed.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- Unchanged, and nothing here weakens it: `assignments` already enforces
-- `user_id = auth.uid()` and adding a column to a table does not touch its
-- policies (`P2`).
--
-- ── Exams ────────────────────────────────────────────────────────────────
--
-- `exams.due_date` has the same limitation and is deliberately NOT changed
-- here. The issue asked about assignments; an exam time is the obvious
-- follow-on and is a second, identical migration when the client can use it.
-- Shipping an unused column now would be storage nobody reads and a schema
-- that promises a feature the app does not have.

alter table public.assignments
  add column if not exists due_time time;

comment on column public.assignments.due_time is
  'v1.14. Wall-clock time the assignment is due, or NULL for "no time given" — '
  'which the client orders as end-of-day, never midnight. Paired with due_date, '
  'which stays a `date`: an older client that does not know this column shows '
  'the correct day and no time. StudyDesk-only; NCC does not read assignments.';

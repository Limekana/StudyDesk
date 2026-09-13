-- StudyDesk v1.14 Item 7b (#51) — blockers that repeat every N weeks.
--
--   > "I also have obligations that are every 2 weeks, and the blockers can
--      only be weekly."
--
-- ── APPLIED 2026-09-13, on the owner's instruction ───────────────────────
-- Live as `v114_commitment_interval_weeks`. Verified after the fact:
-- `commitments.interval_weeks`, smallint, nullable, and the CHECK below is in
-- place as NOT VALID. RLS on `commitments` unchanged — still enabled, still 4
-- policies — and the security advisor reports nothing new.
--
-- `upsertCommitment` keeps its `upsertTolerant` wrapper for the same reason
-- the assignment migration beside this one gives: it is insurance against the
-- NEXT migration shipping after its client, not this one.
--
-- ── Additive only, per `P1` ──────────────────────────────────────────────
--
-- One new nullable column. No ALTER, no rename, no drop.
--
-- NULL means EVERY WEEK, which is what all 96 existing rows already mean, so
-- there is no backfill and no special case on read. An app version that
-- predates this column shows the blocker every week — too many, never too few,
-- which is the safe direction: a student plans around time they turn out to
-- have, instead of planning study into a training session.
--
-- ── Why an interval and not a parity ─────────────────────────────────────
--
-- `timetable_entries.week_parity` (v1.13) is odd/even counted from the TERM's
-- start, and that is right for a lesson: a lesson belongs to a term and a
-- student says "week A / week B" meaning of the term. A commitment belongs to
-- no term, so a parity would have nothing to anchor to — and a parity cannot
-- express "every third week", which a shift rota routinely is.
--
-- So the count runs from the commitment's own FIRST OCCURRENCE — the first
-- matching weekday on or after `starts_on`, not `starts_on` itself, which may
-- fall on a different weekday and would put the whole series half a week out
-- of phase. src/lib/commitments.js is the authority on that rule.
--
-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- Unchanged. `commitments` already enforces `user_id = auth.uid()` and adding
-- a column does not touch its policies (`P2`).

alter table public.commitments
  add column if not exists interval_weeks smallint;

-- Belt and braces on a column the client clamps anyway: a row asserting it
-- repeats every zero weeks has no meaning, and a one-off has no recurrence to
-- describe. Both are rejected here so a future client cannot write one.
alter table public.commitments
  add constraint commitments_interval_weeks_sane
  check (
    interval_weeks is null
    or (interval_weeks between 2 and 4 and weekday is not null)
  )
  not valid;

comment on column public.commitments.interval_weeks is
  'v1.14. Weeks between occurrences of a weekly commitment, or NULL for every '
  'week (which is also what every pre-v1.14 row means). Counted from the first '
  'matching weekday on or after starts_on, never from starts_on itself. '
  'StudyDesk-only; NCC does not read this table.';

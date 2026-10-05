-- v1.17 (limecore#17) — users see what happened to their feedback, and can no
-- longer read our triage notes on it.
--
-- ── The gap this closes ──────────────────────────────────────────────────────
--
-- `feedback_select_own` lets a user read their own rows, and Supabase grants
-- SELECT on the whole table to `authenticated` by default. That was harmless
-- while the table held only what the user wrote. `status`, `triage_note` and
-- `triaged_at` were added later for the owner's triage, and the table-wide
-- grant handed them out too: any user could read the internal note on their
-- own report (issue numbers, out-of-scope reasoning). Until this is applied,
-- write triage notes as if the user reads them.
--
-- The fix is a column grant, not a policy: RLS chooses rows, grants choose
-- columns. `authenticated` keeps SELECT on what the user sent plus `status`
-- and `shipped_in`, which StudyDesk now shows them. `triage_note`,
-- `triaged_at`, `platform` and `user_id` drop out. `anon` loses SELECT
-- entirely; with no session, RLS already gave it no rows.
--
-- ── P1: every shipped app version keeps working ──────────────────────────────
--
-- A client request that names a column it may not read fails as a whole, and
-- so does `INSERT ... RETURNING *`. Checked on 2026-10-05 across all 92 tags of
-- the three apps (33 StudyDesk, 34 NCC, 25 LimeLog):
--   - every feedback insert is a bare `.insert({...})`, with no `.select()`,
--     no upsert and no `return=representation`;
--   - the only read is StudyDesk's own list, v1.10 onwards, which names
--     `id, category, rating, message, created_at, app`, all still granted.
-- Tested against PostgREST 12 and 13 with this table, its policies and these
-- grants: the shipped insert and the shipped read both succeed afterwards,
-- and asking for `triage_note` or `*` fails (see the PR).
--
-- ── shipped_in ───────────────────────────────────────────────────────────────
--
-- "Shipped in v1.17" needs the version, and nothing records it today (it
-- lives, if anywhere, in the free-text note). Set it when marking a row
-- `shipped`; the app shows plain "Shipped" while it is null. Nullable and
-- additive, so no shipped client is affected.

alter table public.feedback
  add column if not exists shipped_in text
  check (shipped_in is null or char_length(shipped_in) <= 16);

revoke select on table public.feedback from anon, authenticated;

grant select (id, app, app_version, category, rating, message, created_at, status, shipped_in)
  on table public.feedback to authenticated;

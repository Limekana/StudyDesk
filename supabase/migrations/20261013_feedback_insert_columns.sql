-- v1.18.1 (limecore#63 §1) — users can no longer set the owner's triage
-- columns when they send feedback.
--
-- ── The gap this closes ──────────────────────────────────────────────────────
--
-- Supabase grants INSERT on the whole table to `anon` and `authenticated` by
-- default. `feedback_insert_own` checks only `user_id`, so a hand-made request
-- could send a report already marked `status = 'shipped'` or 'declined', with
-- a `triage_note`, `triaged_at` or `shipped_in` of its choosing. Those are the
-- owner's columns (20261005_feedback_status_columns.sql shows `status` and
-- `shipped_in` back to the user in StudyDesk).
--
-- RLS chooses rows, grants choose columns, as in 20261005: `authenticated`
-- keeps INSERT on what a report is made of and nothing else. `anon` loses
-- INSERT; with no session, `feedback_insert_own` (user_id = auth.uid())
-- already refused every row. `created_at` and `status` take their defaults.
-- UPDATE and DELETE need no change: there is no policy for either, so RLS
-- refuses them for every row.
--
-- ── P1: every shipped app version keeps working ──────────────────────────────
--
-- Checked on 2026-10-13 across every tag of the three apps (34 StudyDesk,
-- 35 NCC, 26 LimeLog): each version that sends feedback (15, 11 and 9 of
-- them) inserts exactly id, user_id, app, app_version, platform, category,
-- rating and message, as a bare `.insert({...})` (no upsert, no RETURNING;
-- see 20261005). The rest have no feedback form.
--
-- Revoking the table-level privilege also revokes it on every column, so the
-- column grant below is the whole of what remains.
--
-- NOT APPLIED. The owner applies it. Idempotent: safe to run twice.

revoke insert on public.feedback from anon, authenticated;

grant insert (id, user_id, app, app_version, platform, category, rating, message)
  on public.feedback to authenticated;

-- Check afterwards (expect exactly the eight columns, for authenticated only):
--   select grantee, column_name from information_schema.column_privileges
--   where table_schema = 'public' and table_name = 'feedback'
--     and privilege_type = 'INSERT' order by 1, 2;

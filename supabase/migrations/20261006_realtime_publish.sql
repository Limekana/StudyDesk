-- limecore#24, step 2 of 2 — publish every table a shipped client binds to a
-- Realtime channel. APPLY ONLY AFTER step 1 (20261006_realtime_echo_guard.sql)
-- is live: without it, publishing starts an echo loop on every StudyDesk
-- <=1.15.0 install.
--
-- Why live sync has been dead: `supabase_realtime` carried 16 tables, but
-- StudyDesk's channel binds 14 tables (11 unpublished) and NCC's binds 18 (3
-- unpublished). The Realtime server inserts a channel's bindings in one
-- transaction and rejects the WHOLE channel, without retrying, if any table is
-- missing from the publication. So neither app has received a single change
-- event since StudyDesk v1.7 / NCC v1.2.1.
--
-- P2: all 14 tables have RLS enabled, an owner-only SELECT policy
-- (`auth.uid() = user_id`) and default replica identity. Realtime applies RLS
-- per subscriber for INSERT and UPDATE; a DELETE event carries only the
-- primary key, as on the 16 tables already published. Nothing new is exposed.
--
-- The list is the union of both channels, so it doubles as the reference the
-- apps' recurrence tests read: a table bound in code but missing here fails CI.
-- Adding an already-published table is skipped, so re-running is harmless.

do $$
declare
  t text;
begin
  foreach t in array array[
    -- StudyDesk's channel (src/lib/sync.js startRealtime)
    'subjects', 'grades', 'study_sessions', 'assignments', 'exams', 'study_actions',
    'planned_sessions', 'academic_terms', 'timetable_entries', 'assignment_attachments',
    'commitments', 'notebook_entries', 'notebook_attachments', 'lesson_attendance',
    -- NCC's channel (src/lib/realtime.ts), minus the three above
    'transactions', 'portfolio_holdings', 'workout_sessions', 'workout_sets',
    'portfolio_lots', 'manual_assets', 'watchlist_items', 'goals',
    'habits', 'habit_completions', 'body_metrics',
    'budget_categories', 'budget_category_shares', 'tasks', 'task_shares'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

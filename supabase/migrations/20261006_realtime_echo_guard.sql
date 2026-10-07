-- limecore#24, step 1 of 2 — stop Realtime echo loops BEFORE the tables are
-- published (step 2: 20261006_realtime_publish.sql).
--
-- The loop. StudyDesk <=1.15.0 re-pushes any row whose `updatedAt` moves, a
-- pulled one included: the v1.7 push reconciler (assignments, exams,
-- study_actions) and the note autosave (notebook_entries). Those versions stamp
-- the PUSH time, so the echo of each push carries a newer stamp than the client
-- holds, the merge adopts it, and the client pushes the same row again. With a
-- live channel that repeats every few seconds per changed row, for as long as
-- the app is open. The channel has been dead since v1.7 (it binds unpublished
-- tables), which is the only reason this never happened. About half of
-- StudyDesk's weekly users still run <=1.15.0 (app_opens, 2026-10-06: 80 of
-- 157), and F-Droid installs never update by themselves.
--
-- The guard. An UPDATE that changes nothing but `updated_at` writes no row: the
-- trigger returns NULL. No new row version means no WAL record, so no Realtime
-- event, so the loop stops after one redundant push, on every installed
-- version. It also swallows an UPDATE that set_updated_at() has turned back
-- into the stored row (a stale last-writer-wins loser), which would otherwise
-- write an identical row and wake every subscriber for nothing.
--
-- Attached to every table a shipped client binds to a Realtime channel:
-- StudyDesk's 14 and NCC's 18, 29 distinct. The trigger is named `zz_...`
-- because Postgres fires BEFORE triggers in name order, and this one must see
-- NEW after set_updated_at() (and the habits/body_metrics variants) stamped it.
--
-- What changes for clients: a no-op UPDATE now affects 0 rows instead of 1.
-- Checked against every shipped tag of all three apps (2026-10-06): no write
-- to these tables reads its result back (`.select()` after `.update()` or
-- `.upsert()` appears only for `profiles`, which is not on this list). The
-- AFTER audit_trigger on tasks, budget_categories and the two share tables no
-- longer logs an update that changed nothing.
--
-- `drop trigger if exists` first, so re-running this is harmless.
-- Tested against Postgres 17 before review: supabase/tests/realtime_echo_guard.test.sql.

create or replace function public.skip_noop_update()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;
  return new;
end;
$$;

comment on function public.skip_noop_update() is
  'limecore#24: BEFORE UPDATE guard that drops an update changing nothing but updated_at, so it produces no Realtime event. Attached as zz_skip_noop_update.';

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
    execute format('drop trigger if exists zz_skip_noop_update on public.%I', t);
    execute format(
      'create trigger zz_skip_noop_update before update on public.%I '
      'for each row execute function public.skip_noop_update()',
      t
    );
  end loop;
end;
$$;

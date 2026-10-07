-- limecore#24 — stand-ins for the 29 Realtime-bound tables, so the two
-- 20261006_realtime_* migrations can run on a throwaway Postgres. Every table
-- gets the same shape and the BEFORE UPDATE triggers production has on it, by
-- production's names: the guard has to sort after all of them.
-- Load after 20260925_lww_clamp_delete_wins.sql (it defines set_updated_at()).

create publication supabase_realtime;

create function public.stamp_now() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;          -- habits / body_metrics
create function public.pass_through() returns trigger language plpgsql as $$
begin return new; end $$;                                   -- protect_softdelete stand-in

do $$
declare
  t text;
begin
  foreach t in array array[
    'subjects', 'grades', 'study_sessions', 'assignments', 'exams', 'study_actions',
    'planned_sessions', 'academic_terms', 'timetable_entries', 'assignment_attachments',
    'commitments', 'notebook_entries', 'notebook_attachments', 'lesson_attendance',
    'transactions', 'portfolio_holdings', 'workout_sessions', 'workout_sets',
    'portfolio_lots', 'manual_assets', 'watchlist_items', 'goals',
    'habits', 'habit_completions', 'body_metrics',
    'budget_categories', 'budget_category_shares', 'tasks', 'task_shares'
  ] loop
    execute format(
      'create table public.%I (id int primary key, user_id uuid, content text, '
      'updated_at timestamptz, deleted_at timestamptz)', t);
  end loop;
end $$;

-- Production's trigger names (2026-10-06), BEFORE UPDATE only.
create trigger subjects_updated_at before insert or update on public.subjects for each row execute function public.set_updated_at();
create trigger grades_updated_at before insert or update on public.grades for each row execute function public.set_updated_at();
create trigger set_study_sessions_updated_at before insert or update on public.study_sessions for each row execute function public.set_updated_at();
create trigger transactions_updated_at before insert or update on public.transactions for each row execute function public.set_updated_at();
create trigger portfolio_holdings_updated_at before insert or update on public.portfolio_holdings for each row execute function public.set_updated_at();
create trigger workout_sessions_updated_at before insert or update on public.workout_sessions for each row execute function public.set_updated_at();
create trigger budget_categories_updated_at before insert or update on public.budget_categories for each row execute function public.set_updated_at();
create trigger budget_categories_protect_softdelete before update on public.budget_categories for each row execute function public.pass_through();
create trigger tasks_updated_at before insert or update on public.tasks for each row execute function public.set_updated_at();
create trigger tasks_protect_softdelete before update on public.tasks for each row execute function public.pass_through();
create trigger habits_set_updated_at before update on public.habits for each row execute function public.stamp_now();
create trigger body_metrics_set_updated_at before update on public.body_metrics for each row execute function public.stamp_now();
do $$
declare
  t text;
begin
  foreach t in array array[
    'assignments', 'exams', 'study_actions', 'planned_sessions', 'academic_terms',
    'timetable_entries', 'assignment_attachments', 'commitments', 'notebook_entries',
    'notebook_attachments', 'lesson_attendance', 'portfolio_lots', 'manual_assets',
    'watchlist_items', 'goals'
  ] loop
    execute format('create trigger %I before insert or update on public.%I '
                   'for each row execute function public.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

-- Already published in production (with `readings`, which no channel binds).
alter publication supabase_realtime add table
  public.budget_categories, public.budget_category_shares, public.goals, public.grades,
  public.manual_assets, public.portfolio_holdings, public.portfolio_lots, public.study_sessions,
  public.subjects, public.task_shares, public.tasks, public.transactions, public.watchlist_items,
  public.workout_sessions, public.workout_sets;

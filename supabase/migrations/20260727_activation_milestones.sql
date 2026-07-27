-- Funnel instrumentation — activation milestones on profiles.
--
-- NOT APPLIED. This file is prepared for review; schema changes need explicit
-- sign-off before they run against the production database.
--
-- Why columns rather than an analytics SDK: F-Droid's inclusion policy forbids
-- proprietary tracking and analytics libraries by name (Google Play Services,
-- Firebase, Crashlytics). Adding one would be an actual removal risk. Three
-- timestamps in our own database answer the same question, involve no third
-- party, need no consent banner, and keep the FOSS story intact.
--
-- What it answers: of the users who create an account, how many reach each step
-- and how long it takes. Today the funnel reads 142 accounts -> 29 subjects ->
-- 4 grades -> 4 sessions, and there is no way to tell whether the 80% who never
-- create a subject bounced at onboarding, got lost, or are content in guest
-- mode.
--
-- Deliberately NOT event logging: one nullable timestamp per milestone, set once
-- and never updated. No behavioural stream, no per-action history, nothing that
-- could reconstruct what a specific student was doing at a specific time. It is
-- the minimum that answers the question, which is also what data minimisation
-- (GDPR Art. 5(1)(c)) asks for.

alter table public.profiles
  add column if not exists first_subject_at timestamptz,
  add column if not exists first_grade_at   timestamptz,
  add column if not exists first_session_at timestamptz;

comment on column public.profiles.first_subject_at is
  'When this user first created a subject. Activation funnel; set once, never updated.';
comment on column public.profiles.first_grade_at is
  'When this user first logged a grade. Activation funnel; set once, never updated.';
comment on column public.profiles.first_session_at is
  'When this user first logged a study session. Activation funnel; set once, never updated.';

-- Set the milestone from the row's own insert, server-side, so it cannot be
-- backdated or spoofed by a client and does not need a round trip.
-- coalesce(...) means the first write wins and later ones are no-ops.
create or replace function public.mark_activation_milestone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'subjects' then
    update public.profiles
       set first_subject_at = coalesce(first_subject_at, now())
     where id = new.user_id;
  elsif tg_table_name = 'grades' then
    update public.profiles
       set first_grade_at = coalesce(first_grade_at, now())
     where id = new.user_id;
  elsif tg_table_name = 'study_sessions' then
    update public.profiles
       set first_session_at = coalesce(first_session_at, now())
     where id = new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activation_subject on public.subjects;
create trigger trg_activation_subject
  after insert on public.subjects
  for each row execute function public.mark_activation_milestone();

drop trigger if exists trg_activation_grade on public.grades;
create trigger trg_activation_grade
  after insert on public.grades
  for each row execute function public.mark_activation_milestone();

drop trigger if exists trg_activation_session on public.study_sessions;
create trigger trg_activation_session
  after insert on public.study_sessions
  for each row execute function public.mark_activation_milestone();

-- Backfill from data already present, so the existing 142 accounts are not a
-- blind spot. Uses each row's own created_at rather than now().
update public.profiles p
   set first_subject_at = s.first_at
  from (select user_id, min(created_at) as first_at from public.subjects group by 1) s
 where s.user_id = p.id and p.first_subject_at is null;

update public.profiles p
   set first_grade_at = g.first_at
  from (select user_id, min(created_at) as first_at from public.grades group by 1) g
 where g.user_id = p.id and p.first_grade_at is null;

update public.profiles p
   set first_session_at = ss.first_at
  from (select user_id, min(created_at) as first_at from public.study_sessions group by 1) ss
 where ss.user_id = p.id and p.first_session_at is null;

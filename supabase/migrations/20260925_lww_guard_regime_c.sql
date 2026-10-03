-- limecore#27 (P0-A), step 2 of 2 — extend the last-writer-wins guard to the
-- tables that have none.
--
-- 12 client-synced tables have an `updated_at` column but no trigger at all, so
-- today the LAST PUSH wins on them: a snapshot queued offline at 10:00 and
-- pushed at 12:00 overwrites an 11:00 edit from another device, with no error.
-- That is the data loss limecore#27 was filed for (assignments, exams, notes,
-- attendance, timetable, planned sessions, commitments...). Attaching the
-- guard from step 1 gives them the same rules as the other 15: clamp, delete
-- wins, everything else last-writer-wins.
--
-- APPLY WITH THE CLIENT RELEASE, NOT BEFORE. On these tables every shipped
-- client stamps PUSH time, so until clients send EDIT time this changes almost
-- nothing — and it adds one small regression: a device whose clock runs BEHIND
-- can lose a push it used to win. The same hazard already exists on the 15
-- guarded tables. Clients that stamp `max(deviceNow, lastSeen + 1 ms)` (the
-- v1.16 client half of this decision) remove it for any edit made after
-- seeing the row.
--
-- Deliberately NOT attached:
--   * supporter_entitlements — written server-side by the Ko-fi pipeline;
--   * user_preferences — one row of flags per user, no deleted_at, no
--     conflicting edits worth arbitrating;
--   * habits, body_metrics — they stamp server `now()` on every update (push
--     order wins). Left as they are by the 2026-09-25 decision.
--
-- `drop trigger if exists` first, so re-running this is harmless.
-- Tested against Postgres 17 before review: supabase/tests/lww_guard.test.sql.
-- APPLIED to production 2026-09-26 (owner-confirmed) as `v116_lww_guard_regime_c`, version 20260926102128.

do $$
declare
  t text;
begin
  foreach t in array array[
    'academic_terms',
    'assignment_attachments',
    'assignments',
    'braindump_entries',
    'commitments',
    'exams',
    'lesson_attendance',
    'notebook_attachments',
    'notebook_entries',
    'planned_sessions',
    'study_actions',
    'timetable_entries'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

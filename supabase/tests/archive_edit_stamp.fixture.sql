-- StudyDesk#163 — gives the realtime_echo_guard fixture's stand-in `subjects`
-- the column the archive guard reads. Load after that fixture and before
-- 20261016_archive_edit_stamp.sql.

alter table public.subjects add column archived_at timestamptz;

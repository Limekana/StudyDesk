-- StudyDesk#163 — a semester archive/restore is decided by the time the user
-- made it, not the time it reached the server.
--
-- The bug. Since StudyDesk#145 an archive or restore writes only
-- `subjects.archived_at`, but it is stamped `updated_at` = PUSH time, because
-- an edit-time stamp would be declined by set_updated_at() whenever anything
-- else on the row is newer. A push-time stamp lets a stale change win:
--   1. device B restores a course at 11:00;
--   2. device A's offline archive from 10:00 is pushed at 12:00, stamped
--      12:00, and re-archives the course everywhere;
--   3. B's offline rename from 11:30 is pushed at 12:30 and declined, because
--      the row now carries A's 12:00 stamp.
--
-- The fix: the archive gets its own stamp.
--
--   * New nullable column `subjects.archived_edited_at`: when the user last
--     archived or restored the course. StudyDesk >= 1.18.1 sends it with every
--     archive/restore, stamped at the edit.
--
--   * New BEFORE INSERT OR UPDATE trigger `subjects_archive_edit_stamp`. It
--     must see the write before set_updated_at() can decline it, and Postgres
--     fires same-event triggers in name order:
--         subjects_archive_edit_stamp   (this one)
--         subjects_updated_at           set_updated_at(): clamp, delete wins, LWW
--         zz_skip_noop_update           drops a write that changes nothing
--     Its rules, for a write that changes the archive:
--       (a) A change older than the stored `archived_edited_at` is ignored:
--           the row keeps its archived_at and archived_edited_at. Anything
--           else in the same write is left to set_updated_at() as before.
--           An archive-only write that loses here changes nothing, so
--           zz_skip_noop_update drops it (0 rows).
--       (b) An archive-only write that wins moves `updated_at` to the stored
--           value + 1 ms, whatever the client sent. +1 ms so every client,
--           whose merge adopts only a STRICTLY newer row, picks the archive
--           up; no more, so it never declines a content edit (rename, colour,
--           credits) made after the stored version. Content keeps plain
--           last-writer-wins on `updated_at`; the archive is last-writer-wins
--           on `archived_edited_at`. In the scenario above A's 10:00 archive
--           is ignored (B's restore is newer) and B's 11:30 rename lands.
--     Deletes are untouched: this trigger passes a tombstone through as it
--     came, to set_updated_at()'s delete-wins rule, and an archive-only write
--     never changes deleted_at, so it can neither delete nor revive a row.
--
-- P1 / shipped versions. No shipped client (StudyDesk <= 1.18.0, any NCC)
-- sends `archived_edited_at`, so in their UPDATEs it equals the stored value.
-- That is how this trigger tells them apart: for such a "legacy" write the
-- archive is stamped with the write's own `updated_at` (clamped), exactly as
-- it always rode on it, and set_updated_at() decides the row as today. On a
-- row no 1.18.1 client has stamped, the stored stamp only ever comes from such
-- writes and is never newer than the row, so (a) never fires before
-- set_updated_at() would decline the write anyway: behaviour is unchanged.
-- On a row a 1.18.1 client stamped, a legacy write whose own stamp is OLDER
-- than that archive stamp (NCC pushes archived_at with every course edit)
-- keeps the stored archive and still lands its other columns. A legacy write
-- stamped AFTER the archive, but made from a copy that has not seen it, still
-- puts its stale archived_at back: the server cannot tell a stale value from
-- a deliberate one without a stamp (NCC side: NCC#180). Old clients also
-- still stamp push time, so their late archive can still win. Errors: none —
-- a declined change is a silent no-op, as every LWW decline already is.
--
-- Accepted limit: StudyDesk <= 1.18.0 adopts a pulled row only when its
-- updated_at is STRICTLY newer than the local copy's. If a +1 ms archive stamp
-- happens to equal that build's local stamp for the row, it shows the old
-- archive state until the next newer write to the row. 1.18.1 merges the
-- archive on its own stamp and is not affected.
--
-- StudyDesk 1.18.1 falls back to the 1.18.0-era write when the column is
-- missing, so the client and this migration can ship in either order; the
-- fix takes effect once both are in place.
--
-- Idempotent: `add column if not exists`, `create or replace function`,
-- `drop trigger if exists`. set_updated_at() is not changed.
--
-- Tested against Postgres 16 (local throwaway cluster) before review:
-- supabase/tests/archive_edit_stamp.test.sql.
-- NOT APPLIED. The owner applies it.
--
-- Check afterwards (expect the three triggers in this order, and the column):
--   select tgname from pg_trigger
--    where tgrelid = 'public.subjects'::regclass and not tgisinternal
--      and tgtype & 2 = 2            -- BEFORE
--    order by tgname;
--   -- subjects_archive_edit_stamp, subjects_updated_at, zz_skip_noop_update
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'subjects'
--      and column_name = 'archived_edited_at';
--   -- archived_edited_at | timestamp with time zone | YES

alter table public.subjects add column if not exists archived_edited_at timestamptz;

comment on column public.subjects.archived_edited_at is
  'StudyDesk#163: when the user last archived or restored this course (edit time, not push time). The archive is last-writer-wins on this stamp; see subjects_archive_edit_stamp().';

create or replace function public.subjects_archive_edit_stamp()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  stamped boolean;
  incoming timestamptz;
begin
  -- Clamp, as set_updated_at() does for updated_at: a stamp from the future
  -- would lock the archive against every other device.
  if new.archived_edited_at > now() then
    new.archived_edited_at := now();
  end if;

  if tg_op = 'INSERT' then
    -- A course born archived by a writer that sends no stamp (PastCourseModal,
    -- the 1.18.0 insert path, NCC): the archive dates from the insert's own
    -- stamp, so a later stale archive change cannot undo it. On an upsert
    -- that hits an existing row this only touches the proposed row; the
    -- DO UPDATE sets only the columns the client sent.
    if new.archived_at is not null and new.archived_edited_at is null then
      new.archived_edited_at := least(coalesce(new.updated_at, now()), now());
    end if;
    return new;
  end if;

  -- A tombstone is set_updated_at()'s to decide (delete wins), whole.
  if old.deleted_at is null and new.deleted_at is not null then
    return new;
  end if;

  -- A 1.18.1+ archive/restore sends its own stamp. Every other write leaves
  -- the column as stored (or, if it names it, may not clear it).
  stamped := new.archived_edited_at is not null
             and new.archived_edited_at is distinct from old.archived_edited_at;

  if stamped then
    incoming := new.archived_edited_at;
  else
    new.archived_edited_at := old.archived_edited_at;
    if new.archived_at is not distinct from old.archived_at then
      return new;  -- the archive is not being changed
    end if;
    -- A legacy archive change: it rides on the write's own stamp, as before.
    incoming := least(coalesce(new.updated_at, now()), now());
  end if;

  -- (a) Older than the archive change already stored: keep the stored one.
  if old.archived_edited_at is not null and incoming < old.archived_edited_at then
    new.archived_at := old.archived_at;
    new.archived_edited_at := old.archived_edited_at;
    return new;
  end if;

  new.archived_edited_at := incoming;

  -- (b) An archive-only write moves the row stamp by the least amount every
  --     client will notice, so content edits keep last-writer-wins.
  --     If the stored updated_at is in the future (only rows from before the
  --     20260925 clamp; none were measured), set_updated_at() then clamps
  --     this to now(), which moves the row's stamp backwards. Rare and
  --     harmless to the archive, which is decided on its own stamp.
  if stamped
     and (to_jsonb(new) - 'archived_at' - 'archived_edited_at' - 'updated_at')
       = (to_jsonb(old) - 'archived_at' - 'archived_edited_at' - 'updated_at') then
    new.updated_at := old.updated_at + interval '1 millisecond';
  end if;

  return new;
end;
$function$;

comment on function public.subjects_archive_edit_stamp() is
  'StudyDesk#163: BEFORE INSERT OR UPDATE on subjects. Archive/restore is last-writer-wins on archived_edited_at; an archive-only write moves updated_at by 1 ms. Must sort before subjects_updated_at.';

drop trigger if exists subjects_archive_edit_stamp on public.subjects;
create trigger subjects_archive_edit_stamp
  before insert or update on public.subjects
  for each row execute function public.subjects_archive_edit_stamp();

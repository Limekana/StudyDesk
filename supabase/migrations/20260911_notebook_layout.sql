-- StudyDesk v1.13 follow-up — free placement in the Notebook.
--
-- Asked for directly: "the text boxes should be placeable where I want".
-- The notebook was a single column pinned at the margin rule; this lets a note
-- carry boxes at arbitrary positions, which is what a maths or physics
-- notebook page actually looks like.
--
-- ── NOT YET APPLIED ──────────────────────────────────────────────────────
-- Awaiting the owner's instruction, like 20260903_notebook.sql before it.
-- The client MUST NOT ship ahead of this one: `upsertNote` sends `layout` on
-- every note push, and PostgREST rejects an insert naming a column that does
-- not exist — which would fail the push for EVERY note, not just arranged
-- ones. Apply first, then tag.
--
-- ── Additive only, per `P1` ──────────────────────────────────────────────
--
-- One new nullable column. No ALTER of an existing column, no rename, no drop,
-- so no shipped app version can regress from applying it: v1.12 and v1.13 read
-- `content` and select `*`, and an unknown extra key in the row they get back
-- is ignored by `mergeNote`.
--
-- The compatibility that matters runs the other way, and it is deliberate:
-- `content` still holds the WHOLE note, in reading order, exactly as before.
-- The words never move into this column. An already-shipped version opening an
-- arranged note shows it as one column of text — every word present, only the
-- arrangement lost — rather than showing an empty note, which is what storing
-- the text here would have done to every install still on F-Droid.
--
-- Shape (see src/features/notebook/layout.js, which is the authority):
--
--   {
--     "v": 1,
--     "hash": "<FNV-1a of the joined box text, base 36>",
--     "boxes": [
--       { "id": "a1b2c3d4", "x": 0.05, "y": 56, "w": 0.56, "text": "..." }
--     ]
--   }
--
-- `x` and `w` are fractions of the page width so a note arranged on a phone
-- opens sensibly on a desktop; `y` is pixels on the 28px baseline grid so a
-- box's first line lands on a ruling rather than between two.
--
-- `hash` is what makes the duplicated text safe. Each box carries its own
-- copy, and `content` is derived from them — never parsed back — so the two
-- cannot drift into a garbled note the way line offsets into `content` would
-- the moment an older version inserted a line. When the hash does not match
-- the content column, the content column wins and the note opens as one box.
--
-- jsonb rather than text: it is queryable if a future feature needs to find
-- arranged notes, and Postgres validates it on write, so a truncated write
-- fails loudly here instead of arriving as an unparseable string on the next
-- device.
--
-- No index. Nothing filters or orders by this column — it is read only as part
-- of the note row it belongs to.

alter table public.notebook_entries
  add column if not exists layout jsonb;

comment on column public.notebook_entries.layout is
  'Free-placement box geometry for the notebook page. Nullable: null means an '
  'unarranged note, which is the ordinary case. NEVER the sole home of the '
  'note text - content always holds the whole note in reading order, so app '
  'versions that predate this column lose the arrangement and nothing else.';

-- RLS: nothing to do. `notebook_entries` already carries its policies from
-- 20260903_notebook.sql, and a policy is per ROW, not per column, so a new
-- column on an existing table inherits them. Stated rather than assumed
-- because `P2` makes "ships with RLS in the same migration" a rule, and the
-- reason this one adds no policy should be on the record.

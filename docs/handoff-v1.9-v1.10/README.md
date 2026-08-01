# Remote Work Handoff — v1.9 (SEC-1) + v1.10 (features) — StudyDesk

**Committed 2026-08-01.** You (a remote Claude Code instance, or Emil working
from elsewhere) don't have `Projects/CLAUDE.md` or `~/.claude/CLAUDE.md` —
that root sits above any single repo, so a clone of just this one doesn't
carry it. Everything load-bearing from it is restated below. Read this whole
file before touching code.

**Also read `docs/RECORD_OF_PROCESSING.md`, `docs/legal/*`, `PRIVACY.md`, and
`docs/LEGAL_REVIEW.md` if you're touching anything auth/data-related** — this
repo already carries the real compliance posture, don't re-derive it.

---

## Why this repo gets the most attention this pass

**StudyDesk is now the flagship product** (owner call, 2026-08-01, added to
the registry as standing priority `P4`): "it has seen greater growth I
couldve ever thought and has the biggest combination of value for me + large
potential userbase, here students." Where a sequencing choice exists between
StudyDesk and NCC/LimeLog, **StudyDesk goes first.** Five of the eight items
scoped this pass are StudyDesk items for exactly that reason — this is by far
the biggest handoff of the three.

## What this handoff covers

Two small milestones, both scoped 2026-08-01, neither tagged/released yet:

- **v1.9 — SEC-1 only.** A security decision (see `NEXUS_V19_BUILD_PLAN_SNAPSHOT.md`) about the shared Supabase project, not StudyDesk-specific code. Read it for context; nothing to build yet, needs the owner's sign-off on the recommended path first.
- **v1.10 — held-back features + housekeeping.** Full detail in `NEXUS_V110_BUILD_PLAN_SNAPSHOT.md`. **Your items in this repo, roughly in suggested sequence:**
  1. **Item 1** — assignment "type" as free text (already scoped once before, in v1.8, but never actually built — check the 1.6.0/1.6.1/1.6.2 changelogs yourself if you want to confirm before starting).
  2. **Item 5** — onboarding's "skip notifications" doesn't actually prevent the OS permission popup. Real bug.
  3. **Item 6** — bottom-tab icon redesign, alongside NCC. Prototype here first per `P4`.
  4. **Item 7** — guest-mode icon is a bare dot; replace with an Instagram-default-picture-style avatar pick, own visual spin.
  5. **Item 8 — the big one.** Two native Android home-screen widgets (Next Up + Calendar), using Jetpack Glance. This is real native Kotlin/Java work in `android/`, not a JS change — first native widget work anywhere in the suite. **Read this item in full before starting** — it covers the data-bridge design (a small Capacitor plugin snapshotting Dexie data into native storage), update strategy, and sizing. Scoped as its own likely-separate release given the size, not bundled with items 1/5/6/7.
  9. **Item 9 (partial)** — a simple "Support development" link to Ko-fi from a settings screen. No API, just a link — the Stripe/Ko-fi connection itself is already live, verified this session.

`NEXUS_VERSION_STATUS_SNAPSHOT.md` is the full cross-app registry — read it for NCC/LimeLog's status and the standing P1–P4 priorities.

---

## Standing priorities (P1–P4 from the registry — these do not expire)

- **P1 — real user data.** No destructive DDL against production without a backup first. Additive-only migrations. Old app versions stay in the wild indefinitely via F-Droid — every schema change must stay backward-compatible. Migrations go through `apply_migration`, never ad-hoc SQL. This repo already added three tables (`assignments`/`exams`/`study_actions`) in v1.6.1 following exactly this discipline — match that pattern if Item 8's data bridge ends up needing any new local storage shape (it shouldn't need a Supabase schema change, but check your assumptions against this rule regardless).
- **P2 — RLS is load-bearing.** Any new table ships with RLS + policy in the same migration. Re-run `get_advisors(type: security)` after every DDL change.
- **P3 — activation.** Real signups, real activation tracking — see the snapshot for current numbers.
- **P4 — you are the flagship product.** See above.

## Git flow (restated from `CLAUDE.md` §4, updated 2026-08-01)

- `main` (sacred, release tags only) ← `develop` (integration) ← `feature/*` (cut from develop, `--no-ff` merge).
- **Promotion to `main` is PR-only** as of 2026-07-30 — this repo is branch-protected (required status check, 0-approval PRs, `enforce_admins: true`, force-push/deletion blocked). A direct local `git checkout main && git merge --no-ff develop && git push` is rejected outright. Actual flow: push `develop` → open a PR `develop → main` → CI runs → merge (0 approvals needed) → tag. Tags are unaffected by branch protection.
- Hotfixes: `main` → `hotfix/*` → `main` (tag, via PR) + back-merge to `develop`.
- Commits: Conventional (`feat:`, `fix:`, `chore:`), explicit version bump in the commit message.

## Build gate (restated from `CLAUDE.md` §1)

- StudyDesk: `npm run build` && `npm run lint` (JS-only, lint is a **strict** pre-release gate — don't skip it).
- **F-Droid auto-update note:** StudyDesk's fdroiddata recipe is merged into `fdroid/fdroiddata` master. A new tag + GitHub Release with a signed `StudyDesk-X.Y.Z.apk` is the *entire* release flow now — no MR. But `AutoUpdateMode: Version` clones the previous recipe verbatim, so there's **no MR review to catch a regression.** Before tagging *anything*, re-verify section A of `fdroid/FDROID_RELEASE_CHECKLIST.md` yourself (`dependenciesInfo`, signing config ordering, Supabase env fallback, self-hosted fonts, no GMS). This has bitten the project before.
- **`versionCode` must increment on every release** or F-Droid's auto-update silently no-ops with no error anywhere — this exact mistake already happened once (fixed via v1.6.0's vc14 bump).

## Shared Data Architecture (restated from `CLAUDE.md` §2)

- Database: Supabase (`hkktorzhaqnfqsnlstda`). UUID primary keys; RLS `user_id = auth.uid()` required on every table.
- Ownership Matrix: **StudyDesk owns `subjects`, `grades`, `study_sessions`, `assignments`, `exams`, `study_actions`** (the last three added 2026-07-30, StudyDesk-only, NCC doesn't read them). LimeLog owns `workout_sessions`/`sets`. NCC is read-only for sessions, read+upsert (LWW) for subjects/grades.
- Item 1 (assignment type as free text) touches `assignments`, which NCC does **not** currently read — low cross-app risk, but confirm that's still true before assuming it.
- **Any schema DDL requires explicit user approval before running migrations, and must update every consumer app.**

## Hard forbidden actions (restated from `CLAUDE.md` §5)

- Do not run git commits inside a sandboxed execution shell (causes blob truncation) — commit from a real machine shell.
- Do not read, print, or commit `.env` or secret keys.
- Do not force-push, `git reset --hard`, or rewrite branch history.
- Do not deploy/push `limecore-site` without explicit user confirmation (not this repo, but applies suite-wide if you touch that one too).

---

*This bundle: `README.md` (this file) + three snapshot files, taken 2026-08-01 from `D:\emilh\Projects\limecore\`. They will drift from the live registry over time — treat them as a starting point, not a live source, if this handoff is still in use more than a couple of weeks out.*

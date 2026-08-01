# NEXUS v1.10 Build Plan — Held-Back Features + StudyDesk Push + Housekeeping

**Milestone:** `v1.10` — held-back braindump features, new StudyDesk-flagship items, Ko-fi/Stripe, AUTH-2, housekeeping
**Registry:** `Nexus_Version_Status.md`
**Prior:** v1.9 (SEC-1 decision — see `NEXUS_V19_BUILD_PLAN.md`)
**Origin:** Obsidian braindump (`02 - Nexus OS Suite braindump.md`) — first pass 2026-07-26 (4 items), second pass 2026-08-01 after the note finally synced from phone (5 more items + a strategic call), plus loose ends carried from v1.8/v1.9 that were never closed out.
**Numbering note:** this content was originally scoped as v1.9 on 2026-08-01; SEC-1 took that slot instead the same day, bumping this to v1.10.

---

## Strategic framing — read this before sequencing anything below

**StudyDesk is now the flagship product** (owner call, 2026-08-01): "it has
seen greater growth I couldve ever thought and has the biggest combination of
value for me + large potential userbase, here students." This isn't a task,
it's a standing reprioritization — also added to the registry's permanent
priorities as `P4`. Concretely for this milestone: where an item below could
go to StudyDesk, NCC, or LimeLog and there's a sequencing choice to make,
**StudyDesk goes first.** Three of the five newly-added items this pass are
StudyDesk-specific for exactly this reason.

---

## Item 1 — StudyDesk: assignment "type" as free text

*(Carried from the original 2026-07-26 braindump pass — unchanged, still not built.)*

**Source:** StudyDesk GitHub comment. "It would be good to be able to add
anything we want in the 'type' when we add an assignment. At the current
time, we can just put 'Other' and if it's possible, I want to put anything in
place of a specific element."

**Status:** CTO-scoped into v1.8's release on 2026-07-26 but does not appear
in the 1.6.0, 1.6.1, or 1.6.2 changelogs — not actually built. Carrying
forward unchanged.

**Scope.** Replace the closed type enum (presets + "Other", no way to say
what "Other" means) with a field that accepts a custom label.

**Before scoping as trivial:** confirm NCC's read side (`subjects`/`grades`
are the only StudyDesk tables NCC consumes — `assignments` is not currently
in that list per the Cross-App Dependency Matrix) has no dependency on the
fixed enum.

---

## Item 2 — NCC: Life/Fitness composite score reads low mid-week

*(Carried from 2026-07-26, unchanged.)*

**Source:** braindump. Score reads low mid-week even when the user is
exactly on pace for a "perfect" week.

**Diagnosis.** Score appears to compute `completed / weekly-target` with no
time-of-week adjustment.

**Fix direction.** Pace-adjust against expected-by-elapsed-time-in-the-week,
capping at 100 once the weekly target is met early.

**Not yet started:** locate the exact composite-score source file first.

---

## Item 3 — NCC: fitness weekly target needs to flex, not just change

*(Carried from 2026-07-26, unchanged — open design question not resolved.)*

**Source:** braindump. Hardcoded 3-workouts-per-week target doesn't fit a
user training 4+×/week normally, and doesn't flex down for sick/injured weeks.

**Open design question — still undecided:**

| Option | Shape | Trade-off |
|---|---|---|
| A. Static per-user baseline | One number in Life Profile settings | Simple, can't flex per-week |
| B. Baseline + ad-hoc per-week override | Baseline default + optional weekly adjustment | Matches the braindump's framing, bigger feature |

**Overlap, decide once:** same shape as the Habits weekly-goal backlog note
(`habits.ts`, e.g. "150 min exercise/week" vs. fixed daily amount) in the
still-not-started Growth hub plan.

---

## Item 4 — LimeLog: distinct cardio-logging flow (run/cycle/swim)

*(Refined 2026-08-01 — CTO asked for clarification, user confirmed: a
distinct lightweight cardio flow, not a type tag on the existing UI.)*

**Source:** braindump, clarified directly by the user afterward: "I meant
with it that I could log like when I go for a run or a cycle or a swim etc."
— not a generic "Other" bucket layered onto the existing strength-training
logging screen.

**Why this is a distinct flow, not a tag.** LimeLog's current logging model
is built around `workout_sessions` + child `sets` rows (exercise/weight/reps)
— that's a strength-training shape. A run or swim doesn't have sets and reps;
it has duration, and optionally distance. Tagging a strength session as
"Run" wouldn't give it anywhere sensible to put that data. This needs its own
minimal logging screen: pick an activity type (run/cycle/swim/basketball/
other), enter duration (+ distance where it makes sense — run/cycle/swim, not
basketball), save as a `workout_sessions` row with **no** child `sets` rows.

**Schema — now fairly confident, not just "maybe":** additive nullable
columns on `workout_sessions` (e.g. `activity_type`, `duration_seconds`,
`distance_meters`), populated only for cardio-type sessions and left null for
existing strength sessions. Additive-only, satisfies `P1`'s backward-
compatibility rule for old app versions still in the wild. **Still requires**
a migration file, updates to every consuming app, and explicit confirmation
before any `apply_migration`/DDL per `CLAUDE.md` §2's Data Contract — this is
a real schema change now, not a hypothetical.

**Open question, not yet checked — verify before estimating NCC-side work:**
does NCC's fitness score already count all `workout_sessions` rows regardless
of type, or does it filter to sessions that have `sets`? If it filters,
NCC-side logic needs a corresponding change to count populated cardio
sessions too — this is now the main remaining unknown, not whether LimeLog
needs new fields (it does).

---

## Item 5 — StudyDesk: onboarding notification permission still fires after skip

**Source:** new, from the braindump's second sync (brother's feedback,
2026-08-01). "Studydesk onboarding skip notification phase still triggers
notification permission pop up."

**What this means:** onboarding has a step that lets the user skip enabling
notifications, but the OS-level permission prompt fires anyway — the skip
isn't actually preventing the request, just the app's own framing of it. Real
bug, not a design question — find where the permission request is triggered
relative to the skip action and gate it properly.

---

## Item 6 — Icon redesign: StudyDesk + NCC bottom tabs (not LimeLog)

**Source:** new, brother's feedback + the user's own follow-up in the same
braindump pass. "Bottom tab icons 'ugly', test no icons but bigger text or
better icons" (StudyDesk) and, separately: "Same thing for bottom tab icons
onto NCC for production. One feature branch could be to test some better
icons for ncc and studydesk because LimesLogs ones i like and its
inconsistent when only one of the apps is different like that."

**Scope.** A single feature branch exploring bottom-tab icon treatment for
**StudyDesk and NCC only** — LimeLog's icons are already liked and are the
bar the other two should be brought up to (or a shared alternative found).
Two directions to prototype per the feedback: (a) drop icons, use bigger text
labels instead, or (b) better icon set. Try both, pick per app if they don't
converge on one answer — no requirement that all three apps end up visually
identical, just that StudyDesk and NCC stop being the two "off" ones next to
LimeLog.

**Given `P4`:** prototype on StudyDesk first.

---

## Item 7 — StudyDesk: guest-mode profile icon

**Source:** new, brother's feedback. "Top right icon for guest shows only a
dot, would be cooler to have like an anonymous type profile pick like the
instagram default profile pick but bit of an own spin to it."

**Scope.** Replace the current bare-dot guest indicator with a pick of
anonymous-style avatar options (Instagram-default-picture pattern) with
Limecore's own visual spin rather than a direct copy. StudyDesk-primary per
the feedback; worth a quick check whether NCC/LimeLog have an analogous guest
indicator worth the same treatment for consistency (per the `P4` /
icon-consistency theme in Item 6), but not scoped there unless that check
turns up the same "ugly/inconsistent" complaint.

---

## Item 8 — StudyDesk: Android home-screen widgets (multiple)

**Source:** [github.com/Limekana/StudyDesk/issues/3](https://github.com/Limekana/StudyDesk/issues/3), "Widgets !", opened by a real external user (`4vesangelion`, Jul 25, 2026), read directly (no comments, no labels): "it'd be really nice if there's a widget where people can see the plan/assignments in their homescreen without needing to open the app:)"

**Scope correction from the braindump's paraphrase:** this is specifically an
**Android home-screen widget** (glanceable, outside the app, on the OS home
screen) — not an in-app dashboard widget. Confirmed via research: no
maintained Capacitor plugin for Android home-screen widgets surfaced, so this
is native Android code living in `android/app/src/main/kotlin/` (or `java/`),
using **Jetpack Glance** (Google's current recommended approach — declarative,
Compose-like, supersedes hand-rolled `RemoteViews`/`AppWidgetProvider`). First
native-widget work anywhere in the Capacitor-based Nexus suite.

**User wants a proper multi-widget offering, not one minimal widget** ("A more
thought out complete widget, maybe multiple to choose from, one calendar, one
next up etc.") — scoping two to start, both reusing the same data snapshot:

1. **"Next Up" widget** — mirrors the app's core Next Up suggestion logic in
   compact form. Highest value: it's the same thing the app already considers
   most important, just glanceable.
2. **"Calendar" widget** — upcoming assignments/exams laid out chronologically
   (week or month view depending on Android widget size chosen), for the "when
   is stuff due" question the Next Up widget doesn't answer as directly.

Both should support at least a small and a medium Android widget size (Glance
supports responsive sizing via `SizeMode.Responsive`), and both are tap-to-
open into the relevant in-app screen.

**Technical approach.**
- **Data bridge:** the widgets can't read StudyDesk's Dexie/IndexedDB data
  directly (that lives inside the WebView). Need a small Capacitor plugin
  (or a thin native bridge) that the JS side calls whenever assignments/exams
  data changes (or on app foreground/background), writing a compact snapshot
  — e.g. next-up items and a short upcoming-deadlines list — into native
  storage (SharedPreferences or a tiny Room/SQLite table) that the Glance
  widgets read from. This makes both widgets "as fresh as the last time the
  app was open," which is a normal and acceptable pattern for this kind of
  data (assignments don't change minute-to-minute).
- **Update strategy:** call `updateAll`/`update` on the Glance widget(s) from
  the bridge whenever a new snapshot is written, rather than relying solely on
  Android's periodic `updatePeriodMillis` (minimum ~30 min) — keeps the widget
  current right after the user edits something in-app, with the periodic
  update as a fallback.
- **Sizing:** given both widgets, decide whether they're offered as two
  separate widget entries in Android's widget picker (simplest, most standard)
  vs. one widget with a user-facing "which view" toggle (more complex,
  probably not worth it for two views).

**Scope/effort flag:** this is a meaningfully bigger, more native-code-heavy
item than anything else in v1.10 — first native widget work in the suite, two
widget types instead of one, plus the data-bridge plumbing. Worth treating as
its own sub-track within v1.10 rather than assuming it lands in the same pass
as the smaller StudyDesk items (5, 6, 7). Given `P4`, still worth doing, just
flagging the sizing so it doesn't get compressed into the same estimate as a
notification-permission bug fix.

---

## Item 9 — Ko-fi + Stripe support link

**Source:** new, from the user directly (not the braindump): "I also made a
Ko-Fi account and connected it with stripe."

**Verified this session:** the Stripe account (`acct_1TyCLYV05PaRYRXK`,
display name "Limecore Studio") is live and connected. Per Ko-fi's own
documentation, Ko-fi passes supporter payments directly to the connected
Stripe account in real time — no Ko-fi holding period, no minimum payout,
standard Stripe fees (~3% + $0.30), funds reach the linked bank per the
Stripe payout schedule. Supporters can pay by card, wallet, or local payment
methods. ([Ko-fi: Connect your Stripe account](https://help.ko-fi.com/hc/en-us/articles/360007522474-Connect-your-Stripe-account-and-start-earning), [Ko-fi: How do I get paid?](https://help.ko-fi.com/hc/en-us/articles/115003980093-How-do-I-get-paid))

**Scope, smallest useful version:** a "Support the project" link/button to
the Ko-fi page on `limecore-site` (footer or about page) — no app code, no
API integration, just a link. Given `P4`, also worth a link from within
StudyDesk itself (e.g. a settings-page "Support development" row linking out)
since that's the app with the userbase this is most relevant to.

**Deliberately not scoped here:** Ko-fi's webhook API (for anything more
automated than a link, e.g. supporter-only perks) — nothing in the ask
implies wanting that, and it would be a materially bigger feature with its
own auth/entitlement questions. Flagging as a possible future direction, not
committing to it.

---

## Item 10 — AUTH-2: NCC/LimeLog code-entry screen

*(Carried from the v1.8 handoff, unchanged.)*

NCC and LimeLog have no code-entry screen — StudyDesk can confirm signup with
the emailed code in-app, the other two are link-only. Port `AuthGate.jsx`'s
code step; `OTP_MIN 6`/`OTP_MAX 10` are deliberately length-agnostic, don't
reintroduce a hardcoded digit count (this broke once already, fixed in
StudyDesk 1.6.2). Rides the same held NCC/LimeLog release as Items 2–4.

---

## Item 11 — Housekeeping bundle

| Item | What | Effort |
|---|---|---|
| `R2/X-3` | `phoneScreenshots` exist only for `en-US`/`zh-CN` in all three apps; other 8 locales fall back. | Needs device time. |
| `FD-META` | F-Droid `WebSite` field unset on all three recipes; `www.limecore.dev` redirect worth a final check. | NCC/LimeLog: open MRs. StudyDesk: own small MR. |
| `HYG-1` | Same one-line `CLAUDE.md` consolidation uncommitted in all four repos since before 2026-07-31. | Commit as `chore:` or revert. |
| `Suite home` | Legal-pages hosting undecided (currently `gh-pages` on NCC repo). | Decision + one-time setup. |

`OPS-1` (`CLAUDE.md` §4 documented a stale release flow) — **fixed directly 2026-08-01**, no longer part of this bundle.

---

## Sequencing

No F-Droid MR interaction for StudyDesk items (1, 5, 6, 7, 8, part of 9) or
the housekeeping bundle — StudyDesk ships standalone same as v1.8/1.9. Items
2–4, 10 (NCC, LimeLog) land on `develop` regardless of merge timing but don't
tag until !41550 and !41548 merge, same reasoning as v1.8.

Given `P4`, if this all can't land in one pass, **sequence StudyDesk's smaller
items (1, 5, 6, 7) ahead of both Item 8 (widgets) and the NCC/LimeLog items
(2, 3, 4, 10)** — the latter two groups are either a bigger native-code lift
(8) or held from tagging anyway (NCC/LimeLog), so there's no release-timing
cost to the small StudyDesk items shipping first. Item 8 can follow as its
own release once the widget/data-bridge work is actually done, rather than
holding 1/5/6/7 for it.

| App | Current | v1.10 ships? | Note |
|---|---|---|---|
| StudyDesk | 1.6.2 | New release once Items 1/5/6/7 land; Item 8 (widgets) likely its own follow-up release given the bigger scope | Tag + GitHub Release only, no MR |
| NCC | 1.7.2 (unbumped) | Held | Items 2, 3, 10 land on `develop`; no tag until !41550 merges |
| LimeLog | 1.8.3 (unbumped) | Held | Items 3, 4, 10 land on `develop`; no tag until !41548 merges |

---

## Open questions to resolve before branching

1. **Item 3 mechanism** — static baseline vs. per-week override (overlaps the Habits weekly-goal item).
2. **Item 4 (cardio logging) — NCC read-side check** — does NCC's fitness score already count all `workout_sessions` rows, or only ones with `sets`? Determines whether NCC needs a corresponding code change once LimeLog ships cardio sessions.
3. **Item 1 read-side check** — does anything on NCC's side depend on the current assignment-type enum?
4. **Item 8 (widgets) — data-bridge design** — confirm the snapshot-write trigger points (on data mutation? on app background?) against StudyDesk's actual data-flow code before building the Capacitor bridge plugin.

---

## CTO additions

<!-- append further v1.10 scope below -->

---

*Snapshot taken 2026-08-01 from `D:\emilh\Projects\limecore\NEXUS_V110_BUILD_PLAN.md`.*

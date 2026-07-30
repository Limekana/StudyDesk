# StudyDesk — QoL & Dead Code Audit

**Deep pass, 2026-07-27.** Findings only — nothing here is implemented.

Codebase: 30 source files, ~9,900 lines. **The cleanest of the three by a wide
margin on dead code** — knip finds essentially nothing, and unlike LimeLog every
single component already calls `useTranslation`.

The findings are concentrated in two places: **dates render in British English
regardless of language**, and **`App.jsx` is a 2,112-line monolith** with no
type checking behind it.

---

## A. QoL — high value

### A1. 🔴 Dates render in `en-GB` for every user, in every language

Six formatting sites hardcode the locale, and they are the most-seen strings in
the app:

| Site | What it renders |
|---|---|
| `App.jsx:1076` | **the main screen header date** — "Sunday 26 July" |
| `App.jsx:65` `fmtDate` | **every assignment / exam due date** (6 call sites) |
| `App.jsx:66` `fmtDateFull` | full dates on detail rows |
| `App.jsx:1700` | session start times |
| `SessionsView.jsx:44` | session log times |
| `SaveSessionSheet.jsx:81` | pending session start time |

This is not a "no keys exist" problem — **the correct pattern is already in this
codebase**. `SessionsView.jsx:39`, `SettingsView.jsx:82`, `App.jsx:1880` and
`App.jsx:1906` all correctly pass `lang || 'en'`. Four sites do it right, six do
not.

> **I saw this and missed it.** The Arabic screenshot I took during the RTL pass
> earlier in this session shows **"Sunday 26 July" in English** across the top of
> an otherwise fully-Arabic screen. I checked the layout direction and moved on
> without reading the content. Worth recording as a reminder that "RTL verified"
> and "localisation verified" are different checks.

**Fix:** thread the existing `lang` into the six sites. `fmtDate`/`fmtDateFull`
are module-level helpers so they need `lang` passed in — the smallest change is
to accept it as a second argument, since every caller is inside a component that
already has it.

### A2. 🟠 `fmtDate` returns hardcoded `"No date"` when a key already exists

`App.jsx:65` — `if (!s) return "No date";`

`av.noDate` exists and is translated into all ten locales (Hindi:
`कोई तारीख़ नहीं`). The string is simply not being used. Six call sites.

Exactly the same class as NCC's hardcoded `DAY_LABEL` — the translation work was
done, the code just never picked it up. Trivial fix, and it is the kind of thing
that makes an app feel half-translated even when the locale files are complete.

### A3. 🟠 `App.jsx` is 2,112 lines holding 10 components

21% of the app in one file, including the reducer, the shell, the calendar, the
timer, the plan view, the onboarding flow, all the modals, and ~380 lines of
inline CSS in template literals.

Concrete costs, not aesthetics:
- The v1.8 assignment-type change and the RTL sweep both required careful
  `sed`-style edits to a single 2,112-line file, because the CSS and JSX for
  unrelated features are interleaved.
- The inline `<style>` blocks mean component styles cannot be found by searching
  `.css` files — the RTL audit had to grep JSX for `border-left` to catch them.
- Any merge touching two features in this file conflicts.

**Fix:** not a rewrite. Extracting the four leaf modals (`AddAsgnModal`,
`AddExamModal`, `AddCourseModal`, and the calendar) plus their CSS into
`features/` would take ~600 lines out and matches the structure the rest of the
app already uses (`features/grades`, `features/sessions`, `features/settings`,
`features/stats` all exist and are properly separated).

### A4. 🟠 No type checking at all in the build

`"build": "vite build"` — no `tsc`, and the app is plain JSX by design (per
`CLAUDE.md`). The working agreement notes this: *"no TypeScript here, lint is
the only static gate."*

But the lint gate is weaker than it looks: `"lint": "eslint ."` has **no
`--max-warnings 0`**, so it exits 0 with warnings. It currently reports 6. In
practice nothing fails on a regression short of a syntax error.

Compare LimeLog: `eslint src --ext ts,tsx --report-unused-disable-directives
--max-warnings 0`. **Fix:** add `--max-warnings 0` after clearing the existing
6, so the gate actually holds. Cheap, and it is the only static safety net this
app has.

### A5. 🟡 Course colours are a closed set of 8

`App.jsx:43` — `COURSE_COLORS`, eight fixed hex values, no custom option. A
student with nine courses has to reuse a colour, which defeats the purpose of
colour-coding in the calendar and card accents.

Same escape-hatch class as the assignment-type fix shipped in v1.8. A native
`<input type="color">` alongside the presets is a small change.

### A6. 🟡 One native `confirm()`

`SettingsView.jsx` only — far better than NCC (9) and LimeLog (5). Same caveat
applies: OS-language buttons, LTR even in Arabic. Low priority precisely because
it is a single site, but it is on the sign-out path, which is a moment you want
to feel deliberate.

---

## B. Dead code — very little

### B1. Unnecessary exports (3 + 3)

- `lib/gpa.js: gradeToPoints` — genuinely unreferenced.
- `lib/merge.js: mergeSubject, mergeGrade, mergeSession` — **not dead**; used
  internally by `applyRemotePull`, which `App.jsx` imports. The exports are just
  redundant. Worth being explicit since this is the LWW merge logic the shared
  data contract depends on — it is live and correct.
- `i18n/index.js: RTL_LANGS, isRtl, applyDirection` — added by me this session.
  `applyDirection` is called internally; `isRtl` and `RTL_LANGS` are unused and
  should be consumed or dropped.

### B2. `postcss.config.cjs`

Knip flags it as unused. **Likely a false positive** — PostCSS configs are
loaded by filename convention, not by import. Verify before removing; if
Tailwind/autoprefixer are not in play here it is genuinely dead, but do not
delete on knip's word alone.

### B3. No unused dependencies

Clean. Compare LimeLog, which carries `clsx` and `date-fns` for nothing.

---

## C. Process

### C1. 🔴 No secret scanner, no CI

Same gap as LimeLog. No `.githooks/`, no `.github/workflows`. `scripts/` exists
but holds only `regen-icons.py`.

SEC-1 applies here too — `src/lib/supabase.js:11` carries the production URL and
anon key in a public repo. **And StudyDesk is the app that actually ships**: it
is merged into F-Droid, so `AutoUpdateMode: Version` picks up any new tag with
**no MR review in the loop**. That makes it the repo where an unreviewed mistake
travels fastest.

**Fix:** copy NCC's `scripts/check-secrets.mjs`, `.githooks/pre-commit` (mode
`100755` — it was committed non-executable in NCC and silently never ran) and
the CI workflow. No adaptation needed.

### C2. ✅ Credit where due

Every component localised, essentially zero dead code, no unused dependencies,
`try`/`catch` around all nine `localStorage` writes, and a correctly implemented
LWW merge. The i18n discipline in particular is better than LimeLog's by a
distance.

---

## Suggested order

1. **A2** (`"No date"` → `av.noDate`) — one-line fix, key already translated.
2. **A1** (six `en-GB` sites) — most visible strings in the app; correct pattern
   already exists four other places in the same codebase.
3. **C1** (secret scanner + CI) — file copy, and this is the repo that
   auto-ships to F-Droid.
4. **A4** (`--max-warnings 0`) — clear the 6 warnings, then make the gate hold.
5. **A5** (custom course colour) — small, visible to any student with 9+ courses.
6. **A3** (`App.jsx` extraction) — largest effort; do it when a feature next
   touches those modals rather than as a standalone refactor.
7. **A6, B1, B2** — polish.

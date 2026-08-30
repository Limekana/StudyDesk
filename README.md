# StudyDesk

> A mobile-first study planner for Android that tells you **what to study next** instead of asking you to figure it out. Bidirectionally synced with [Nexus Command Center](https://github.com/Limekana) for a single source of truth across devices.

Positioning: competitors answer *"what do I have to do?"*. StudyDesk answers *"what do I do right now?"*.

---

## Features

- **Next Up** — rule-based decision eliminator that surfaces the single highest-priority study action across all your courses, ranked into TODAY / THIS WEEK / LATER buckets
- **Courses / Assignments / Exams** — full CRUD with difficulty-aware study-start dates and topic checklists per exam
- **Pomodoro Timer** — focus / short break / long break cycles with background-safe drift correction (recomputes elapsed time on app resume so the timer doesn't reset when you switch away)
- **Lock In mode** — distraction-stripped deep focus: hides nav, kills break cycling (every block is a focus block), full-screen dark takeover until you tap *End session*
- **Grade Tracking** — per-subject grade rows with weighted GPA. Defaults to IB (1–7 scale); one-tap toggle to US (0–100 → 4.0). Multiple grade rows per subject (midterm + final + project), all factored into the GPA
- **Study Session Logging** — finish a focus phase → opt-in "Save session?" sheet → lands in the synced history with a flat-list-grouped-by-date view (TODAY / YESTERDAY / etc.)
- **Local Notifications** — daily Next Up digest at 9am, exam day-of and 2-days-before alerts, assignment due-tomorrow reminders. All on-device, no push server
- **Cloud Sync** — bidirectional realtime sync with Nexus via Supabase. Add a course in either app, it shows up in the other within ~2s
- **Auth** — email/password or Google OAuth (PKCE flow, durable session storage via Capacitor Preferences)
- **Soft-delete + LWW merge** — never hard-deletes; tombstones with `deleted_at` so multi-device edits resolve correctly

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite 7 |
| Mobile wrapper | Capacitor 8 (Android) |
| Auth + cloud DB + realtime | Supabase (Postgres, RLS, postgres_changes) |
| Local persistence | localStorage (offline-first cache) + Capacitor Preferences (auth session) |
| Notifications | Capacitor LocalNotifications (on-device, no push server) |
| Styling | Inline `<style>` blocks, self-hosted Playfair Display + DM Mono + DM Sans (offline-capable), paper-grain SVG texture overlay |
| Desktop edition | Electron (Windows `.exe` installer + portable `.zip`) |
| Distribution | [F-Droid](https://f-droid.org/packages/com.StudyDesk.app/) (Android) · [GitHub Releases](https://github.com/Limekana/StudyDesk/releases) (signed APK + desktop build) |

**Bundle ID:** `com.StudyDesk.app`
**OAuth deep-link scheme:** `com.studydesk.app://login-callback` (lowercase — Supabase normalizes URI schemes per RFC 3986, Android scheme matching is case-sensitive)

---

## Project structure

```
src/
├── App.jsx                          # Root component + reducer (single-file core)
├── main.jsx
├── index.css                        # Globals + CSS variables
├── lib/
│   ├── supabase.js                  # Client + Capacitor Preferences storage
│   ├── sync.js                      # Push fns, pullAllStudyData, startRealtime
│   ├── gpa.js                       # GPA + grade-mode helpers (matches Nexus)
│   └── merge.js                     # LWW reducer-friendly merge utilities
└── features/
    ├── auth/AuthGate.jsx            # Login / signup / Google + deep-link handler
    ├── grades/GradesView.jsx        # IB+US GPA toggle, per-subject expand
    └── sessions/
        ├── SaveSessionSheet.jsx     # Opt-in post-timer save modal
        └── SessionsView.jsx         # History grouped by date

android/                             # Capacitor-generated Android project
public/fonts/                        # Self-hosted typeface stack
```

---

## Local development

```bash
# 1. Install
npm install

# 2. Dev server (browser, no native plugins)
npm run dev

# 3. Lint
npm run lint

# 4. Production build
npm run build

# 5. Sync into Android project
npx cap sync android

# 6. Open in Android Studio (or use cap run)
npx cap open android
```

The Supabase publishable key in `src/lib/supabase.js` is the **anon/publishable key** (safe to ship client-side). RLS gates all data; the service-role key is never exposed.


---

## Data model

Shared schema with Nexus — do **not** add columns without a coordinated migration on both apps.

| Table | Key fields |
|---|---|
| `subjects` | `id`, `user_id`, `name`, `credits`, `semester`, `updated_at`, `deleted_at` |
| `grades` | `id`, `user_id`, `subject_id` (FK), `grade`, `weight`, `date`, `updated_at`, `deleted_at` |
| `study_sessions` | `id`, `user_id`, `subject_id` (nullable FK), `started_at`, `duration_minutes`, `notes`, `updated_at`, `deleted_at` |

Local state stores camelCase shapes; `src/lib/merge.js` handles the snake_case ↔ camelCase translation on pull.

---

## Architecture notes

- **Single-file core** — `App.jsx` holds the reducer + all the legacy views (Plan, Actions, Timer, Onboarding). New features live in their own modules under `src/features/`. The reducer is the single source of truth.
- **Local-first writes + an outbox** — UI handlers dispatch a local reducer action first (instant feedback), then enqueue the matching mutation in `src/lib/outbox.js`. Every operation is an idempotent upsert or delete-by-id, so a retry that races a successful first attempt is a safe no-op. Items drain on reconnect, on visibility change, or via *Retry now* in Settings; failures surface there with the last error rather than being dropped.
- **1.5s coalesce on Realtime** — `postgres_changes` events are debounced before triggering a full pull, so a multi-row write on Nexus doesn't fire five separate pulls.
- **Soft delete only** — every delete sets `deleted_at = now()`. Hard delete would leave the other app thinking the row still exists until the next full pull.

---

## Status

Released and in active development. Android builds are on **F-Droid**, which
auto-updates from tagged GitHub Releases; the desktop edition ships as an
additional asset on those same releases. See
[Releases](https://github.com/Limekana/StudyDesk/releases) for the current
version and changelog.

**Not on Google Play**, and no plans to be — F-Droid is the distribution
channel. The app is built to be F-Droid hostable by design; see the section
below.

---

## Privacy & Google sign-in (transparency)

Google sign-in opens the **standard Google web consent page** in a Chrome Custom Tab — no Google Sign-In SDK is bundled, no Google Play Services are linked. After consent, Google redirects back to `com.studydesk.app://login-callback?code=…`, Android hands the URL to the app via an intent filter, and the app exchanges the code for a Supabase session.

Users who prefer **no Google contact at all** can use email/password instead — that path never opens a browser and touches only your Supabase project's auth endpoint.

## F-Droid compatibility

StudyDesk is built to be F-Droid hostable: **no Google Play Services, no Firebase, no proprietary trackers, no ad SDKs.**

- Notifications use Android's native `AlarmManager` + `NotificationManager`, not FCM
- Auth uses Supabase's web OAuth flow via `@capacitor/browser` (Chrome Custom Tab) — pure AppAuth-style, no GMS
- All Capacitor plugins used are AOSP-only (`@capacitor/app`, `@capacitor/browser`, `@capacitor/local-notifications`, `@capacitor/preferences`)
- The `google-services` Gradle plugin is intentionally **not** applied (see `android/app/build.gradle`)

Build metadata for F-Droid lives in `.fdroid.yml` at the repo root. The default build ships pointing at the developer-hosted Supabase project, which is declared as the `NonFreeNet` antifeature — self-hosters can rebuild with their own backend via the env vars in `.env.example`.

## Self-hosting the backend

Both the Supabase URL and the publishable anon key are overridable at build time:

```bash
cp .env.example .env
# edit .env with your Supabase project URL + anon key
npm run build
npx cap sync android
```

If `.env` is absent, the build falls back to the public StudyDesk project, so the default `npm run build` keeps working out of the box.

## Support

StudyDesk is free, open source and ad-free. If it's useful to you, you can support development on Ko-fi — it goes straight back into building the suite.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/J6K8240SNW)

## License

MIT — see [`LICENSE`](LICENSE). Forks, redistributions, and F-Droid packaging are all welcome.

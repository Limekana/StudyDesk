# StudyDesk — Android (Capacitor + React)

## Overview
StudyDesk is a study/homework planning app. React 19 + Vite + Capacitor 8 + Supabase. Android native wrapper under `android/`.

## Token Efficiency Rules (READ THESE FIRST)
- **Prefer `grep`/`rg` over reading entire files** — search for the function/component first
- **Read only relevant sections** — not the whole file. Use `rg -n "functionName" src/` to find locations
- **Keep tool output minimal** — grep for what matters, don't dump full file contents
- **Don't scan unnecessary directories** — stay in `src/` and `android/app/src/main/` unless a task specifically crosses layers

## Build Commands
| Task | Command |
|------|---------|
| Dev server | `npm run dev` |
| Web build | `npm run build` |
| Sync to Android | `npm run cap:sync` (runs build + cap sync) |
| Android build | `cd android && ./gradlew-quiet assembleDebug` |
| Android build (full) | `cd android && ./gradlew assembleDebug` (only if quiet mode hides the issue) |
| Lint | `npm run lint` |

## Project Structure
- `src/` — React frontend (App.jsx, features/, components/, lib/)
- `android/` — Capacitor Android native wrapper (Kotlin/XML/Gradle)
- `public/` — Static assets
- `dist/` — Built web output (gitignored)

## Code Style
- React 19 with JSX (`.jsx` files)
- Supabase for backend/data
- Functional components, hooks pattern
- CSS modules in `src/` and `index.css`

## Conventions
- Read `src/` first — only go to `android/` for native plugin or build config issues
- When debugging builds: check `android/capacitor-cordova-android-plugins/` for plugin-related build failures
- Don't read `node_modules/` or `dist/`

## Data Contract (shared Supabase — binding)
- Owns `subjects`, `grades`, `study_sessions`. Bidirectional sync with NCC on subjects/grades, resolved LWW on `updated_at`.
- Schema change to an owned table = migration + NCC updated in the same milestone. Stop and confirm first (see `D:\emilh\Projects\CLAUDE.md`).
- No TypeScript here: `npm run lint` must pass before any release build. It is the static gate.

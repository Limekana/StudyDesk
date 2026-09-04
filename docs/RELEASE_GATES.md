# Release gates in this repo

Two gates were added on 2026-09-04 after a release APK was produced that was
8 bytes different from v1.12.1, was labelled 1.13.0, and contained none of the
v1.13 code.

## What happened

`vite build` failed on the dev machine. `dist/` therefore kept its 2026-09-02
contents. `npx cap sync android` copied that stale `dist/` into the APK.
`assembleRelease` succeeded. The stale-asset gate in the F-Droid checklist
compared the APK's assets to `dist/`, found them identical, and reported 10/10.

Every step behaved as written. The gate compares the APK to `dist/` and never
asks whether `dist/` is fresh, so a two-day-old `dist/` passes it perfectly.

CI was green throughout, and CI was not wrong either. CI runs `npm ci`, so it
builds from a clean `node_modules` every time and cannot reproduce a stale local
install. `npm run build` has been a CI step since `44071f5`; it passes on
`develop`, and it passes here.

## `npm run check:dist-fresh`

Asserts `dist/` exists, has an entry point, and that its NEWEST output is newer
than the newest tracked source file. Wired into `cap:sync` and `electron:build`
between the build and the packaging step, so the stale-`dist` chain cannot run to
completion, and into CI after the build gate.

Newest, not oldest, and the distinction is the whole reason `9208be8` exists:
Vite's `publicDir` copy preserves the SOURCE mtime on files it copies verbatim,
so `public/vite.svg` lands in `dist/` carrying the timestamp from whenever that
asset was first committed. The oldest file in `dist/` is therefore permanently
ancient on any checkout more than a few minutes old, and the gate false-failed
on the release machine while passing in CI only because a fresh clone stamps
every file with roughly the same `now`. The newest output is written on every
successful build and stays put when a build fails, which is exactly the signal
this gate needs.

**Amendment for `fdroid/FDROID_RELEASE_CHECKLIST.md` Section B** (that file lives
in the `limecore` repo, not this one, so it has to be applied there by hand). The
stale-asset step should read:

> Before diffing the APK's assets against `dist/`, run `npm run check:dist-fresh`
> and require exit 0. The diff only proves the APK matches `dist/`; it says
> nothing about whether `dist/` matches the source. A gate that passes on a
> two-day-old `dist/` is how a v1.12.1 APK shipped labelled 1.13.0.

## `npm run check:native-plugins`

Asserts every dependency whose own `package.json` declares `capacitor.android.src`
appears in both generated Gradle files, `android/capacitor.settings.gradle` and
`android/app/capacitor.build.gradle`.

`@capacitor/status-bar` was added to `package.json` and `package-lock.json` by the
v1.13 themes work and imported by `src/lib/theme.js`, but `npx cap sync android`
was never run, so the Gradle files listed four plugins where package.json declared
five. `npm ci`, `npm run build` and `assembleRelease` all pass in that state — the
plugin is simply not in the APK, and the dynamic import in `theme.js` swallows the
failure by design so that a theme never fails to apply because a native bar could
not be restyled. The Android status bar was a silent no-op in every dark theme.

The check reads the committed Gradle files rather than re-running `cap sync`,
because the release APK is built from what is in git.

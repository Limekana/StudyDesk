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

Asserts `dist/` exists, has an entry point, and that the **oldest file the build
emits** is newer than the newest tracked source file. Wired into `cap:sync` and
`electron:build` between the build and the packaging step, so the stale-`dist`
chain cannot run to completion, and into CI after the build gate.

Two choices in that sentence were argued over across three sessions, so both are
recorded here.

**Only emitted files count** — `dist/index.html`, `dist/widget.html` and
`dist/assets/**`. Everything else in `dist/` is copied verbatim out of `public/`
(fonts, logos, `vite.svg`, `robots.txt`). An emitted file is rewritten from
scratch on every successful build, so its mtime is unambiguously *when the build
ran*. A copied file's mtime is a property of the copy mechanism, which varies by
Vite version, filesystem and platform, and is not something a release gate should
depend on.

An earlier revision of this document stated that Vite's `publicDir` copy
preserves the source file's mtime, and that this made the oldest file in `dist/`
permanently ancient. That is not what Vite does here — tested by stamping a
source file into the past and rebuilding:

```
$ touch -d 2020-01-01T00:00:00Z public/vite.svg
$ rm -rf dist && npm run build
$ stat -c '%y  %n' public/vite.svg dist/vite.svg
2020-01-01 00:00:00  public/vite.svg
2026-09-04 20:47:20  dist/vite.svg      <- build time, not 2020
```

All 39 files in `dist/` land inside a 1.18-second window on every build. Scoping
to emitted files is still the right call: it is the assumption-free version, and
it means no future change to how any tool stamps copied assets can make this gate
lie.

**Oldest, not newest, among those files.** They are not symmetric once something
is wrong. `oldest` fails unless *every* emitted file is newer than the source —
fail-safe. `newest` passes if *any one* emitted file is newer — fail-open. A
stale `dist/` plus a single `touch dist/index.html` passes under `newest` and
fails under `oldest`, verified on this tree.

This gate exists because a fail-open shipped a v1.12.1 APK labelled 1.13.0. Its
direction is not a detail to trade away for convenience.

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

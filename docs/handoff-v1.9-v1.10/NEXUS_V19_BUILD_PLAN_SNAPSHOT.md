# NEXUS v1.9 Build Plan — SEC-1 Decision

**Milestone:** `v1.9` — SEC-1 only
**Registry:** `Nexus_Version_Status.md`
**Prior:** v1.8 Activation complete (NCC v1.7.2 / LimeLog v1.8.3 held-unbumped; StudyDesk v1.6.2 shipped)
**Note on numbering:** the held-back braindump feature items (StudyDesk assignment-type, NCC score-pacing/fitness-target, LimeLog workout types, AUTH-2, housekeeping) were originally scoped as v1.9 on 2026-08-01, but SEC-1 took the v1.9 slot instead per CTO call the same day — that plan now lives at **`NEXUS_V110_BUILD_PLAN.md`** as v1.10.

---

## What SEC-1 actually is

From Open Blockers: the Supabase project URL + anon key must resolve at build
time for F-Droid's reproducible builds, so anyone who clones any of the three
public repos and runs a dev build gets a working client pointed at
**production** (`hkktorzhaqnfqsnlstda`). RLS is the only thing separating that
stranger's session from every real user's row.

## Attacking the framing before accepting it

Before scoping this as "fix the credential exposure," worth checking whether
that's the right problem statement. **Live security-advisor check run
2026-08-01** (`get_advisors(type: security)` against `hkktorzhaqnfqsnlstda`):
the only finding is `PRE-3` (leaked-password protection disabled, already
tracked, plan-gated). **Zero RLS-gap warnings** — Supabase's own advisor,
which specifically flags missing or weak RLS policies, has nothing to say
about any of the 27 public tables.

That matters because a Supabase anon key is **designed to be public** — it's
the same model as a Firebase web config or any client-embedded API key: it
identifies the project, not a secret credential, and RLS is the actual
authorization boundary by design, not a backstop. Under that model, "a
stranger's dev build can reach production" is not itself a vulnerability — every
legitimate user's phone already does exactly that. **The real question SEC-1
should resolve is "is RLS actually correct," and the clean advisor scan is
real evidence toward yes, not a reason to stop asking.**

So the residual risk is narrower than the original framing suggested: not
"credentials are exposed" (expected, unavoidable given F-Droid's
reproducible-build requirement — see below), but **volume and abuse** — a bad
actor now needs only `git clone` + a dev build instead of decompiling a
signed APK to start hammering the anon endpoint or probing for an RLS policy
gap at scale.

## Why the obvious fix (point the committed fallback at a demo project) doesn't work

The instinctive fix — commit a throwaway/demo Supabase project's credentials,
supply real production credentials only via CI secrets at release build time
— **breaks reproducible builds**, which took three rounds of real work to get
green (see `FD-CI-GREEN` in the archive). F-Droid's buildserver has no access
to CI secrets; it rebuilds from the exact committed source. If the published
release APK embeds production credentials injected at CI time, F-Droid's
from-source rebuild would embed the demo project's credentials instead —
byte-mismatch, and reproducibility fails again, undoing that work. Whatever
is committed **must** be what F-Droid builds, and F-Droid's build **must**
produce a working app against real production data for real users. There is
no way to hide the anon key from a source-available, reproducible-build app.
This option is not "harder than it looks," it's incompatible with a
commitment already made — flagging so it isn't re-proposed without this
context.

## Recommended path (CTO to confirm, not yet decided)

1. **Keep the production URL + anon key as the committed fallback.** Required
   by F-Droid reproducibility; consistent with how Supabase anon keys are
   meant to work. Nothing to build here.
2. **Treat RLS correctness as the actual security boundary and keep verifying
   it,** not as a one-time pass. Re-run `get_advisors(type: security)` after
   every schema change (already a `P2` standing rule) — this SEC-1 resolution
   leans on that rule actually being followed, not just written down.
3. **Add abuse/volume controls**, which is the part that's actually new work:
   - Check Supabase's built-in rate limiting / abuse protection settings for
     the anon key and the auth endpoints — confirm what's available on the
     free plan vs. what needs Pro (same plan-gating pattern as `PRE-3`).
   - Consider whether Postgres-level statement timeouts or connection limits
     need adjusting now that the client pool includes untrusted dev builds,
     not just the three known apps.
   - `O-5`'s weekly backup script and `O-7`'s soft-delete purge are already
     partial mitigations for "something got deleted or corrupted" — worth
     confirming they'd actually catch an RLS-bypass-driven bulk write, not
     just accidental app-level deletes.
4. **Do not attempt the demo-project split** — see above. If this ever needs
   revisiting, it's a candidate for a genuinely separate mobile-only backend
   (a bigger project, not a v1.9-sized decision).

## Open question for the CTO decision

Is "RLS is currently clean per the advisor + add abuse monitoring" an
acceptable resolution, or does the standing worry about strangers hitting
production warrant something more structural (e.g., Supabase Auth CAPTCHA on
signup, IP-based rate limiting in front of the API)? This plan leans toward
the lighter answer given the clean advisor scan, but it's a real call, not a
foregone one.

---

## CTO additions

<!-- append further v1.9 scope below -->

---

*Snapshot taken 2026-08-01 from `D:\emilh\Projects\limecore\NEXUS_V19_BUILD_PLAN.md`.*

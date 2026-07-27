# StudyDesk — growth review at 142 accounts

**2026-07-27.** Everything below is measured from the production Supabase
project (read-only queries) and the live F-Droid index, not estimated.

---

## Where you actually are

| | |
|---|---|
| Accounts / profiles | **142 / 142** (the profile trigger has never missed) |
| Database size | **15 MB** of the free tier's 500 MB |
| MAU | 142 of the free tier's 50,000 |
| First session recorded | **2026-06-27** — so this is ~4 weeks old |
| Platform | **100% Android** (128 sessions, zero desktop) |
| Sign-in method | **116 Google (82%)**, 26 email |
| Plan / region | **Free**, `eu-north-1` (Stockholm) |
| F-Droid | `com.StudyDesk.app`, 1.5.4 / versionCode 13 |

Signups by day, last three weeks:

```
Jul 10  15   Jul 15   4   Jul 20   3   Jul 25   3
Jul 11   9   Jul 16   4   Jul 21   2   Jul 26   8
Jul 12  20   Jul 17   4   Jul 23   5   Jul 27  32  ← today
Jul 13  13   Jul 18   3   Jul 24   2
Jul 14   7   Jul 19   4
```

**Today is your biggest day ever — 32 signups, against 2–8/day for the previous
fortnight.** That is not organic drift; something changed. Finding out what is
probably worth more than anything else in this document, because it is the only
evidence you have about which acquisition channel actually works. The DB can't
tell you (27 of the 32 are Google sign-ins, all Android, same as everyone else).

---

## The funnel — this is the real story

```
142  created an account
 29  created at least one subject          (20%)
 15  created exactly one subject and stopped
  4  logged a grade                        (2.8%)   last one: Jul 13
  4  logged a study session                (2.8%)   last one: Jul 18
```

**Zero grades and zero study sessions have been written in the last 7 days**,
while 22 subject rows were created or edited in the same window. People are
still arriving and still setting up. Almost nobody reaches the thing the app is
for.

The good news is that the retention picture is much better than it first looks.
`last_sign_in_at` suggests near-total churn, but that field only updates on
re-authentication, not on app use — a user with a live session never touches it.
The honest signal is session refresh:

- **63 of 128 sessions refreshed in the last 7 days**
- 43 in the last 24 hours
- 31 sessions have lived past their first day

So roughly half your accounts still have the app installed and opening. They
are not churning. They are **installing, signing in, adding a subject, and then
not finding a reason to come back to it.**

> **Caveat, stated plainly:** every number here covers signed-in users only.
> StudyDesk has guest mode, and guest data never leaves the device. Someone
> using the app happily offline is invisible to all of this. What the numbers
> *do* cover is 142 people who deliberately went through the auth gate — and
> those are the ones you can see failing to activate.

---

## What I would do, in order

### 1. Instrument the funnel before adding anything to it

You cannot currently distinguish "80% bounced at onboarding" from "80% are
happily using guest mode" from "80% got confused by the calendar". Every product
decision below this line is guesswork until you can.

The cheap, privacy-respecting version is not analytics: it is **three timestamp
columns on `profiles`** — `first_subject_at`, `first_grade_at`,
`first_session_at` — written by the client it already syncs with. That is enough
to see where the drop-off is, adds no third party, needs no consent banner, and
does not compromise the F-Droid story.

**This is the highest-leverage item here.** Everything else is a guess without it.

### 2. Configure custom SMTP — you are losing email signups today

**5 of your 26 email signups (19%) are still unconfirmed after 2+ days.**

Supabase's own docs on the built-in email service: it has an hourly rate limit,
"availability is on a best-effort basis", and "for production use, you should
consider configuring a custom SMTP server". You are past the point where that is
optional. Resend, Postmark and SES all have free tiers that cover 142 users
several times over.

This is a live, ongoing loss — every one of those users tried to sign up and
couldn't finish.

### 3. Account deletion and data export — you are legally exposed

There is **no way to delete an account or export data from inside the app**. I
checked `SettingsView.jsx`: sign-out, language, sync stats, and that is it.

You are storing personal data for real people, on an EU-hosted database
(`eu-north-1`), with users in the EU. GDPR Article 17 (erasure) and Article 20
(portability) both apply, and neither is satisfied by "email me and I'll do it
manually" when there is no contact route in the app either. F-Droid's audience
is also disproportionately the kind that checks.

Deletion is the harder half (it needs to cascade across subjects, grades and
sessions, and revoke the auth user). Export is a morning's work — the sync layer
already knows how to read all three tables.

### 4. Sort out backups

You are on the **free plan: 7-day backup retention, no point-in-time recovery.**
Four weeks ago that was fine because the data was yours. It is now 142 people's
coursework.

Either move to Pro (~$25/mo, gets you PITR and longer retention) or set up a
scheduled `pg_dump` to storage you control. At 15 MB the dump is trivial; the
point is having one at all.

### 5. Then, and only then, the activation problem

Two specific things the data points at:

- **15 of the 29 users who created a subject created exactly one.** That is the
  shape of someone trying the app once. Whatever the screen looks like after you
  add your first subject, it is not telling them what to do next. Seeding a
  first assignment or exam alongside the subject — or an explicit "add your
  first deadline" prompt — is the obvious experiment.
- **The pomodoro timer and grade entry are where the value is, and nobody is
  reaching them.** Both are a tab away from where people land. Worth asking
  whether the first-run flow should end *inside* the timer rather than on the
  overview.

I would not build new features until (1) is in place. The funnel says the
problem is not missing capability, it is that the existing capability isn't
being found.

---

## Smaller things worth knowing

**Security posture is good.** The only security advisor finding on the whole
project is that leaked-password protection is disabled — that is one toggle in
the dashboard (Auth → Passwords → check against HaveIBeenPwned). RLS is clean
across every table. Performance advisors show only unused indexes and two
tables with duplicate permissive SELECT policies, none of which matter at this
size.

**`AutoUpdateMode: Version` + `UpdateCheckMode: Tags`.** Confirmed from the live
fdroiddata entry: **any git tag you push ships to F-Droid users with no MR
review in the loop.** This is why the secret scanner and CI added this session
matter more here than in the sibling repos — CI is the only gate between a
mistake and a release. Do not disable it.

**Store metadata covers 6 locales; the app ships 10.** Missing hi, pt, id and ar
— exactly the markets the user base is growing in. Screenshots exist only for
en-US and zh-CN. Cheap to fix and it targets growth directly. (Done for NCC and
LimeLog this session; StudyDesk still needs it.)

**Latency:** the database is in Stockholm and your users are in India, LATAM,
Africa and SE Asia — roughly 250–400 ms round trip for the largest cluster.
This is *not* currently a problem because the app is local-first and sync is
background, and it is not worth acting on yet. Worth remembering before you
spend effort optimising anything else.

**Scale is not your problem and won't be for a long time.** 15 MB of 500 MB,
142 of 50,000 MAU. You could grow 50× on the free tier's limits. The constraint
is activation, not capacity.

---

## What I did not check

- Guest-mode usage — unobservable by design.
- Why today's 32 signups happened. Worth finding out.
- Crash and error rates. There is no telemetry, so nobody knows. That is a
  defensible FOSS choice, but it does mean a crash on a common device would be
  invisible to you until someone opens a GitHub issue.

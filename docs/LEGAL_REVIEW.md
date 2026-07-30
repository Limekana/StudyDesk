# StudyDesk — legal & compliance review

**2026-07-27.** Written by an engineer, not a lawyer. Everything below is
sourced and checked against your actual setup rather than generic advice, but
for anything with real money attached you want a Finnish data-protection
solicitor to read the privacy policy before it goes live.

Your position: sole developer, established in Finland (so in the EU), running an
EU-hosted database (`eu-north-1`, Stockholm), with 142 real accounts, on an app
whose users are overwhelmingly **students** — many of whom will be minors.

---

## Ranked by "can this actually hurt me"

### 1. 🔴 Google can suspend your OAuth client — and that breaks 82% of sign-ins

This is the single most likely thing to take your app down, and it is the
cheapest to fix.

Google's [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
requires that you **"list the privacy policy URL in your OAuth client
configuration when your application is made available to the public."** Not
"should" — it is a condition of using the API. Google may revoke access for
violating the policy or misrepresenting data collection.

**116 of your 142 users (82%) signed in with Google.** If that client is
suspended, they cannot sign in, and their synced data becomes unreachable from
a fresh install. There is no appeal queue that moves fast.

**Check today:** Google Cloud Console → APIs & Services → OAuth consent screen.
If the privacy policy field is blank, or points at a URL that 404s, fix it
before anything else in this document.

### 2. 🔴 You have no way to delete an account or export data

GDPR [Article 17](https://gdpr-info.eu/art-17-gdpr/) (erasure) and
[Article 20](https://gdpr-info.eu/art-20-gdpr/) (portability) both apply to you.
You must respond **within one calendar month** of a request, and portability
output must be "structured, commonly used and machine-readable" — an open format
such as JSON or CSV.

Today there is no route to either. Not in the app, and there is no contact
address in the app either, so a user who wants their data has nowhere to send
the request. That combination — data held, no mechanism, no contact — is the
part that reads badly to a regulator, more than the missing button itself.

**The good news, verified:** every user-owned table has
`FOREIGN KEY … REFERENCES auth.users(id) ON DELETE CASCADE`, including
`profiles`, `subjects`, `grades` and `study_sessions`. Deleting the auth user
genuinely erases everything downstream. Erasure is one call, not a migration.

**The catch:** `auth.admin.deleteUser()` needs the service-role key, which must
never ship in a client app. So this has to be an Edge Function — the same
pattern `ai-generate` already uses.

### 3. 🟠 Children's data — this is a study app, so read this one properly

GDPR [Article 8](https://gdpr-info.eu/art-8-gdpr/): where an information society
service is offered directly to a child, processing based on consent is lawful
only if the child is at least **16**, or younger with parental authorisation.
Member states may lower the floor to 13, and they have diverged — Ireland and
Spain sit at 13, France, Germany and the Netherlands at 16.

Educational apps and platforms are explicitly within scope. A study planner for
coursework and grades is squarely the kind of service the article contemplates,
and a meaningful share of your users will be under 16.

You cannot practically verify ages, and nobody expects you to run identity
checks. The proportionate thing that small apps do, and that materially improves
your position:

- state a minimum age in the terms and at the point of account creation,
- do not collect more than you need from anyone,
- keep the AI feature explicitly opt-in rather than automatic.

The one thing you should not do is stay silent about it while marketing to
students.

### 4. 🟠 The AI debrief sends student-authored text to Google

`src/lib/aiStudyDebrief.js` sends the user's free-text study note (up to 400
characters) to the `ai-generate` Edge Function, which calls **Gemini**. The raw
text is then stored in `study_sessions.ai_debrief_raw` (up to 1000 chars), along
with inferred fields: `ai_comprehension`, `ai_confusion_flags`,
`ai_session_summary`.

Three things follow:

- **It must be disclosed.** Users are typing about their own studying; some of
  them will type things like "couldn't focus, migraine all day". Free-text about
  a person's difficulties can incidentally contain health data, which is
  [Article 9](https://gdpr-info.eu/art-9-gdpr/) special-category data with a much
  higher bar. You cannot prevent that; you can disclose it, keep the field
  opt-in, and not retain it longer than needed.
- **It is a third-country transfer** if Gemini processes outside the EEA. That
  needs a lawful transfer mechanism, which in practice means relying on Google's
  Standard Contractual Clauses — and saying so in the policy.
- `ai_confusion_flags` is **inferred** data about a student's academic
  weaknesses. Inferred data is still personal data and must appear in an export.

Verified as a positive: the debrief only runs when the user types a note and
taps the button. It is not automatic. Keep it that way.

### 5. 🟡 Records of processing (Article 30)

The "fewer than 250 employees" exemption is narrower than it sounds — it falls
away where processing is **not occasional**. Running an app that continuously
syncs user data is not occasional processing, so in practice the exemption does
not save you.

This is not a fine risk on its own; it is a one-page internal document
(what data, why, where it lives, who processes it, how long you keep it). Write
it once. It also makes the privacy policy trivial to keep honest, because the
policy becomes a restatement of it.

### 6. 🟡 Processor agreement with Supabase (Article 28)

You are the controller; Supabase is your processor. Article 28 requires a
written agreement. Supabase publishes a
[DPA](https://supabase.com/downloads/docs/Supabase+DPA+250314.pdf) — find it in
the dashboard under Organisation settings and accept it. Free-plan or not, this
is paperwork you want on file, and it takes minutes.

Same logic applies to Google as a processor for the AI calls and for OAuth.

### 7. 🟡 Soft deletes are not deletion

`subjects`, `grades` and `study_sessions` all use `deleted_at` soft deletes.
Right now there are **10 soft-deleted subjects and 8 soft-deleted grades** still
sitting in the database — data users believe they deleted.

Soft delete is the correct engineering choice for sync (it is how the LWW merge
resolves a delete against another device). It is not defensible as an indefinite
retention policy. You need a purge that hard-deletes rows soft-deleted more than
N days ago — 30 or 90 is a normal choice — and you need the policy stated.

---

## What is *not* a problem (so you don't spend time on it)

- **F-Droid is not going to remove you.** The
  [Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/) requires
  FLOSS licensing, reproducible builds, active maintenance, and **disclosed**
  anti-features. Your `NonFreeNet` declaration already names Supabase, Google
  sign-in and the AI service, which is exactly the honesty it asks for. F-Droid
  does not require a privacy policy. The removal risk is *undisclosed*
  anti-features — so if you ever add analytics, declare it or you have a real
  problem.
- **The policy forbids proprietary tracking and analytics libraries** (it names
  Google Play Services, Firebase, Crashlytics). This confirms the funnel
  instrumentation I recommended: timestamp columns in your own database, not an
  analytics SDK. Do not be tempted by the easy option here — it would be an
  actual removal risk, unlike anything else on this page.
- **You do not need an Article 27 EU representative.** That obligation is for
  controllers established *outside* the EU. You are in Helsinki.
- **You do not need a DPO.** Article 37 triggers on public authorities,
  large-scale systematic monitoring, or large-scale special-category processing.
  A solo dev with 142 users is none of those.
- **Cookie/ePrivacy consent banners** are not needed for the local storage you
  use — it is strictly necessary to provide the service the user asked for.

---

## Supervisory authority

Finland: **Tietosuojavaltuutetun toimisto** (Office of the Data Protection
Ombudsman). That is who a complaint about you would go to, and who you would
notify within 72 hours of a personal-data breach under
[Article 33](https://gdpr-info.eu/art-33-gdpr/). Worth having the link saved
before you need it, not after.

---

## The realistic fine picture

Worth saying plainly, because the framing matters: the headline "€20m or 4% of
turnover" numbers are for large-scale, deliberate or negligent infringements by
organisations that ignored regulators. That is not you.

What actually happens to a small developer is a complaint from one user, a
letter from the supervisory authority asking what your basis for processing is
and how you handle erasure requests, and a deadline to respond. The outcome
turns almost entirely on whether you can show you thought about it: a privacy
policy, a way to delete an account, and a record of processing turn that from an
enforcement matter into a correspondence matter.

That is why the ranking above is what it is. The Google OAuth item is the one
that can switch your app off tomorrow. The rest are about not being the developer
who did nothing.

---

## Sources

- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [GDPR Art. 8 — child's consent](https://gdpr-info.eu/art-8-gdpr/)
- [GDPR Art. 9 — special categories](https://gdpr-info.eu/art-9-gdpr/)
- [GDPR Art. 17 — erasure](https://gdpr-info.eu/art-17-gdpr/)
- [GDPR Art. 20 — portability](https://gdpr-info.eu/art-20-gdpr/)
- [GDPR Art. 28 — processors](https://gdpr-info.eu/art-28-gdpr/)
- [GDPR Art. 30 — records of processing](https://gdpr-info.eu/art-30-gdpr/)
- [GDPR Art. 33 — breach notification](https://gdpr-info.eu/art-33-gdpr/)
- [F-Droid Inclusion Policy](https://f-droid.org/en/docs/Inclusion_Policy/)
- [F-Droid Build Metadata Reference](https://f-droid.org/en/docs/Build_Metadata_Reference/)
- [Supabase DPA](https://supabase.com/downloads/docs/Supabase+DPA+250314.pdf)

# StudyDesk — Privacy Policy

**Last updated: 27 July 2026**

StudyDesk is made by **Limecore Studio**. This policy explains what the app
stores, where it goes, and what you can do about it. It describes the app as it
actually behaves — if you find something here that does not match what the app
does, that is a bug and we want to hear about it.

---

## The short version

- **If you do not sign in, nothing leaves your device.** StudyDesk works fully
  offline as a guest. No account, no upload, no analytics.
- **If you sign in, your coursework syncs** so you can use more than one device
  and not lose everything when you change phone.
- **There is no advertising, no tracking, and no analytics in this app.** We do
  not know how many screens you opened or how long you used it.
- You can **export everything** and **delete your account and all of its data**
  from inside the app, at any time, without asking us.

---

## Who is responsible

The data controller is **Limecore Studio** (sole trader, Helsinki, Finland).

Contact for anything in this policy, including data requests:
**<!-- CONTACT_EMAIL -->** — or open an issue at
<https://github.com/Limekana/StudyDesk/issues> if it is not something you mind
being public.

---

## What is stored, and where

### Guest mode (no account)

Everything stays in your device's local storage. We never see it. Uninstalling
the app deletes it.

### Signed in

Your data is stored in a **Supabase** database hosted in **Stockholm, Sweden
(EU)**. Specifically:

| What | Fields |
|---|---|
| **Your account** | Email address. If you sign in with Google: your name and profile picture URL, as supplied by Google. |
| **Courses** | Name, colour, credits, semester, school year. |
| **Grades** | The grade, its weight, the date, and any note you wrote. |
| **Study sessions** | Start time, duration, focus rating, and any note you wrote. |
| **AI debrief** (only if you use it) | The note you typed, plus what the model extracted from it: topic, a 1–5 comprehension rating, concepts you flagged as confusing, and a one-line summary. |

We do not collect your location, contacts, photos, device identifiers, or
advertising IDs. The app requests no such permissions.

---

## Who else sees it

Three processors, and no one else. We do not sell or share your data with
anybody, for any purpose.

**Supabase** — hosts the database and handles sign-in. Data is stored in the EU.

**Google** — only if you choose "Continue with Google". Google tells us your
email address, name and profile picture. Google's handling of your Google
account is governed by [their privacy policy](https://policies.google.com/privacy).

**Google (Gemini)** — only if you use the AI debrief. The note you type is sent
to Google's Gemini model to extract structured fields from it. This may be
processed outside the EU, under the Standard Contractual Clauses Google offers
for international transfers.

**The AI debrief is opt-in.** It only runs when you type a note and press the
button. If you never use it, nothing is ever sent to Gemini. If you would rather
keep your notes entirely between you and the database, simply do not use it —
everything else in the app works exactly the same.

---

## Why we are allowed to store it

- **To provide the app** (Article 6(1)(b) — performance of a contract): your
  courses, grades and sessions. Without them there is no app.
- **Your consent** (Article 6(1)(a)): the AI debrief. You give it by choosing to
  use the feature, and you withdraw it by not using it and deleting any notes
  you already sent.

---

## Age

StudyDesk is a study planner, and we know many people using it are at school.

**You must be at least 16 to create an account**, or the minimum age for
consenting to online services where you live if that is lower (it is 13 in some
EU countries). If you are younger than that, you can still use StudyDesk — use
it as a guest, where nothing leaves your device and no account exists.

If you believe a child under that age has created an account, contact us and we
will delete it.

---

## How long it is kept

- **Your data is kept until you delete it.** We do not expire accounts.
- When you delete a course, grade or session in the app, it is first marked
  deleted so the change can reach your other devices, then **permanently erased
  within 30 days**.
- When you **delete your account**, everything is erased immediately and
  irreversibly — account, courses, grades, sessions and AI notes. Nothing is
  retained, and there is no recovery window. Backups roll off within 7 days.

---

## Your rights

Under the GDPR you can ask for a copy of your data, correct it, delete it,
restrict or object to how it is used, and receive it in a portable format.

Two of those are buttons in the app, so you do not have to ask us or wait:

- **Settings → Export my data** — downloads everything as a JSON file.
- **Settings → Delete my account** — erases the account and all its data.

For anything else, contact us at the address above. We will respond within one
calendar month.

If you think we have handled your data badly, you can complain to the Finnish
Data Protection Ombudsman
([tietosuoja.fi](https://tietosuoja.fi/en/home)), or to the supervisory authority
where you live.

---

## Security

Sign-in is handled by Supabase Auth. Every table uses row-level security, so the
database itself enforces that you can only ever read or write your own rows —
not the application code, the database. Traffic is HTTPS throughout.

No system is perfect. If we ever discover a breach affecting your personal data,
we will notify the Finnish Data Protection Ombudsman within 72 hours and tell
you directly where the law requires it.

---

## Changes

If this policy changes materially, the app will tell you rather than quietly
updating this file. The change history is public in the
[repository](https://github.com/Limekana/StudyDesk/commits/main/PRIVACY.md) —
you can read exactly what changed and when.

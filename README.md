# StudyDesk

**Stop deciding what to study. StudyDesk tells you.**

StudyDesk is a mobile-first study execution app for Android. You enter your deadlines — assignments, exams, topics — and it surfaces a ranked list of what to work on right now. No AI, no dashboards, no accounts. Just a clear answer to the question students ask every time they sit down to study: *where do I start?*

---

## What it does

Most study apps are filing systems. They help you organise what you have to do but leave you to figure out what to do *right now*. That gap — between knowing your deadlines and knowing your next action — is where procrastination lives.

StudyDesk closes that gap with a single surface: **Next Up**.

Enter your courses, deadlines, and exams. StudyDesk ranks your study actions into three tiers — TODAY, THIS WEEK, and LATER — and updates them as deadlines shift. No manual sorting. No decision cost.

---

## Features

- **Next Up** — ranked study actions generated from your deadlines, rule-based and transparent
- **Assignment tracking** — due dates, course links, overdue flagging
- **Exam calendar** — exam dates with auto-calculated study-start dates
- **Topic checklist** — per-exam topic lists with completion tracking surfaced in Next Up
- **Focus timer** — Pomodoro and freeform, with session logging
- **Course management** — colour-coded, compact by default
- **Push notifications** — daily study reminders tied to your Next Up list
- **Offline-first** — all data stored locally, no account required, nothing leaves your device

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React + Vite |
| Mobile wrapper | Capacitor 8 |
| Storage | localStorage — offline-first, zero server dependency |
| Notifications | Capacitor LocalNotifications — fully on-device |
| Distribution | Google Play Store (pending) / Direct APK |
| Target platform | Android |

---

## Privacy

No account. No server. No analytics. No data collection of any kind.

Everything you enter — courses, assignments, exams, topics — is stored exclusively on your device using local storage. Uninstalling the app removes all data permanently. There is nothing to delete server-side because nothing was ever sent there.

This is a deliberate design decision, not a limitation.

---



## Installation

### Direct APK 

1. Download the latest APK from [Releases]
2. On your Android device go to **Settings → Install unknown apps** and allow installs from your browser or file manager
3. Open the downloaded APK and tap Install

### Google Play Store

Coming soon.

---

## Build from source

### Prerequisites

- Node.js 18+
- Android Studio with Android SDK
- Java 17+

### Steps

```bash
# Clone the repo
git clone https://github.com/Limekana/studydesk.git
cd studydesk

# Install dependencies
npm install

# Build the web app
npm run build

# Sync to Android
npx cap sync

# Open in Android Studio
npx cap open android
```

From Android Studio: **Build → Generate Signed APK/AAB** to produce a release build.

### Environment

No environment variables required. There is no backend, no API keys, and no external services.

---

## Project status

Currently in pre-launch beta. Core features are complete and stable:

- [x] Course management
- [x] Assignment tracking
- [x] Exam calendar with study-start date logic
- [x] Topic checklist
- [x] Next Up execution layer
- [x] Push notifications
- [x] Focus timer with session logging
- [x] Offline-first localStorage persistence

In progress / planned:

- [ ] Google Play Store release
- [ ] Home screen widget
- [ ] Streak / habit loop mechanic
- [ ] Export / backup
- [ ] iOS (v2 — pending Android traction)

---

## Developer

Built by **Limeform Studio** — a solo indie project.

If you find StudyDesk useful and want to support continued development, a voluntary support purchase will be available in the app once it hits the Play Store.

---

## Licence

All rights reserved. Source is published for transparency and portfolio purposes. You may not redistribute, rebrand, or publish derivative versions without permission.

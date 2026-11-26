# Decisions log

Append-only, one line per decision: `YYYY-MM-DD · T<id> · decision · why`.

- 2026-11-26 · PRD · v1 is a PWA on Supabase + Vercel free tiers · ₹0 budget, one user, phone and laptop
- 2026-11-26 · PRD · Google data via Apps Script bridges, not in-app OAuth · OAuth apps in "Testing" lose refresh tokens after 7 days; college admin may block third-party apps
- 2026-11-26 · PRD · No AI API in v1; rule-based engines + ChatGPT scheduled task reading an emailed digest · ₹0 budget
- 2026-11-26 · PRD · Strava data never sent to AI services · Strava API agreement
- 2026-11-26 · PRD · Smoking habits shown as "Habit A" / "Habit B" · privacy
- 2026-11-26 · T0.4d · SW precache install deduplicates URLs before `cache.addAll` · VitePWA injected the manifest icons + webmanifest and the glob re-captured them, so 3 URLs were duplicated; `addAll` rejects duplicate requests, so the worker never activated

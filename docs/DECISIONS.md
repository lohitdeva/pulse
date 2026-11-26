# Decisions log

Append-only, one line per decision: `YYYY-MM-DD · T<id> · decision · why`.

- 2026-11-26 · PRD · v1 is a PWA on Supabase + Vercel free tiers · ₹0 budget, one user, phone and laptop
- 2026-11-26 · PRD · Google data via Apps Script bridges, not in-app OAuth · OAuth apps in "Testing" lose refresh tokens after 7 days; college admin may block third-party apps
- 2026-11-26 · PRD · No AI API in v1; rule-based engines + ChatGPT scheduled task reading an emailed digest · ₹0 budget
- 2026-11-26 · PRD · Strava data never sent to AI services · Strava API agreement
- 2026-11-26 · PRD · Smoking habits shown as "Habit A" / "Habit B" · privacy
- 2026-11-26 · T0.4d · SW precache install deduplicates URLs before `cache.addAll` · VitePWA injected the manifest icons + webmanifest and the glob re-captured them, so 3 URLs were duplicated; `addAll` rejects duplicate requests, so the worker never activated
- 2026-11-26 · T0.3 · Auth magic-link emails via free custom SMTP — Resend with `onboarding@resend.dev` (no domain), not Brevo/built-in · built-in rate-limits links; Brevo free-mail sender fails Gmail/Yahoo DKIM/DMARC; resend.dev is pre-authenticated and delivers to the account owner's own inbox (single-user app)
- 2026-11-26 · T0.4a · Canonical VAPID keypair lives in `.env.local` (= Vercel `VITE_VAPID_PUBLIC_KEY`); Supabase Edge Function secrets `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` must be that same pair · a mismatch makes the push service reject and `send-test-push` 502

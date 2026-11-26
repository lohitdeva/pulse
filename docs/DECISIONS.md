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
- 2026-11-26 · T0.6 · `supabase/functions` is a pnpm workspace package so `pnpm -r test` runs its Vitest tests · the T0.4e base64 bug had a test that never ran because functions were outside the workspace; the Deno entrypoints (`Deno.*`/`jsr:`) are excluded from the Node typecheck (documented limitation)
- 2026-11-26 · T1.2 · §4 day templates + facility hours live once in `shared/schedule.ts`; the app seeds them per-user (idempotent) on first sign-in · single source of truth, Vitest-tested, reused by T1.3; a migration can't know `user_id`, and there is no `seed.sql`
- 2026-11-26 · T1.2 · `template_blocks` store times as `HH:MM` text (null for anchors/soft-placed blocks) · feeds `shared/time.ts` `blockInstants` directly without conversion
- 2026-11-26 · infra · Production is deployed by **manual Vercel CLI** (`npx -y vercel@latest --prod` from the repo root), NOT Git auto-deploy · the Vercel project `pulse` is repo-linked (`.vercel/repo.json`, directory ".") with no GitHub integration, so `git push` updates GitHub but does NOT redeploy; always run the CLI deploy to make new code live. Build config is the committed root `vercel.json` (vite, `pnpm --filter @pulse/app build` → `app/dist`)
- 2026-11-26 · infra · Supabase migrations are applied to hosted with `supabase db push --remote` (CLI 3.x needs `--remote`; local `db push` targets the Docker stack, which isn't available on this machine) · keep this in mind for every migration ticket
- 2026-11-26 · T1.3 · news-reading placement: daily budget inshorts 15 / mint 30 / wsj 30; breakfast (08:45–09:20) consumes it in order inshorts→mint→wsj by its duration; leftover is placed into the earliest free slots inside the fillable classes region (09:30–17:15) minus real-class `busy` intervals, split across slots · PRD §4 is deliberately loose, so this is the chosen deterministic interpretation; `buildDayPlan(template, dayKey, busy)` is pure and real classes arrive via `busy` in Phase 2
- 2026-11-26 · T1.3 · "Study block 1" keeps a null `startAt` (only its 19:30 end is fixed) · "after revision" has no fixed start — revision length varies with the day's subjects; items sort by `startAt`, falling back to `endAt`. Breakfast/news/fillable blocks are found by meta markers (`newsMinutes`, `newsOverlap`, `fillable`), not titles

# Pulse: build progress

The planner keeps this file current: ticket status, next action, what needs the user, and a session log. Status values are `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` and `WAITING ON USER`.

**Next action:** T1.1–T1.3 DONE. **T1.4 IN PROGRESS** — builder implementing the Today screen (header, Now/Next card, score-card placeholder, timeline) + BottomTabs shell per §13, rendering `buildDayPlan` from the shared default template (no DB fetch this ticket). Then checker + a browser preview at `/dev`.
**Current phase:** 1

## Needs you
_(The planner writes exact steps here when a ticket needs accounts, secrets, a phone, or a decision.)_

_No blocking user step right now._ Phase 0 acceptance and T1.2 (migration applied + app redeployed, seed live) are both complete.

**✅ Git auto-deploy is connected (verified 26 Nov):** a push to `main` auto-builds and deploys production on Vercel (push to c757089 went live in ~40s). `vercel --prod` remains a manual fallback. NB every push to `main` now triggers a prod deploy.

## Handoff notes
_(Rewritten at every checkpoint, 10 lines or fewer, so Codex or Claude Code can pick up cold. See AGENTS.md "Handoff between tools".)_

- **Last tool:** Claude Code (planner). T1.1–T1.3 DONE (89 tests green). **T1.4 IN PROGRESS** — Today screen UI.
- **T1.4 scope/decisions:** presentational `app/src/Today.tsx` (header w/ date+greeting+sync dot+Settings; Now/Next card w/ time-left bar + Done/Start-timer + next block; score-card PLACEHOLDER via `RingGauge` — scoring is Phase 8; vertical timeline of the day's items; `BottomTabs` shell, non-Today tabs = "Coming soon"). Data: `buildDayPlan(WEEKDAY|WEEKEND default template by today's IST weekday, currentPulseDayKey())` — NO DB fetch this ticket (DB-backed templates deferred to when template editing lands). Times formatted via `shared/time.ts` `istParts` (IST regardless of device tz). New pure helper `nowNext(plan, now)` in `shared/dayplan.ts` (+ tests). Reuse the T0.2 UI kit (`Card`/`RingGauge`/`StatTile`/`ListRow`/`BottomTabs`) + `tokens.css`. Preview without auth: also render Today with sample data in `DevGallery` (`/dev`). Settings (gear) opens a `Sheet` with the existing `PushSettings` + Sign out so push enrollment stays reachable.
- **T1.2 recap:** migration `20261126020000_schedule_core.sql` (4 per-user RLS tables; `days`/`schedule_items` EMPTY, filled in T1.3/T1.4). §4 defaults in `shared/schedule.ts`; `app/src/seed.ts` idempotent per-user seed wired into `Auth.tsx`. Applied to hosted + redeployed; seed live.
- **T1.3 recap:** `shared/dayplan.ts` — `buildDayPlan(template, dayKey, busy=[]) -> DayPlan { dayKey, items: ScheduleItem[], newsLeftoverMinutes }`, pure, uses `blockInstants`. News items `blockType:'habit'`, `meta.newsReading`. Blocks found by meta markers (`newsMinutes`/`newsOverlap`/`fillable`), added to `shared/schedule.ts` in BOTH templates. "Study block 1" keeps null `startAt` (sorts by `endAt` 19:30). Two non-blocking test-strength leads from the checker: the cross-midnight sort test asserts ascending order + Lights-out-last but not Call/Wind-down explicitly; the weekend test only checks study-minutes < weekday — tighten if convenient in a later pass.
- **GOTCHA (kept):** Docker unavailable here (no local Supabase); hosted migrations via `supabase db push --remote`. **Deploys: Git auto-deploy is now ON** — a push to `main` deploys production automatically (verified); `vercel --prod` is the manual fallback. Root `pnpm format:check` fails on PRE-EXISTING `shared/time.ts`/`time.test.ts` (not in the `-r` gate) — tidy-up lead.
- **INFRA (important for all agents):** production deploys are **manual Vercel CLI** — `npx -y vercel@latest --prod` from repo root (project `pulse` is repo-linked, no Git auto-deploy, so `git push` does NOT redeploy). Hosted Supabase migrations go via `supabase db push --remote` (CLI 3.x; Docker unavailable locally). T1.2 state (26 Nov): migration APPLIED to hosted; app NOT yet redeployed, so the seed hasn't run and `day_templates`/`template_blocks` are still empty — user is redeploying (see Needs you). New bundle hash: `index-CFVt1OMx.js`.
- **Next:** **T1.3** — `shared/dayplan.ts`: template → schedule items for a date incl. the news-reading placement rule; tests. Pure logic over `shared/schedule.ts` + `shared/time.ts` (`blockInstants`), no DB, so it can start in parallel with the hosted apply. Prior-phase NB kept: `functions/ambient.d.ts` global `Buffer`; Deno-runtime typecheck of `*/index.ts` is a documented gap; VAPID + Resend SMTP live (see DECISIONS).
- **T1.1 DONE (committed):** `shared/time.ts` + `shared/time.test.ts`; `shared/index.ts` re-exports. Fixed +5:30 IST offset (no deps, no I/O, portable to Deno Edge Functions). API: `istParts`, `pulseDayKey`, `startOfPulseDay`, `pulseDayRange` (half-open), `currentPulseDayKey`, `blockInstants`, consts `IST_TZ`/`IST_OFFSET_MINUTES`/`DAY_BOUNDARY_HOUR`. Checker PASS (all stages exit 0; shared 20 tests incl. fake-clock, app 12). `IST_TZ` currently unused (harmless).
- **T0.4d DONE earlier this session:** SW precache dedupe (`cache.addAll([...precacheUrls])`) + dark manifest `#0b0e14`. Root cause was duplicate precache URLs → `addAll` rejects. **User-gated:** deploy the new build, then run the S23 push test (Needs you). T0.5 device acceptance still WAITING ON USER.
- **GitHub + deploy status (26 Nov):** remote `origin` → github.com/lohitdeva/pulse set; `main` pushed by user. **T0.4d fix is now DEPLOYED and VERIFIED LIVE** — in-browser on pulse-tau-liard: sw.js 4794 B, install uses `addAll([...])`, the SW registers and ACTIVATES, `serviceWorker.ready` resolves (previously went redundant). Remaining: the S23 functional push test (enroll + test notification + Done/Snooze) — user step. Keeping the `.codex`/`.claude`/`*.md` tooling tracked for now (user will remove when the project is done).
- **Sign-in blocker (26 Nov) — RESOLVED:** was Supabase's built-in email rate limit; fixed with free custom SMTP via **Resend** (`onboarding@resend.dev` sender, delivers to the user's own inbox; Brevo failed Yahoo/Gmail DKIM/DMARC with a free-mail sender). Sign-in + push enrollment now work.
- **Test-push blocker — FIXED (T0.4e DONE, committed):** root cause was `TypeError: Uint8Array.fromBase64 is not a function` — `jsr:@daaku/webpush@0.2.0` uses TC39 Uint8Array base64 methods absent from the Supabase Edge Runtime (supabase-edge-runtime-1.79.1, Deno 2.1.4). Added `supabase/functions/_shared/base64-polyfill.ts` (installs `fromBase64`/`toBase64`/`fromHex`/`toHex` only if missing), imported first in `send-test-push`. Checker PASS; 35 supabase vitest pass; repo suite green. NOT a VAPID issue (keys were aligned anyway; `.env.local` pair valid). **VERIFIED LIVE 26 Nov: the test notification was delivered on the S23.** Full push chain now works: worker activates → sign-in (Resend SMTP) → enroll → deliver. Remaining for T0.5: confirm Done/Snooze buttons (the `notification-action` function, never exercised live). NB: the `supabase/functions` tree is NOT in `pnpm -r` typecheck/lint/test (workspace = app+shared) — pre-existing; a follow-up could wire it in.
- **Next ticket:** T1.2 — tables `day_templates`, `template_blocks`, `days`, `schedule_items` with RLS; seed weekday + weekend templates from the §4 table and facility hours (mess, gym) into settings. Read PRD §4. Use `shared/time.ts` for time math. (Supabase/migrations — mind whether DB access needs the user.)

## Phase 0: Foundations and push spike (PRD §13, §14, §15)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T0.1a | Workspace and quality tooling for app and shared | §14 Stack | DONE |
| T0.1b | Vite React TS app, Tailwind, PWA, dev and build | §14 Stack | DONE |
| T0.2 | Design tokens and base UI (Card, StatTile, RingGauge, IconChip, ListRow, TrendChip, BottomTabs, Sheet) plus a `/dev` gallery page | §13 tokens | DONE |
| T0.2a | Correct gallery typography and responsive proportions against the visual reference | §13 tokens | DONE |
| T0.3 | Supabase init: CLI, migrations, `settings` + `push_subscriptions` with RLS, magic-link sign-in screen, sign-ups disabled (user creates the project and pastes keys) | §14 | DONE |
| T0.4a | Web Push backend, VAPID setup and authenticated test push actions | §6 actions, §14 Push | DONE |
| T0.4b | Settings push enrollment, test control and service worker actions | §6 actions, §14 Push | DONE |
| T0.4c | Repair stalled S23 push enrollment | §6, §14 Push | DONE |
| T0.4d | Restore production worker activation | §14 Push | DONE |
| T0.4e | Web Push 502 on Supabase Edge Runtime: polyfill `Uint8Array.fromBase64`/`toBase64` (Deno 2.1.4 lacks them; `@daaku/webpush` needs them) | §14 Push | DONE |
| T0.5 | Vercel deploy, manifest with placeholder icons, installable on the S23; user tests push on the phone | §14, §15 P0 | DONE |
| T0.6 | Cover `supabase/functions` in the workspace quality gates (wire its Vitest tests into `pnpm -r test`; typecheck/lint where feasible) — the gap that let T0.4e ship | §14 | DONE |

## Phase 1: Schedule core (PRD §3, §4, §5, §6)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T1.1 | `shared/time.ts`: IST helpers, 4 AM day boundary, block maths; tests with a fake clock across midnight | §4 Day boundary, §14 Rules | DONE |
| T1.2 | Tables `day_templates`, `template_blocks`, `days`, `schedule_items` (RLS); seed weekday and weekend templates exactly from the §4 table, plus facility hours (mess, gym) in settings | §4 | DONE |
| T1.3 | `shared/dayplan.ts`: template → schedule items for a date, including the news-reading placement rule; tests | §4 | DONE |
| T1.4 | Today screen: Now/Next card, score card placeholder, timeline; layout per §13 | §13 Today screen | IN PROGRESS |
| T1.5 | Habit checklist, meals (with where: Mess/Outside/Ordered in), water (+½/+1, gym water separate); Dexie offline queue with sync dot | §6, §9 Water, §10 Meal link, §13 Interaction | TODO |
| T1.6 | Manual tasks: basic CRUD with the §5 fields | §5 Task fields | TODO |

## Phase 2: Timetable sync (PRD §4 Live timetable sync)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T2.1 | `shared/timetable/parser.ts`: raw grid + merged ranges → Section C classes; tests from `docs/reference/timetable-fixture.json` covering every §4 cell variant, plus a synthetic exam cell → Exam item | §4 | TODO |
| T2.2 | `bridges/college.gs` + `bridges/README.md`: read the "Schedule" tab values and merges, POST with bearer secret; time triggers 5:30 AM and 12:30 PM; manual run (user installs) | §14 Bridges | TODO |
| T2.3 | `ingest-timetable` function: auth, parse, snapshot, diff, upsert `classes`, change alerts; save the real payload as a second fixture | §4, §14 | TODO |
| T2.4 | Classes on Today and the timeline; attendance prompt (Attended/Missed/Medical/Cancelled); cancelled classes struck through with Restore (manual) and auto-restore when the sheet re-lists them; move and add-extra-class overrides | §4 Class handling, Cancelled classes, Manual changes | TODO |

## Phase 3: Reminder engine and check-ins (PRD §6)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T3.1 | `shared/reminders.ts`: levels, windows from facility hours (meal window also closes 10 min before the next class), cadence, quiet rules (class, 2–7 AM, call), firmer wording after 3 repeats, Missed transitions; simulated-day tests | §6 | TODO |
| T3.2 | Tables `reminders`, `notification_log`, `missed_items`; `dispatch-reminders` function; pg_cron every minute | §6, §14 | TODO |
| T3.3 | Notification actions end to end (Done / Snooze 10 / Skip with reason), opening the item focused | §6 | TODO |
| T3.4 | Check-in sheets: morning, midday, night (including the unlogged-items sweep and missed reasons) | §6 Check-ins, §11 Missed log | TODO |
| T3.5 | Morning digest push at 8:25 | §6 Morning digest | TODO |

## Phase 4: Tasks and deadlines (PRD §5)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T4.1 | `shared/planning.ts`: Plan-it slot finder, capacity, overbooking; tests | §5 | TODO |
| T4.2 | Estimate learning (`estimate_stats`, rolling median of 20 per category, pre-stretch) | §5 Learning | TODO |
| T4.3 | Deadlines view with countdown chips; deadline reminder schedule | §5 | TODO |
| T4.4 | Gmail and Calendar scans in both bridges; `ingest-gmail`, `ingest-calendar`; Review inbox UI (Confirm/Dismiss) | §5 Where deadlines come from, §14 | TODO |

## Phase 5: Fitness (PRD §7)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T5.1 | Seed exercises, alternatives and program sessions exactly from the §7 tables | §7 | TODO |
| T5.2 | `shared/fitness.ts`: session queue, double progression, stalls, deload, gap rules, cardio and abs progression; tests | §7 Progression, Missed days | TODO |
| T5.3 | Workout logger: sets, reps, RIR, rest timer, Copy last, Swap with reasons ("Pain" twice → flag) | §7 Logging, Swapping | TODO |
| T5.4 | Recovery sessions; stats (weekly sets, PRs, Epley e1RM); weigh-in on the workout screen; weight chart (7-day average, 80 kg target, projection, too-fast flag); morning make-up slot (7:30 AM–2:30 PM) after a missed evening session | §7 Stats, Body weight | TODO |

## Phase 6: Study and reading (PRD §8)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T6.1 | Courses; auto revision list from today's classes; catch-up tasks for missed classes | §8 Evening revision | TODO |
| T6.2 | Focus timer on server timestamps; study logs; prefill actual task time | §8 Focus timer | TODO |
| T6.3 | `shared/study.ts` suggestion ranking (weights 40/25/20/15) + UI on study blocks; tests | §8 Study suggestions | TODO |
| T6.4 | Reading logs per source; books | §8 Reading | TODO |

## Phase 7: Wellbeing, money, Strava (PRD §9, §10)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T7.1 | Sleep, mood (+ energy, tags), reflection (3 prompts → task); `shared/mood.ts` alert rules + tests; alert card with Tele-MANAS | §9 | TODO |
| T7.2 | Smoking counters (Habit A/B, triggers); `shared/taper.ts` (baseline week, caps, pace) + tests; stats | §9 Smoking taper | TODO |
| T7.3 | Gaming logs (timer or minutes) | §9 Gaming | TODO |
| T7.4 | Spending entry, categories, place autocomplete; `shared/eatingout.ts` caps + tests; Money screen analysis | §10 | TODO |
| T7.5 | Strava OAuth (activity:read), `strava-sync` schedule, Walk → walk habit, attribution (user creates the Strava API app) | §14 Edge Functions | TODO |

## Phase 8: Score and insights (PRD §11)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T8.1 | `shared/score.ts`: pillars, components, rescaling for N/A and Medical; tests reproduce the §11 table | §11 | TODO |
| T8.2 | `nightly` function: finalise days, scores, estimate stats, progression, caps, patterns, mood alerts | §14 Edge Functions | TODO |
| T8.3 | Insights screen: score breakdown, calendar heatmap, item heatmap | §11 Heatmaps, §13 | TODO |
| T8.4 | `shared/patterns.ts`: missed patterns, rule library, comparisons, weekly summary; tests | §11 Missed log, Insights panel | TODO |

## Phase 9: Command bar, digest, export (PRD §12)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T9.1 | `shared/commands.ts`: every §12 command, comma-separated, closest-match suggestions; tests; command bar UI with preview | §12 Command bar | TODO |
| T9.2 | Digest builder (Markdown, ≤ 1,500 words, no Strava details, privacy toggles); `digest` endpoint with bearer secret | §12 AI insights, §9 Privacy | TODO |
| T9.3 | `bridges/personal.gs`: Gmail and Calendar scans, 1:20 AM digest email to self; README steps | §12, §14 Bridges | TODO |
| T9.4 | Weekly JSON export to Storage; Export button; Coach notes box; Copy digest button | §12, §14 | TODO |

## Phase 10: Polish and assets (PRD §13, §15)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T10.1 | Generate 9 assets with built-in image generation: 6 tiles, icon 192/512 maskable, splash; WebP < 80 KB each. The planner does this itself, because subagents may not have the image tool | §13 Generated assets | TODO |
| T10.2 | Visual polish to match `docs/reference/ui-reference.png`; accessibility pass (AA contrast, 44 px targets, reduced motion) | §13 | TODO |
| T10.3 | Offline queue hardening, first-run flow, Samsung battery guide, Settings completeness | §13 Screens, §14 Rules | TODO |
| T10.4 | Playwright smoke tests; 3-day simulated run; Lighthouse installable check | §15 v1 is done when | TODO |

## Session log
_(One line per session: `YYYY-MM-DD HH:MM · Codex|Claude Code · tickets done · where it stopped`.)_

- 2026-11-26 — Phase 0: T0.1a, T0.1b and T0.2 verified and committed. T0.3 waiting for Supabase project setup.
- 2026-11-26 — T0.3 verified and committed. Hosted migration matches local history, email confirmed, subsequent sign-in recorded, public sign-ups disabled. Local callback uses port 5173.

- 2026-11-26 — T0.2a corrected gallery typography, chip and row proportions. Verified at 360, 390 and 1280 px, including sheet dismissal, focus return and tab selection.
- 2026-11-26 — T0.4a/b passed, backend and PWA deployed. T0.5 software checks passed. Production routes, bundled public keys, worker, manifest and icons verified via HTTP. S23 install, sign-in, delivery and action receipts pending.
- 2026-11-26 — T0.4c fixed unbounded enrollment waits and preserved the permission gesture. Verified updated production bundle and worker. S23 retry pending; no subscription existed at diagnosis.
- 2026-11-26 11:05 · Claude (chat) · no tickets · Added CLAUDE.md, `.claude/agents/` and shared handoff rules so Codex and Claude Code can alternate. Next session continues T0.4d or parks it.
- 2026-11-26 · Claude Code · T0.4d + T1.1 DONE · T0.4d: deduped SW precache `addAll` (root-caused in a real browser) + dark manifest; verified on local build; user deploy + S23 test pending. T1.1: `shared/time.ts` IST + 4 AM day boundary with fake-clock tests. Both checker PASS. Stopped after T1.1 per plan; next is T1.2.
- 2026-11-26 · Claude Code · Repo pushed to github.com/lohitdeva/pulse (user); T0.4d fix deployed to Vercel and VERIFIED LIVE in-browser (sw.js 4794 B, SW now activates). S23 functional push test still pending.
- 2026-11-26 · Claude Code · Auth fixed via Resend SMTP (rate-limit + DKIM). T0.4e DONE: polyfilled `Uint8Array.fromBase64`/`toBase64` for the Supabase edge runtime (Deno 2.1.4) so `send-test-push` stops throwing; checker PASS. **Test push DELIVERED on the S23 — push chain works end-to-end.** Remaining: Done/Snooze buttons, then T0.5 done → Phase 1.
- 2026-11-26 · Claude Code · T0.5 ACCEPTED (Done + Snooze verified on the S23). **PHASE 0 COMPLETE** — T0.1a–T0.5 all DONE. Running the full-suite gate + tagging `phase-0`. Next session: Phase 1 T1.2.
- 2026-11-26 · Claude Code · T0.6 DONE: `supabase/functions` is now a pnpm workspace package, so `pnpm -r test` runs its 35 Vitest tests (the gap that let T0.4e ship). Checker PASS; no function logic changed. `phase-0` tag moved to include it. **PHASE 0 FULLY CLOSED.** Next: Phase 1 T1.2 (fresh session).
- 2026-11-26 · Claude Code · Re-verified Phase 0 (gate green) · T1.2 code DONE: schedule-core migration (4 RLS tables) + §4 defaults in `shared/schedule.ts` + idempotent per-user app seed; builder+checker PASS, 79 tests. Stopped for the user to run the hosted `supabase db push` (Needs you); T1.3 is next.
- 2026-11-26 · Claude Code · **T1.2 DONE & LIVE** — hosted migration applied (`db push --remote`); app redeployed via Vercel CLI; seed confirmed in the live bundle. Recorded manual-CLI-deploy + hosted-migration flow in DECISIONS. Started **T1.3** (`shared/dayplan.ts`, template → schedule items + news-reading rule).
- 2026-11-26 · Claude Code · **T1.3 DONE** — `shared/dayplan.ts` `buildDayPlan` (template → timed schedule items + news-reading placement), meta markers added to `shared/schedule.ts`; builder+checker PASS, gate green, 89 tests. Decisions logged (news rule interpretation, Study-block-1 null start). Next: T1.4 (Today screen).
- 2026-11-26 · Claude Code · Pushed through c757089; **verified Vercel Git auto-deploy** (push → live in ~40s, confirmed by bundle markers). Marked in DECISIONS + handoff. This doc-mark commit kept local to avoid a no-op prod rebuild; it rides up with T1.4.

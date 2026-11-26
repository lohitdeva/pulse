# Pulse: build progress

The planner keeps this file current: ticket status, next action, what needs the user, and a session log. Status values are `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` and `WAITING ON USER`.

**Next action:** T3.3 notification actions; then ONE user-approved deploy: reminders migration + dispatch-reminders + notification-action + git push (deploying dispatcher before T3.3 would show generic Android notifications).
**Current phase:** 3 — Reminder engine and check-ins

## Needs you
_(The planner writes exact steps here when a ticket needs accounts, secrets, a phone, or a decision.)_

_(Nothing right now.)_

**✅ Git auto-deploy is connected (verified 26 Nov):** a push to `main` auto-builds and deploys production on Vercel (push to c757089 went live in ~40s). `vercel --prod` remains a manual fallback. NB every push to `main` now triggers a prod deploy.

## Handoff notes

- Phase 1 done (tag phase-1). Phase 2: T2.1–T2.3c DONE. First hosted college sync verified 2026-11-27 (read-only query): 1 snapshot @ 2026-11-26 19:05 UTC, 160 classes, 0 alerts; user ran `installCollegeTimetableTriggers` successfully.
- Hosted reads: `npx -y supabase@latest db query --remote --read-only "<sql>"`. Hosted writes/migrations need the user's OK first.
- T2.4 split into a/b/c; T3.2 and T3.4 split. Plan: T2.4a ∥ T3.1, then T2.4b → T2.4c → phase-2 gate, then T3.2a → T3.2b → T3.3 → T3.4a/b → T3.5.
- T2.4a + T3.1 DONE (checker PASS; 211 tests). Carry-overs: `fetchDayClasses` filters by source_date only — moved-in classes from another day missing (fix in T2.4b/c). `evaluate()` re-reports `missed` every call after window close — dispatcher (T3.2b) must persist a 'missed' resolution. pnpm not on PATH: use `npx -y pnpm@11.25.0`.
- T2.4b DONE (checker PASS by SQL review). Migration `20261127000000_class_overrides.sql` applied to hosted 2026-11-27 with user OK (verified: origin col, add_extra_class, RLS, 160 sheet rows); pgTAP `supabase/tests/timetable_reconciliation.test.sql` (plan 52) never executed — no Postgres here. Attendance = item_logs `class:<id>` + meta.attendance. Extra classes via `add_extra_class` RPC (origin='manual'). Nit: RPC lacks explicit end>start/blank-title errors (constraints still enforce).
- PHASE 2 DONE (tag phase-2): gate PASS, 246 tests (shared 101, functions 54, app 91).
- T3.2a DONE (checker PASS by SQL review; pgTAP plan 30 not run). Migration NOT on hosted yet. Cron `dispatch-reminders` every minute posts Bearer <vault dispatch_cron_secret> to /functions/v1/dispatch-reminders; function must verify via `check_dispatch_secret` (service_role) and deploy with verify_jwt=false. Hosted has pg_cron/pg_net available (not installed), vault+pgcrypto installed.
- T3.2b DONE (checker PASS, 258 tests). Owner via COLLEGE_TIMETABLE_OWNER_ID env (same as ingest). Item keys habit:/must:<day>:<order>, class:<id>. Alerts at-least-once (re-send if mark fails). shared/reminders.ts + dayplan.ts now use `.ts` imports; root tsconfig has allowImportingTsExtensions (user-approved). Deno resolution unverified locally (no deno) — deploy will reveal. app/src/push.ts only handles 'pulse-test' → fix in T3.3.
- Deferred: in-app manual Refresh / open-sync (needs bridge as Apps Script web app).

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
| T1.4 | Today screen: Now/Next card, score card placeholder, timeline; layout per §13 | §13 Today screen | DONE |
| T1.5a | Logging tables (`item_logs`, `meal_logs`, `water_logs`, RLS) + Dexie offline queue + sync engine wired to the Today sync dot; unit tests | §13 Interaction (offline-first) | DONE |
| T1.5b | Water (+½/+1, gym separate vs 2 L target) + meals (Mess/Outside/Ordered in) logging cards through the queue; `useDayLogs` read model; shared aggregation + tests | §9 Water, §10 Meal link | DONE |
| T1.5c | Habit checklist — mark habit timeline items done/skipped through the queue (reuses `useDayLogs`) | §6 | DONE |
| T1.6a | Manual tasks storage, RLS, types and basic CRUD data functions | §5 Task fields | DONE |
| T1.6b | Manual task list, quick add, edit and delete component | §5 Task fields | DONE |
| T1.6c | Connect manual tasks to the signed-in Plan tab and verify the user flow | §5 Task fields | DONE |
| T1.7 | Phase acceptance regression: fake-clock Now/Next across midnight and 4 AM rollover | §15 Phase 1 | DONE |

## Phase 2: Timetable sync (PRD §4 Live timetable sync)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T2.1 | `shared/timetable/parser.ts`: raw grid + merged ranges → Section C classes; tests from `docs/reference/timetable-fixture.json` covering every §4 cell variant, plus a synthetic exam cell → Exam item | §4 | DONE |
| T2.2 | `bridges/college.gs` + `bridges/README.md`: read the "Schedule" tab values and merges, POST with bearer secret; time triggers 5:30 AM and 12:30 PM; manual run (user installs) | §14 Bridges | DONE |
| T2.3a | Atomic snapshot, class reconciliation and change-alert queue migration | §4, §14 | DONE |
| T2.3b | Authenticated ingest endpoint, validation, parser integration and deployment | §4, §14 | DONE |
| T2.3c | Verify college sync, triggers and second fixture | §4, §14 | DONE |
| T2.4a | Classes on Today: fetch day's `classes` as `busy` into `buildDayPlan`, class items on Now/Next + timeline, unseen change alerts listed | §4 Class handling, Change alerts | DONE |
| T2.4b | Class overrides migration + data layer: attendance (Attended/Missed/Medical/Cancelled), manual cancel/restore/move/extra; reconcile honours manual changes, auto-restore, sheet-wins-on-cell-change | §4 Cancelled classes, Manual changes | DONE |
| T2.4c | Class UI: attendance prompt after class end, struck-through cancelled class with Restore, move / add-extra sheets | §4 | DONE |

## Phase 3: Reminder engine and check-ins (PRD §6)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T3.1 | `shared/reminders.ts`: levels, windows from facility hours (meal window also closes 10 min before the next class), cadence, quiet rules (class, 2–7 AM, call), firmer wording after 3 repeats, Missed transitions; simulated-day tests | §6 | DONE |
| T3.2a | Tables `reminders`, `notification_log`, `missed_items` (RLS); pg_cron + pg_net every minute calling the dispatcher with a cron secret | §6, §14 | DONE |
| T3.2b | `dispatch-reminders` function using `shared/reminders.ts`; also delivers queued timetable change alerts | §6, §14 | DONE |
| T3.3 | Notification actions end to end (Done / Snooze 10 / Skip with reason), opening the item focused | §6 | IN PROGRESS |
| T3.4a | Check-in sheets: morning and midday | §6 Check-ins | TODO |
| T3.4b | Night check-in, including the unlogged-items sweep and missed reasons | §6 Check-ins, §11 Missed log | TODO |
| T3.5 | Morning digest push at 8:40 (PRD §6) | §6 Morning digest | TODO |

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
- 2026-11-26 · Claude Code · **T1.4 DONE** — Today screen (`app/src/Today.tsx` + `SignedInShell`): header, Now/Next card, score placeholder, timeline; renders `buildDayPlan` from the shared default template. Builder+checker (1 fix round: name hardcoding + helper tests), planner-previewed `/dev` in browser. Gate green, 105 tests. Next: T1.5.
- 2026-11-26 · Claude Code · Split T1.5 → **T1.5a DONE** — logging migration (item_logs/meal_logs/water_logs, RLS) + Dexie offline queue/sync (drain-loop flush, stop-on-error, pending-count hook → Today sync dot). Builder+checker (1 hardening round: mid-flush overlap + throw test). Gate green, 114 tests. Migration not yet on hosted (Needs you, before T1.5b). Next: T1.5b (logging UIs).

- 2026-11-26 17:25 · Codex · Completed T1.5b–c, T1.6a–c and T1.7. Hosted migrations verified, all 147 tests passed, Chrome CRUD smoke passed. Stopped at the Phase 1 boundary.
- 2026-11-26 23:06 · Codex · T2.1 done · T2.2 implementation passed offline checks; waiting for college-account setup.
- 2026-11-26 23:28 · Codex · T2.3a–b done and deployed · waiting for first college sync (T2.3c).
- 2026-11-27 00:12 · Codex · T2.3c diagnosis · waiting for the rejected grid from the private college sheet.
- 2026-11-27 00:20 · Codex · T2.3c fix deployed · waiting for college rerun and trigger installation.
- 2026-11-27 · Claude Code · took over from Codex; T2.2 + T2.3c DONE (hosted sync verified) · starting T2.4a ∥ T3.1.
- 2026-11-27 · Claude Code · T2.4a–c + T3.1 DONE; class_overrides migration on hosted; **PHASE 2 COMPLETE** (tag phase-2) · starting T3.2a.

# Pulse: build progress

The planner keeps this file current: ticket status, next action, what needs the user, and a session log. Status values are `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED` and `WAITING ON USER`.

**Next action:** After the Supabase setup below, resume T0.3.
**Current phase:** 0

## Needs you
_(The planner writes exact steps here when a ticket needs accounts, secrets, a phone, or a decision.)_

1. Create a free Supabase project for Pulse under your own account.
2. In the project’s Authentication settings, create or invite your own email user, enable email sign-in, then disable new user sign-ups.
3. Create `.env.local` in the repository root. Set `VITE_SUPABASE_URL` to the project URL and `VITE_SUPABASE_ANON_KEY` to its public anon or publishable key. Keep the values local.
4. Tell the planner that setup is complete to resume T0.3.

## Phase 0: Foundations and push spike (PRD §13, §14, §15)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T0.1a | Workspace and quality tooling for app and shared | §14 Stack | DONE |
| T0.1b | Vite React TS app, Tailwind, PWA, dev and build | §14 Stack | DONE |
| T0.2 | Design tokens and base UI (Card, StatTile, RingGauge, IconChip, ListRow, TrendChip, BottomTabs, Sheet) plus a `/dev` gallery page | §13 tokens | DONE |
| T0.3 | Supabase init: CLI, migrations, `settings` + `push_subscriptions` with RLS, magic-link sign-in screen, sign-ups disabled (user creates the project and pastes keys) | §14 | WAITING ON USER |
| T0.4 | Web Push spike: VAPID keys script, service-worker push handler with Done/Snooze actions → `notification-action` function; `send-test-push` function; "Send test push" in Settings. Use a Deno-compatible Web Push library; if it fails, record the fallback (FCM) in DECISIONS.md | §6 actions, §14 Push | TODO |
| T0.5 | Vercel deploy, manifest with placeholder icons, installable on the S23; user tests push on the phone | §14, §15 P0 | TODO |

## Phase 1: Schedule core (PRD §3, §4, §5, §6)
| ID | Ticket | PRD | Status |
|---|---|---|---|
| T1.1 | `shared/time.ts`: IST helpers, 4 AM day boundary, block maths; tests with a fake clock across midnight | §4 Day boundary, §14 Rules | TODO |
| T1.2 | Tables `day_templates`, `template_blocks`, `days`, `schedule_items` (RLS); seed weekday and weekend templates exactly from the §4 table, plus facility hours (mess, gym) in settings | §4 | TODO |
| T1.3 | `shared/dayplan.ts`: template → schedule items for a date, including the news-reading placement rule; tests | §4 | TODO |
| T1.4 | Today screen: Now/Next card, score card placeholder, timeline; layout per §13 | §13 Today screen | TODO |
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
_(One line per session: date, phase, tickets done, where it stopped.)_

- 2026-11-26 — Phase 0: T0.1a, T0.1b and T0.2 verified and committed. T0.3 waiting for Supabase project setup.

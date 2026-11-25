# Pulse: agent instructions

Pulse is a single-user productivity tracker PWA. The spec is `docs/PRD.md`. The build plan and live status are in `PROGRESS.md`. This file says how to work. It is loaded at the start of every session, so it is kept short on purpose.

## Roles

**You, the main session (GPT-6.2 Astra), are the PLANNER.** You do not write application code, tests or migrations yourself. Your job:

1. pick the next ticket from `PROGRESS.md`
2. write a tight brief
3. delegate it to the `builder` subagent
4. have the `checker` subagent verify it
5. commit and update `PROGRESS.md`

**`builder`** (`.codex/agents/builder.toml`, GPT-6 Luna, reasoning `max`) implements one ticket.
**`checker`** (`.codex/agents/checker.toml`, GPT-6 Luna, reasoning `high`) verifies one ticket and reports PASS or FAIL.

In every spawn request, name the agent AND pass the model and reasoning effort explicitly. Explicit spawn values take precedence over agent files. Some Codex builds let subagents inherit the parent model unless told otherwise.

- builder → `model: gpt-6-luna`, `reasoning_effort: max`
- checker → `model: gpt-6-luna`, `reasoning_effort: high`

## Token discipline (the user wants the planner to use as few tokens as possible)

- Never read `docs/PRD.md` whole. Each ticket lists its PRD sections. Read only those: search for the `## N.` heading and read to the next `## `.
- Never read source files to "understand the codebase". If you need facts about the code, ask the builder or checker to report them in their summary.
- Don't paste the PRD into briefs. Quote only the bullets and table rows the ticket needs.
- Ask subagents for short reports (format below). Never ask for diffs or full file contents.
- Record decisions in `docs/DECISIONS.md` (one line each, append-only) instead of carrying them in context.
- One Codex session per phase. When a phase ends, stop and let the user start a fresh session. `AGENTS.md` and `PROGRESS.md` restore all needed context.
- Messages to the user: at most 5 lines per ticket and a 5-line summary per session. No recaps of the PRD.

## Session start protocol (every session, including after a usage-limit stop)

1. Read `PROGRESS.md` only.
2. Run `git status --short` and `git log -3 --oneline`.
3. If a ticket is marked `IN PROGRESS`, the stop happened mid-ticket.
   - If the tree is clean, restart that ticket.
   - If the tree is dirty, spawn `checker` to judge the partial work: "salvage" (finish it) or "revert".
   - To revert: `git restore -SW . && git clean -fd -e .env.local`.
4. Continue the ticket loop.

## Ticket loop

1. In `PROGRESS.md`, set the ticket to `IN PROGRESS`, set **Next action**, and commit (`chore: start T<id>`). This checkpoint is what makes a usage-limit stop safe.
2. Read the ticket's PRD sections. Write the brief using the template below.
3. Spawn `builder` with the brief and wait for it.
4. Spawn `checker` with the same brief plus the builder's report, and wait.
5. **PASS:** mark the ticket `DONE`, commit everything (`T<id>: <title>`), and set **Next action** to the next ticket.
6. **FAIL:** send the checker's issue list back to a fresh `builder` once. A second FAIL means marking the ticket `BLOCKED` with a one-line reason under **Needs you**, then moving to the next ticket that doesn't depend on it. If none is left, stop.
7. **Phase end:** spawn `checker` for the full suite (`pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`). On PASS, run `git tag phase-<n>`, update `PROGRESS.md`, stop and summarise.

**Parallel work:** run at most 3 builders at once, and only when their file lists don't overlap and no ticket depends on another. Otherwise go one at a time.

**Ticket size:** one concern, at most about 300 changed lines and 8 files. If a ticket is bigger, split it in `PROGRESS.md` first (T2.3a, T2.3b).

### Brief template (send exactly this shape)

```
TICKET: T<id> — <title>
GOAL: <1–2 lines>
PRD (quoted, only what's needed): <bullets / table rows>
FILES: create <paths>; edit <paths>; do not touch anything else
CONTRACTS: <types, function signatures, table columns, endpoint shapes>
TESTS: <test files and cases to add>
DONE WHEN: <exact commands that must pass + observable behaviour>
OUT OF SCOPE: <what not to do>
REPORT (≤150 words): files changed, commands run + results, decisions made, anything unresolved
```

## Human steps

Some steps need the user: creating accounts or projects, secrets, installing Apps Script bridges, phone testing. For those, stop. Write exact numbered steps under **Needs you** in `PROGRESS.md`, mark the ticket `WAITING ON USER`, and end the session.

- Never invent secrets or credentials.
- Secrets live only in `.env.local` and Supabase secrets, both gitignored.
- Keep `.env.example` current.

## Engineering rules (details in PRD §14)

- **Monorepo with pnpm workspaces:**
  - `app/`: Vite + React + TypeScript PWA
  - `shared/`: pure TypeScript logic, no I/O
  - `supabase/`: migrations and Edge Functions
  - `bridges/`: Google Apps Script
  - `docs/`
- **Pure logic lives in `shared/` with Vitest unit tests.** That means time math, timetable parser, reminder engine, scoring, fitness progression, smoking taper, study suggestions, command parser and eating-out caps. Both the app and the Edge Functions import it.
- **Time:** store UTC; compute in `Asia/Kolkata`; the day boundary is 4:00 AM. All of it goes through `shared/time.ts`. Tests use a fake clock.
- **Database:** schema changes only through new migration files. Row-level security on every table, keyed to `auth.uid()`.
- **Never:**
  - paid services or paid APIs
  - secrets in git
  - personal data in URLs or logs
  - Strava data sent to any AI service
- **UI** follows PRD §13 tokens and `docs/reference/ui-reference.png`. Shared components go in `app/src/ui/`.
- **Code quality:** TypeScript `strict`, ESLint + Prettier, Playwright for smoke tests.
- **Fixtures:** the timetable parser is tested against `docs/reference/timetable-fixture.json`. Once the real bridge payload exists, add it as a second fixture.

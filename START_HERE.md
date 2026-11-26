# Start here: building Pulse with Codex

This kit lets Codex build Pulse in small, resumable steps. GPT-6.2 Astra acts only as the planner, at low reasoning effort to save tokens. GPT-6 Luna subagents at `max` effort write the code, and Luna at `high` checks each step.

## What's in the kit

| File | Purpose |
|---|---|
| `AGENTS.md` | Shared rules for Codex and Claude Code: planner role, handoff, token discipline, ticket loop, resume protocol |
| `.codex/config.toml` | Main session: GPT-6.2 Astra at low effort. Subagents: GPT-6 Luna at max. At most 3 in parallel |
| `.codex/agents/builder.toml` | Luna, max effort: implements one ticket |
| `.codex/agents/checker.toml` | Luna, high effort: verifies each ticket, never edits |
| `CLAUDE.md` | Claude Code entry point: imports AGENTS.md and adds Claude-specific notes |
| `.claude/agents/builder.md` / `checker.md` | Claude Code builder (Sonnet, high effort) and checker (Haiku, read-only) |
| `PROGRESS.md` | 49 tickets in 11 phases, with status, "Next action", "Needs you" and a session log |
| `docs/PRD.md` | The full spec (markdown export of the PRD doc) |
| `docs/reference/` | Timetable screenshot, parser test fixture, UI reference image |
| `docs/DECISIONS.md` | Decision log the planner appends to |
| `.env.example` | Every key the app needs, with no values |

## One-time setup (about 15 minutes)

1. **Install the tools:** Node 20+, pnpm, git, Codex (app or CLI) and the Supabase CLI.
2. **Create the repo:** unzip the kit into a new folder (e.g. `~/code/pulse`), then run `git init && git add -A && git commit -m "Pulse kit"`.
3. **Open the folder in Codex** and trust the project when asked, so `.codex/config.toml` and the two agents load.
4. **Check the model picker** shows GPT-6.2 Astra. If it doesn't pick up the config, set Astra with Low reasoning by hand.
5. **Set permissions before the first prompt:** allow edits in the workspace and network access for package installs. Subagents inherit the main session's permissions, so this has to happen before any delegation ([docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
6. **Have these ready:** a Supabase account, a Vercel account, a Strava account (needed in phase 7), and your S23.

## Prompt 1: first session (paste as is)

```
You are the planner for Pulse. Follow AGENTS.md exactly; it overrides your defaults.
Read PROGRESS.md only. Start at "Next action".
For each ticket: read only the PRD sections the ticket lists, write the brief in the AGENTS.md template, spawn the builder agent (model gpt-6-luna, reasoning_effort max), wait, then spawn the checker agent (model gpt-6-luna, reasoning_effort high), then commit and update PROGRESS.md.
Do not write application code yourself.
Stop when the phase ends, a ticket needs me, or something is blocked. Then give me a summary of 5 lines or fewer, including anything under "Needs you".
```

## Prompt 2: every later session, including after a usage-limit stop

```
Resume Pulse. Run the AGENTS.md session start protocol, then continue the ticket loop from PROGRESS.md until the phase ends or something needs me. Summary in 5 lines or fewer.
```

Start a **new** session for each phase and after any usage-limit stop. Don't resume the old one. A new session loads only `AGENTS.md` and `PROGRESS.md`, while a resumed session carries all its old history into every new message, which costs tokens. Use `codex resume --last` only if you want to read what an interrupted session was doing.

## If usage runs out mid-build

- Every ticket starts with a checkpoint commit that marks it `IN PROGRESS`, and ends with a commit that marks it `DONE`.
- The next session checks git. The checker then decides whether to finish the half-done ticket or revert it.
- The most you can lose is one ticket of work, roughly 300 lines.

## Check that subagents really run on Luna

Some Codex builds have had a bug where subagents run on the parent's model (Astra) instead of their agent file. After the first ticket, open the builder's thread from the activity list and check its model.

If it shows Astra:

1. Update Codex.
2. Tell the planner: "pass model and reasoning_effort explicitly in every spawn request". `AGENTS.md` already asks for this.

## Steps only you can do

The planner pauses at each of these and writes exact instructions under "Needs you".

| Phase | You'll be asked to |
|---|---|
| 0 | Create a Supabase project and paste its URL and anon key into `.env.local`; log in to Vercel; install the app on your S23 and test a push |
| 2 | Install the college Apps Script bridge: paste the script, approve 2 permission screens |
| 4 | Install the personal Apps Script bridge (it gets updated again in phase 9) |
| 7 | Create a free Strava API app and connect your account |
| 9 | Check that the digest email arrives, then set up the ChatGPT task (PRD appendix) |
| 10 | Approve the generated images |

## Switching between Codex and Claude Code

Both tools follow the same rules (`AGENTS.md`) and keep the same progress file (`PROGRESS.md`). Each one saves a checkpoint at the start and end of every ticket and rewrites the "Handoff notes", so whenever one runs out of usage, the other can continue.

**To switch:** close the current session first. Never run both on the repo at once. Then open the other tool in this folder and paste:

```
Pick up Pulse where the last session left off. Follow the session start protocol in AGENTS.md: read PROGRESS.md (Next action, Needs you, Handoff notes), check git, then continue the ticket loop with the builder and checker subagents. Keep PROGRESS.md and the Handoff notes updated at every checkpoint. Stop at phase end, when something needs me, or when blocked; summary in 5 lines or fewer.
```

The same prompt works in both tools.

**Claude Code tips**

- Open the folder with `cd ~/Desktop/pulse-kit && claude`. Run `/context` to check that `CLAUDE.md` (with `AGENTS.md` inside it) loaded.
- Use `/model` to pick Sonnet for normal planning, and Opus for hard bugs like T0.4d.
- Run `/usage` to see your limits. If you hit a session limit with the session still open, Claude Code can wait and continue after the reset.

**Codex tips**

- Codex reads `AGENTS.md` directly. To save usage, consider lowering the builder in `.codex/agents/builder.toml` from `max` to `high`, which is OpenAI's suggested starting effort for Luna.

## Usage notes

- **Image generation** in Codex uses plan usage 3–5× faster than normal turns ([docs](https://developers.openai.com/ja-JP/docs/image-generation)). That's why T10.1 is capped at 9 images.
- **Subagents still cost tokens.** Each one does its own model and tool work, so a subagent workflow uses more tokens in total than a single agent ([docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)). The savings here come from the planner staying small and Luna doing the volume work. If usage runs high, lower the builder to `high` in `.codex/agents/builder.toml`.
- **Keep `AGENTS.md` under 32 KiB,** the default limit for instruction files ([docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)). It's about 6 KB now.

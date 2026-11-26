# Pulse: Claude Code entry point

The shared rules for this repo live in AGENTS.md, which Codex also follows. They are imported here so both tools work the same way:

@AGENTS.md

## Notes for Claude Code

- You are the planner described in AGENTS.md. Delegate all code changes to the `builder` subagent and all verification to the `checker` subagent (`.claude/agents/`). Ignore the Codex-only lines about `.codex/` files and spawn parameters.
- `PROGRESS.md` is the only shared state with Codex. Do not keep project status or decisions in auto memory. Write them to `PROGRESS.md` (Handoff notes, session log) and `docs/DECISIONS.md`.
- Start every session with the AGENTS.md session start protocol, and log yourself as `Claude Code` in the session log.
- If a usage limit is close, finish the current checkpoint (commit plus `PROGRESS.md` update) before starting anything new.

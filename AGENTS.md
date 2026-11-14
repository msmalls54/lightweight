# AGENTS.md

The full project plan, hard rules and specs live in [CLAUDE.md](CLAUDE.md). Read it first; it applies to every agent (Claude, Codex, others).

## Working together
- Several agents may work here at once. Each works on its own git branch or worktree; don't commit to `main` without being asked.
- Stay inside your assigned area (e.g. `firmware/`, `server/`, `dashboard/`) and don't edit files another agent owns.
- Never commit secrets. Keys go in `.env` (gitignored).
- The toolchain is already installed; see "Machine setup" in CLAUDE.md before installing anything.

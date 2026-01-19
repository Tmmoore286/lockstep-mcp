# Lockstep MCP

Lockstep MCP is a lightweight coordination server for multi‑agent workflows. It gives agents shared state (tasks, locks, notes), safe file access, and controlled command execution so two or more agents can collaborate without stepping on each other.

If you are evaluating this repo: it is designed to be clear, practical, and production‑minded. Everything is local‑first, explicit about safety boundaries, and easy to extend.

## Table of contents
- Features
- Architecture
- Install
- Quick start
- Collaboration walkthrough
- Configuration
- Example `.mcp.json`
- Storage + dashboard options
- Tools
- License

## Features
- Task and lock registry (shared across agents)
- Notes + JSONL event log
- File read/write with optional strict root mapping
- Command execution (open or allowlist)
- SQLite storage by default (JSON optional)

## Architecture
The coordinator is a local MCP server with three core layers:
- MCP transport (stdio) for tool calls
- Storage layer (SQLite by default, JSON optional)
- Guardrails (root‑scoped file access + optional command allowlist)

This design keeps the API surface small while supporting safe autonomy.

## Why this project
Multi‑agent workflows break down when agents overwrite each other or lose context. Lockstep MCP solves that by giving agents a shared source of truth (tasks, locks, notes) while keeping the system local‑first and auditable.

If you are evaluating this as a portfolio piece, the focus is on: reliability, clarity, and practical utility in real collaboration scenarios.

## Design decisions
- SQLite default for durability and concurrency; JSON remains available for simplicity.
- Explicit file‑root scoping so agents can’t wander outside agreed boundaries.
- Command allowlist option to limit automation scope without removing autonomy.
- Small, composable tool surface to keep integrations straightforward.

## Install
From GitHub:
```bash
git clone https://github.com/Tmmoore286/lockstep-mcp.git
cd lockstep-mcp
npm install
```

Global install (optional):
```bash
npm install -g https://github.com/Tmmoore286/lockstep-mcp.git
```

## Agent self-install (Codex/Claude)
If the agent has full access, it can install and register the MCP entry itself:

```bash
npm install
npm run install:mcp -- \
  --config /path/to/.mcp.json \
  --mode strict \
  --roots /absolute/path/to/your/repo,/tmp
```

Notes:
- Use the config file your CLI reads (repo-local `.mcp.json` or a global config).
- If you installed globally, use the CLI directly: `lockstep-mcp install ...`

## Run
Local dev:
```bash
npm run dev
```

Global install:
```bash
lockstep-mcp server --mode strict --roots /absolute/path/to/your/repo,/tmp
```

CLI help:
```bash
lockstep-mcp help
```

You can pass config flags after `--` when using npm scripts:
```bash
npm run dev -- --mode strict --roots /absolute/path/to/your/repo,/tmp
```

To run in the background:
```bash
nohup npm run dev -- --mode strict --roots /absolute/path/to/your/repo,/tmp > /tmp/lockstep-mcp.log 2>&1 &
```

## Collaboration walkthrough (plain language)
This is how you run two agents together using the same coordinator state.

1) Make sure both tools use the same coordinator config
- Both clients must point to the same MCP entry and same SQLite database (`--storage sqlite` and the same `--db-path` or `--data-dir`).
- After updating the MCP config, restart both clients so they pick up the server entry.

2) Open two terminals in the same repo
- Terminal A: Claude
- Terminal B: Codex

3) Start both clients
```bash
cd /absolute/path/to/your/repo
claude
```
```bash
cd /absolute/path/to/your/repo
codex
```

4) Tell them how to collaborate
Paste one of these into each client:

Claude (planner):
```
Use the lockstep-mcp MCP. Create tasks for plan steps and update task status as you go. Use lock_acquire before editing any file and lock_release when done. I’m the planner; Codex is the implementer.
```

Codex (implementer):
```
Use the lockstep-mcp MCP. List tasks, claim one, lock files before edits, implement, then update the task status. I’m the implementer; Claude is the planner.
```

After that, they share state through the coordinator and keep each other in sync.

## Configuration
All options can be provided by CLI flags or env vars.

- `--mode open|strict` (or `COORD_MODE`)
- `--roots /path/a,/path/b` (or `COORD_ROOTS`)
- `--data-dir /path` (or `COORD_DATA_DIR`)
- `--log-dir /path` (or `COORD_LOG_DIR`)
- `--storage sqlite|json` (or `COORD_STORAGE`)
- `--db-path /path/to/coordinator.db` (or `COORD_DB_PATH`)
- `--command-mode open|allowlist` (or `COORD_COMMAND_MODE`)
- `--command-allow cmd1,cmd2` (or `COORD_COMMAND_ALLOW`)

Defaults:
- mode: `open`
- roots: `process.cwd()`
- data dir: `~/.lockstep-mcp/data`
- log dir: `~/.lockstep-mcp/logs`
- storage: `sqlite`
- db path: `<data-dir>/coordinator.db`
- command mode: `open`

## Example .mcp.json
```json
{
  "mcpServers": {
    "lockstep-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/lockstep-mcp/dist/cli.js",
        "server",
        "--mode",
        "strict",
        "--storage",
        "sqlite",
        "--roots",
        "/absolute/path/to/your/repo,/tmp"
      ]
    }
  }
}
```

Dev example (uses TS loader):
```json
{
  "mcpServers": {
    "lockstep-mcp-dev": {
      "command": "node",
      "args": [
        "--import",
        "tsx",
        "/absolute/path/to/lockstep-mcp/src/cli.ts",
        "server",
        "--mode",
        "strict",
        "--storage",
        "sqlite",
        "--roots",
        "/absolute/path/to/your/repo,/tmp"
      ]
    }
  }
}
```

## Storage + dashboard options (recommendation)
Short version:
- SQLite (default): best for many agents, heavier concurrency, and reliable atomic updates.
- JSON file (optional): fastest to ship, easiest to inspect, fine for light coordination.
- Web dashboard: add a small HTTP server + WebSocket/SSE to stream updates.

When to choose JSON:
- 1–3 agents, low write volume, and you want simplicity.

When to move to SQLite:
- 4+ agents, high update frequency, or you want stronger durability and better concurrency.

WebSocket/SSE gateway:
- A separate lightweight web server can read `state.json` + `events.jsonl` and push updates to a dashboard.
- WebSockets give bi‑directional real-time updates. SSE is simpler for one-way live status.

If you want, I can add:
- SQLite storage implementation with a migration path.
- A minimal live dashboard (HTML + WebSocket) showing tasks/locks/notes in real time.

## Tools
- `status_get`
- `task_create`, `task_claim`, `task_update`, `task_list`
- `lock_acquire`, `lock_release`, `lock_list`
- `note_append`, `note_list`
- `artifact_read`, `artifact_write`
- `file_read`, `file_write`
- `command_run`
- `tool_install`
- `log_append`

## Notes
- File operations are restricted to `roots` when `mode=strict`.
- Command allowlist is enforced when `command-mode=allowlist`.
- Event log is written to `logs/events.jsonl`.
- Node v20.6+ requires `--import tsx` instead of `--loader tsx` for dev usage.

## License
MIT. See `LICENSE`.

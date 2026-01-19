# Lunara MCP Coordinator

Local MCP server for coordinating multiple agents (tasks, locks, notes, file ops, command exec).

## Features
- Task and lock registry (shared across agents)
- Notes + JSONL event log
- File read/write with optional strict root mapping
- Command execution (open or allowlist)

## Install
From GitHub:
```bash
git clone <repo-url>
cd lunara-mcp-coordinator
npm install
```

Global install (optional):
```bash
npm install -g <repo-url>
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
- If you installed globally, use the CLI directly: `lunara-mcp-coordinator install ...`

## Run
Local dev:
```bash
npm run dev
```

Global install:
```bash
lunara-mcp-coordinator server --mode strict --roots /absolute/path/to/your/repo,/tmp
```

CLI help:
```bash
lunara-mcp-coordinator help
```

You can pass config flags after `--` when using npm scripts:
```bash
npm run dev -- --mode strict --roots /absolute/path/to/your/repo,/tmp
```

To run in the background:
```bash
nohup npm run dev -- --mode strict --roots /absolute/path/to/your/repo,/tmp > /tmp/lunara-mcp.log 2>&1 &
```

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
- data dir: `~/.lunara-mcp-coordinator/data`
- log dir: `~/.lunara-mcp-coordinator/logs`
- storage: `sqlite`
- db path: `<data-dir>/coordinator.db`
- command mode: `open`

## Example .mcp.json
```json
{
  "mcpServers": {
    "lunara-coordinator": {
      "command": "node",
      "args": [
        "/absolute/path/to/lunara-mcp-coordinator/dist/server.js",
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
    "lunara-coordinator-dev": {
      "command": "node",
      "args": [
        "--loader",
        "tsx",
        "/absolute/path/to/lunara-mcp-coordinator/src/server.ts",
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

# Lockstep MCP

Lockstep MCP is a multi-agent coordination server that enables Claude, Codex, and other AI agents to work together on the same project without conflicts. It provides shared state (tasks, locks, notes) so agents can coordinate their work.

## For AI Agents: Installation Instructions

If you are an AI agent (Claude, Codex, or similar) and have been asked to install lockstep-mcp, follow these steps exactly:

### Step 1: Clone and Build

```bash
cd ~
git clone https://github.com/Tmmoore286/lockstep-mcp.git
cd lockstep-mcp
npm install
npm run build
```

### Step 2: Install Globally (Optional but Recommended)

```bash
npm link
```

This makes the `lockstep-mcp` command available system-wide.

### Step 3: Add to Your MCP Configuration

Run the install command to automatically configure lockstep-mcp:

```bash
lockstep-mcp install --all
```

This adds lockstep-mcp to both Claude Code (`~/.mcp.json` or project `.mcp.json`) and Codex (`~/.codex/config.toml`).

**Alternative: Install for specific tools only:**
```bash
lockstep-mcp install --claude    # Claude Code only
lockstep-mcp install --codex     # Codex only
```

### Step 4: Enable in the Project

Navigate to the project where you want to use coordination:

```bash
cd /path/to/your/project
lockstep-mcp init
```

This adds coordination instructions to `CLAUDE.md` (creates the file if it doesn't exist). The instructions tell agents how to use lockstep-mcp.

### Step 5: Verify Installation

```bash
lockstep-mcp status
```

You should see output like:
```
Lockstep MCP Status
──────────────────────────────────────────────────

Global Installation:
  Claude: ✓ Installed
  Codex:  ✓ Installed

Current Project (/path/to/your/project):
  Coordination: ✓ Enabled
```

### Step 6: Restart Your AI Tools

After installation, restart Claude Code and/or Codex so they pick up the new MCP server configuration.

---

## For AI Agents: How to Use Lockstep

Once installed, here's how coordination works:

### Starting a Coordination Session

When you start working in a project with lockstep enabled, call the `coordination_init` tool with your role:

```
coordination_init({ role: "planner" })   // If you're planning/creating tasks
coordination_init({ role: "implementer" }) // If you're implementing tasks
```

### If You're the Planner

The planner goes through these phases automatically:

**Phase 1 - Gather Information:**
1. Call `coordination_init({ role: "planner" })`
2. If no project context exists, ask the user:
   - What is this project?
   - What is the desired end state/goal?
   - What technologies are being used?
   - Any constraints or requirements?
   - What are the acceptance criteria?
   - What tests should pass when complete?
3. Call `project_context_set` with all the details

**Phase 2 - Create Implementation Plan:**
1. Based on the project context, create a detailed implementation plan
2. Call `project_context_set` again with the `implementationPlan` array
3. Set status to "ready"

**Phase 3 - Create Tasks:**
1. Create specific, actionable tasks using `task_create`
2. Ask the user what type of implementer they prefer (Claude or Codex)
3. Use `launch_implementer` to spawn workers (1-2 for simple projects, more for complex ones)

**Phase 4 - Monitor:**
1. Periodically check `task_list` and `note_list`
2. Respond to implementer questions via `note_append`
3. Add more implementers with `launch_implementer` if needed
4. When all tasks are done, call `project_status_set` with status "complete"
5. To stop all work, call `project_status_set` with status "stopped"

### If You're the Implementer

Implementers run in a **continuous loop** until the project is stopped or complete:

```
CONTINUOUS WORK LOOP:
1. Call task_list to see available tasks (also returns projectStatus)
2. If projectStatus is "stopped" or "complete" -> STOP working
3. If tasks available, call task_claim to take a "todo" task
4. Call lock_acquire before editing any file
5. Do the work
6. Call lock_release when done with file
7. Call task_update to mark task "done"
8. REPEAT from step 1
```

**IMPORTANT:** Keep working until all tasks are done or project is stopped. Do NOT wait for user input between tasks.

### Project Status States

| Status | Meaning |
|--------|---------|
| `planning` | Planner is gathering information and creating plan |
| `ready` | Plan is ready, tasks can be created |
| `in_progress` | Implementers are actively working |
| `complete` | All work is done |
| `stopped` | Planner has halted all work |

### Disabling Lockstep

If the user says "don't use lockstep" or "work independently", stop using lockstep tools and work normally.

---

## For Humans: Quick Start

### 1. Install

```bash
git clone https://github.com/Tmmoore286/lockstep-mcp.git
cd lockstep-mcp
npm install
npm run build
npm link
```

### 2. Configure

```bash
lockstep-mcp install --all
```

### 3. Enable in Your Project

```bash
cd /path/to/your/project
lockstep-mcp init
```

### 4. Start Coordinating

Open Claude and Codex in your project. Tell one "you're the planner" and the other "you're the implementer". They'll coordinate automatically.

---

## CLI Commands Reference

| Command | Description |
|---------|-------------|
| `lockstep-mcp install --all` | Add to both Claude and Codex configs |
| `lockstep-mcp install --claude` | Add to Claude config only |
| `lockstep-mcp install --codex` | Add to Codex config only |
| `lockstep-mcp uninstall` | Remove from all configs |
| `lockstep-mcp init` | Enable coordination in current project |
| `lockstep-mcp disable` | Disable coordination in current project |
| `lockstep-mcp enable` | Re-enable coordination in current project |
| `lockstep-mcp status` | Show installation and project status |
| `lockstep-mcp dashboard` | Start the web dashboard |
| `lockstep-mcp tmux --repo /path` | Launch Claude + Codex in tmux |
| `lockstep-mcp macos --repo /path` | Launch in macOS Terminal windows |
| `lockstep-mcp server` | Start the MCP server (called by AI tools) |
| `lockstep-mcp help` | Show help |

---

## MCP Tools Reference

### Coordination Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `coordination_init` | Initialize coordination session. Returns phase-specific guidance. | `role`: "planner" or "implementer" |
| `project_context_set` | Store project context including plan and acceptance criteria | `description`, `endState` |
| `project_context_get` | Retrieve stored project context | (none) |
| `project_status_set` | Set project status (stopped, complete, etc.) | `status` |
| `launch_implementer` | Launch a new implementer agent in a terminal window | `type` ("claude" or "codex"), `name` |
| `implementer_list` | List all registered implementers | (none) |

### Task Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `task_create` | Create a new task | `title` |
| `task_claim` | Claim a task (sets status to in_progress) | `id`, `owner` |
| `task_update` | Update a task | `id` |
| `task_list` | List tasks with optional filters. Also returns `projectStatus`. | (none) |

### Lock Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `lock_acquire` | Lock a file before editing | `path` |
| `lock_release` | Release a lock | `path` |
| `lock_list` | List active locks | (none) |

### Note Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `note_append` | Add a note (for inter-agent communication) | `text` |
| `note_list` | List recent notes | (none) |

### File Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `file_read` | Read a file | `path` |
| `file_write` | Write to a file | `path`, `content` |
| `artifact_read` | Read an artifact | `path` |
| `artifact_write` | Write an artifact | `path`, `content` |

### Other Tools

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `status_get` | Get coordinator status and config | (none) |
| `command_run` | Execute a shell command | `command` |
| `tool_install` | Install a tool via package manager | `manager` |
| `log_append` | Append to event log | `event` |

---

## How Coordination Works

### Shared Database

All agents connect to the same SQLite database at `~/.lockstep-mcp/data/coordinator.db`. This is how they share state:

```
┌─────────────────────────────────────────────────────┐
│                   lockstep-mcp                      │
│              (shared SQLite database)               │
│                                                     │
│  • Tasks (todo, in_progress, done)                  │
│  • Locks (which files are being edited)             │
│  • Notes (inter-agent messages)                     │
│  • Project Context (description, goals)             │
└─────────────────────────────────────────────────────┘
        ▲                                    ▲
        │                                    │
   ┌────┴────┐                          ┌────┴────┐
   │ Claude  │                          │  Codex  │
   │(planner)│                          │(implmtr)│
   └─────────┘                          └─────────┘
```

### Role Assignment

Roles are NOT configured in advance. When an agent starts, the user tells it which role to play:
- "You're the planner" → Agent calls `coordination_init({ role: "planner" })`
- "You're the implementer" → Agent calls `coordination_init({ role: "implementer" })`

This means you can use any combination:
- Claude as planner + Codex as implementer
- Codex as planner + Claude as implementer
- Two Codex instances (one planner, one implementer)
- Multiple implementers

### Preventing Conflicts

Agents use locks to prevent editing the same file simultaneously:

1. Before editing `src/app.ts`:
   ```
   lock_acquire({ path: "src/app.ts", owner: "codex" })
   ```

2. Edit the file

3. After editing:
   ```
   lock_release({ path: "src/app.ts" })
   ```

If another agent tries to acquire a lock on a file that's already locked, they'll get an error and should wait.

---

## Disabling Lockstep

Multiple ways to turn off lockstep:

| Method | Scope | How |
|--------|-------|-----|
| Natural language | This conversation | Tell agent "don't use lockstep" |
| MCP command | This session | `/mcp disable lockstep` |
| CLI command | This project | `lockstep-mcp disable` |
| CLI command | Global | `lockstep-mcp uninstall` |

---

## Configuration Options

When installing, you can customize the server:

```bash
lockstep-mcp install --all --mode strict --roots /path/to/project,/tmp
```

| Option | Description | Default |
|--------|-------------|---------|
| `--mode open\|strict` | In strict mode, file access is limited to roots | `open` |
| `--roots /path1,/path2` | Allowed directories (for strict mode) | Current directory |
| `--storage sqlite\|json` | Storage backend | `sqlite` |
| `--db-path /path/to/db` | Database file location | `~/.lockstep-mcp/data/coordinator.db` |

---

## Dashboard

View coordination state in real-time:

```bash
lockstep-mcp dashboard
```

Then open http://127.0.0.1:8787 in a browser.

The dashboard shows:
- All tasks and their status
- Active file locks
- Recent notes
- Configuration details

---

## tmux Launcher

Launch Claude and Codex in tmux windows with one command:

```bash
lockstep-mcp tmux --repo /path/to/your/project
```

This creates:
- Window 1: Claude
- Window 2: Codex
- Window 3: Dashboard

Switch windows with `Ctrl-b n` (next) or `Ctrl-b p` (previous).

Options:
- `--session <name>` - tmux session name (default: `lockstep`)
- `--layout windows|panes` - separate windows or split panes
- `--no-dashboard` - skip launching dashboard
- `--no-prompts` - don't auto-inject coordination prompts

---

## macOS Terminal Launcher

Launch in separate macOS Terminal windows:

```bash
lockstep-mcp macos --repo /path/to/your/project
```

Opens three Terminal windows for Claude, Codex, and Dashboard.

---

## Troubleshooting

### "lockstep-mcp: command not found"

Run `npm link` in the lockstep-mcp directory, or use the full path:
```bash
node /path/to/lockstep-mcp/dist/cli.js status
```

### Agent doesn't see lockstep tools

1. Check installation: `lockstep-mcp status`
2. Restart the AI tool (Claude/Codex)
3. In the AI tool, run `/mcp` to see connected servers

### Agents not coordinating

1. Make sure both are in the same project directory
2. Check that `lockstep-mcp init` was run in that project
3. Verify both agents can call `coordination_init`

### Lock conflicts

If an agent crashes while holding a lock:
```bash
# View locks
lockstep-mcp dashboard

# Or manually clear via the database
sqlite3 ~/.lockstep-mcp/data/coordinator.db "UPDATE locks SET status='resolved' WHERE status='active'"
```

---

## Example Workflow

### 1. Setup (one time)

```bash
# Install lockstep-mcp
cd ~/lockstep-mcp
npm install && npm run build && npm link

# Add to AI tools
lockstep-mcp install --all
```

### 2. Start a Project

```bash
# Enable in your project
cd ~/my-project
lockstep-mcp init

# Start dashboard (optional)
lockstep-mcp dashboard &
```

### 3. Open AI Tools

**Terminal 1 (Claude):**
```bash
cd ~/my-project
claude
```
Then tell Claude: "You're the planner. We're building [describe project]."

**Terminal 2 (Codex):**
```bash
cd ~/my-project
codex
```
Then tell Codex: "You're the implementer. Check lockstep for tasks."

### 4. Watch Them Collaborate

- Claude creates tasks based on the project description
- Codex claims tasks, implements them, marks them done
- Both use locks to avoid file conflicts
- Both use notes to communicate

---

## License

MIT. See `LICENSE`.

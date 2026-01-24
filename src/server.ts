import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { resolvePath, ensureDir } from "./utils.js";
import { createStore } from "./storage.js";
import {
  createWorktree,
  removeWorktree,
  getWorktreeStatus,
  mergeWorktree,
  listWorktrees,
  cleanupOrphanedWorktrees,
  getWorktreeDiff,
  isGitRepo,
} from "./worktree.js";

const config = loadConfig();
const store = createStore(config);

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function getBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function getStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return value as string[];
}

function getObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function jsonResponse(data: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResponse(message: string) {
  return {
    content: [
      {
        type: "text",
        text: message,
      },
    ],
    isError: true,
  };
}

function isCommandAllowed(command: string): boolean {
  if (config.command.mode === "open") return true;
  const commandName = command.trim().split(/\s+/)[0];
  return config.command.allow.includes(commandName);
}

async function runCommand(command: string, options: {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  maxOutputBytes?: number;
} = {}) {
  if (!isCommandAllowed(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }

  const cwd = options.cwd ? resolvePath(options.cwd, config.mode, config.roots) : undefined;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
    });

    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const append = (buffer: Buffer, chunk: Buffer, setTruncated: (val: boolean) => void): Buffer => {
      if (buffer.length + chunk.length > maxOutputBytes) {
        setTruncated(true);
        const remaining = maxOutputBytes - buffer.length;
        if (remaining > 0) {
          return Buffer.concat([buffer, chunk.subarray(0, remaining)]) as Buffer;
        }
        return buffer;
      }
      return Buffer.concat([buffer, chunk]) as Buffer;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout = append(stdout, data, (val) => {
        stdoutTruncated = val;
      });
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr = append(stderr, data, (val) => {
        stderrTruncated = val;
      });
    });

    let timeoutId: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    }

    child.on("error", (error) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        exitCode: code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

async function readFileSafe(filePath: string, options: { encoding?: BufferEncoding; maxBytes?: number; binary?: boolean } = {}) {
  const resolved = resolvePath(filePath, config.mode, config.roots);
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const data = await fs.readFile(resolved);
  const sliced = data.length > maxBytes ? data.subarray(0, maxBytes) : data;
  if (options.binary) {
    return { path: resolved, truncated: data.length > maxBytes, content: sliced.toString("base64") };
  }
  return {
    path: resolved,
    truncated: data.length > maxBytes,
    content: sliced.toString(options.encoding ?? "utf8"),
  };
}

async function writeFileSafe(filePath: string, content: string, options: { encoding?: BufferEncoding; mode?: "overwrite" | "append"; createDirs?: boolean } = {}) {
  const resolved = resolvePath(filePath, config.mode, config.roots);
  if (options.createDirs) {
    await ensureDir(path.dirname(resolved));
  }
  if (options.mode === "append") {
    await fs.appendFile(resolved, content, options.encoding ?? "utf8");
  } else {
    await fs.writeFile(resolved, content, options.encoding ?? "utf8");
  }
  return { path: resolved, bytes: Buffer.byteLength(content, options.encoding ?? "utf8") };
}

const tools = [
  {
    name: "status_get",
    description: "Get coordinator config and state summary",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "task_create",
    description: "Create a task. Complexity determines review requirements: simple=no review, medium=verify on completion, complex/critical=planner approval required. Isolation determines whether implementer works in shared directory or isolated git worktree.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "review", "done"] },
        complexity: { type: "string", enum: ["simple", "medium", "complex", "critical"], description: "simple=1-2 files obvious fix, medium=3-5 files some ambiguity, complex=6+ files architectural decisions, critical=database/security/cross-product" },
        isolation: { type: "string", enum: ["shared", "worktree"], description: "shared=work in main directory with locks, worktree=isolated git worktree with branch. Default: shared for simple/medium, consider worktree for complex/critical." },
        owner: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
      required: ["title", "complexity"],
      additionalProperties: false,
    },
  },
  {
    name: "task_claim",
    description: "Claim a task and set status to in_progress",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        owner: { type: "string" },
      },
      required: ["id", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "task_update",
    description: "Update a task",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "review", "done"] },
        complexity: { type: "string", enum: ["simple", "medium", "complex", "critical"] },
        owner: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_submit_for_review",
    description: "Submit a completed task for planner review (required for complex/critical tasks, recommended for medium)",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        owner: { type: "string", description: "Your implementer name" },
        reviewNotes: { type: "string", description: "Summary of changes made, files modified, and any concerns or decisions made" },
      },
      required: ["id", "owner", "reviewNotes"],
      additionalProperties: false,
    },
  },
  {
    name: "task_approve",
    description: "PLANNER ONLY: Approve a task that is in review status, marking it done",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        feedback: { type: "string", description: "Optional feedback or notes on the approved work" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_request_changes",
    description: "PLANNER ONLY: Request changes on a task in review, sending it back to in_progress",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID" },
        feedback: { type: "string", description: "What needs to be changed or fixed" },
      },
      required: ["id", "feedback"],
      additionalProperties: false,
    },
  },
  {
    name: "task_approve_batch",
    description: "PLANNER ONLY: Approve multiple tasks at once. More efficient than approving one by one.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Array of task IDs to approve" },
        feedback: { type: "string", description: "Optional feedback for all approved tasks" },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "task_summary",
    description: "Get task counts by status. Lighter than task_list - use when you just need to know how many tasks are in each state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description: "List tasks with optional filters. For active work, defaults to excluding done tasks to reduce response size. Use includeDone=true or status='done' to see completed tasks.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "review", "done"] },
        owner: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number" },
        includeDone: { type: "boolean", description: "Include done tasks in results (default: false for smaller responses)" },
        offset: { type: "number", description: "Skip first N tasks (for pagination)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lock_acquire",
    description: "Acquire a named lock",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        owner: { type: "string" },
        note: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_release",
    description: "Release a lock",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        owner: { type: "string" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "lock_list",
    description: "List locks with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "resolved"] },
        owner: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "note_append",
    description: "Append a note",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        author: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "note_list",
    description: "List recent notes",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "artifact_read",
    description: "Read an artifact file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string" },
        maxBytes: { type: "number" },
        binary: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_write",
    description: "Write an artifact file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] },
        createDirs: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "file_read",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        encoding: { type: "string" },
        maxBytes: { type: "number" },
        binary: { type: "boolean" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description: "Write a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] },
        createDirs: { type: "boolean" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "command_run",
    description: "Run a shell command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        maxOutputBytes: { type: "number" },
        env: { type: "object" },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "tool_install",
    description: "Install a tool using a package manager",
    inputSchema: {
      type: "object",
      properties: {
        manager: { type: "string" },
        args: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        env: { type: "object" },
      },
      required: ["manager"],
      additionalProperties: false,
    },
  },
  {
    name: "log_append",
    description: "Append a log entry",
    inputSchema: {
      type: "object",
      properties: {
        event: { type: "string" },
        payload: { type: "object" },
      },
      required: ["event"],
      additionalProperties: false,
    },
  },
  {
    name: "coordination_init",
    description: "Initialize coordination session. Call this first to set up your role (planner or implementer). Returns guidance based on your role and current project state.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["planner", "implementer"] },
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      required: ["role"],
      additionalProperties: false,
    },
  },
  {
    name: "project_context_set",
    description: "Store project context (description, goals, tech stack, acceptance criteria, tests, implementation plan). Called by planner to define what the project is about.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
        description: { type: "string", description: "What is this project?" },
        endState: { type: "string", description: "What is the desired end state/goal?" },
        techStack: { type: "array", items: { type: "string" }, description: "Technologies being used" },
        constraints: { type: "array", items: { type: "string" }, description: "Any constraints or requirements" },
        acceptanceCriteria: { type: "array", items: { type: "string" }, description: "Acceptance criteria that must be met" },
        tests: { type: "array", items: { type: "string" }, description: "Tests that should pass when complete" },
        implementationPlan: { type: "array", items: { type: "string" }, description: "High-level implementation steps/phases" },
        preferredImplementer: { type: "string", enum: ["claude", "codex"], description: "Which agent type to use for implementers" },
        status: { type: "string", enum: ["planning", "ready", "in_progress", "complete", "stopped"], description: "Project status" },
      },
      required: ["description", "endState"],
      additionalProperties: false,
    },
  },
  {
    name: "project_context_get",
    description: "Get stored project context. Returns the project description, goals, and other context set by the planner.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "project_status_set",
    description: "Set the project status. Use 'stopped' to signal all implementers to stop working.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
        status: { type: "string", enum: ["planning", "ready", "in_progress", "complete", "stopped"], description: "New project status" },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
  {
    name: "launch_implementer",
    description: "Launch a new implementer agent (Claude or Codex) in a new terminal window. The planner uses this to spawn workers. Set isolation='worktree' to give the implementer its own git worktree for isolated changes.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["claude", "codex"], description: "Type of agent to launch" },
        name: { type: "string", description: "Name for this implementer (e.g., 'impl-1'). If not provided, auto-generates as 'impl-N'" },
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
        isolation: { type: "string", enum: ["shared", "worktree"], description: "shared=work in main directory, worktree=create isolated git worktree. Default: shared" },
      },
      required: ["type"],
      additionalProperties: false,
    },
  },
  {
    name: "implementer_list",
    description: "List all registered implementers and their status.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Filter by project root (optional)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "implementer_reset",
    description: "Reset all implementers to 'stopped' status. Use this when starting a fresh session or when implementers are stale/not actually running.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root to reset implementers for (defaults to first configured root)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_reset",
    description: "PLANNER ONLY: Reset the coordination session for a fresh start. Clears all tasks, locks, notes, and archives discussions. Use this when starting a new project or when data from previous sessions is cluttering the dashboard.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root (defaults to first configured root)" },
        keepProjectContext: { type: "boolean", description: "If true, keeps the project description/goals but resets status to 'planning'. Default: false (clears everything)" },
        confirm: { type: "boolean", description: "Must be true to confirm the reset. This prevents accidental resets." },
      },
      required: ["confirm"],
      additionalProperties: false,
    },
  },
  {
    name: "dashboard_open",
    description: "Open the lockstep dashboard in a browser. Call this to monitor progress visually.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      additionalProperties: false,
    },
  },
  // Discussion tools
  {
    name: "discussion_start",
    description: "Start a new discussion thread. Use this when you need input from other agents or want to discuss an architectural/implementation decision.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic of the discussion (e.g., 'Database choice for user storage')" },
        category: { type: "string", enum: ["architecture", "implementation", "blocker", "question", "other"], description: "Category of discussion" },
        priority: { type: "string", enum: ["low", "medium", "high", "blocking"], description: "Priority level" },
        message: { type: "string", description: "Initial message explaining the topic and your thoughts" },
        author: { type: "string", description: "Your agent name (e.g., 'planner', 'impl-1')" },
        waitingOn: { type: "string", description: "Which agent should respond (optional)" },
        projectRoot: { type: "string", description: "Project root (defaults to first configured root)" },
      },
      required: ["topic", "message", "author"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_reply",
    description: "Reply to an existing discussion thread.",
    inputSchema: {
      type: "object",
      properties: {
        discussionId: { type: "string", description: "ID of the discussion to reply to" },
        message: { type: "string", description: "Your reply message" },
        author: { type: "string", description: "Your agent name" },
        recommendation: { type: "string", description: "Your recommendation/vote if applicable" },
        waitingOn: { type: "string", description: "Which agent should respond next (optional)" },
      },
      required: ["discussionId", "message", "author"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_resolve",
    description: "Resolve a discussion with a final decision. Creates an auditable record of the decision.",
    inputSchema: {
      type: "object",
      properties: {
        discussionId: { type: "string", description: "ID of the discussion to resolve" },
        decision: { type: "string", description: "The final decision" },
        reasoning: { type: "string", description: "Why this decision was made" },
        decidedBy: { type: "string", description: "Who made the final decision" },
        linkedTaskId: { type: "string", description: "Optional task ID spawned from this decision" },
      },
      required: ["discussionId", "decision", "reasoning", "decidedBy"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_get",
    description: "Get a discussion thread with all its messages.",
    inputSchema: {
      type: "object",
      properties: {
        discussionId: { type: "string", description: "ID of the discussion" },
      },
      required: ["discussionId"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_list",
    description: "List discussions. Use this to check for discussions waiting on you.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "waiting", "resolved", "archived"], description: "Filter by status" },
        category: { type: "string", enum: ["architecture", "implementation", "blocker", "question", "other"], description: "Filter by category" },
        waitingOn: { type: "string", description: "Filter by who is expected to respond" },
        projectRoot: { type: "string", description: "Filter by project" },
        limit: { type: "number", description: "Max results to return" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "discussion_inbox",
    description: "Check for discussions waiting on you. Call this between tasks to see if anyone needs your input.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Your agent name to check inbox for" },
        projectRoot: { type: "string", description: "Filter by project" },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_archive",
    description: "Archive a resolved discussion. Archived discussions can be deleted later.",
    inputSchema: {
      type: "object",
      properties: {
        discussionId: { type: "string", description: "ID of the discussion to archive" },
      },
      required: ["discussionId"],
      additionalProperties: false,
    },
  },
  {
    name: "discussion_cleanup",
    description: "Archive old resolved discussions and optionally delete old archived ones. Use for maintenance.",
    inputSchema: {
      type: "object",
      properties: {
        archiveOlderThanDays: { type: "number", description: "Archive resolved discussions older than X days (default: 7)" },
        deleteOlderThanDays: { type: "number", description: "Delete archived discussions older than X days (default: 30)" },
        projectRoot: { type: "string", description: "Limit to specific project" },
      },
      additionalProperties: false,
    },
  },
  // Worktree tools
  {
    name: "worktree_status",
    description: "Get the status of a worktree including commits ahead/behind main, modified files, and untracked files. Use this to check an implementer's progress before merging.",
    inputSchema: {
      type: "object",
      properties: {
        implementerId: { type: "string", description: "Implementer ID to check worktree status for" },
      },
      required: ["implementerId"],
      additionalProperties: false,
    },
  },
  {
    name: "worktree_merge",
    description: "Merge an implementer's worktree changes back to main. This should be called after a task is approved. If there are conflicts, returns conflict information for manual resolution.",
    inputSchema: {
      type: "object",
      properties: {
        implementerId: { type: "string", description: "Implementer ID whose worktree to merge" },
        targetBranch: { type: "string", description: "Branch to merge into (default: main or master)" },
      },
      required: ["implementerId"],
      additionalProperties: false,
    },
  },
  {
    name: "worktree_list",
    description: "List all active lockstep worktrees in the project.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "worktree_cleanup",
    description: "Clean up orphaned worktrees that no longer have active implementers. Call this during maintenance.",
    inputSchema: {
      type: "object",
      properties: {
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: config.serverName, version: config.serverVersion },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    switch (name) {
      case "status_get": {
        const state = await store.status();
        return jsonResponse({
          config: {
            mode: config.mode,
            roots: config.roots,
            dataDir: config.dataDir,
            logDir: config.logDir,
            storage: config.storage,
            dbPath: config.dbPath,
            command: config.command,
          },
          stateSummary: {
            tasks: state.tasks.length,
            locks: state.locks.length,
            notes: state.notes.length,
          },
        });
      }
      case "task_create": {
        const title = getString(args.title);
        const complexity = getString(args.complexity) as "simple" | "medium" | "complex" | "critical" | undefined;
        if (!title) throw new Error("title is required");
        if (!complexity) throw new Error("complexity is required (simple/medium/complex/critical)");
        const isolation = getString(args.isolation) as "shared" | "worktree" | undefined;
        const task = await store.createTask({
          title,
          description: getString(args.description),
          status: getString(args.status) as "todo" | "in_progress" | "blocked" | "review" | "done" | undefined,
          complexity,
          isolation: isolation ?? "shared",
          owner: getString(args.owner),
          tags: getStringArray(args.tags),
          metadata: getObject(args.metadata),
        });
        return jsonResponse(task);
      }
      case "task_claim": {
        const id = getString(args.id);
        const owner = getString(args.owner);
        if (!id || !owner) throw new Error("id and owner are required");
        const task = await store.claimTask({ id, owner });

        // Return complexity-based instructions
        const complexityInstructions: Record<string, string> = {
          simple: "Simple task - implement and mark done directly.",
          medium: "Medium task - implement carefully, submit_for_review when complete.",
          complex: "Complex task - discuss approach first if unclear, get planner approval via submit_for_review.",
          critical: "CRITICAL task - discuss approach with planner BEFORE starting, get approval at each step."
        };

        return jsonResponse({
          ...task,
          _instruction: complexityInstructions[task.complexity] ?? complexityInstructions.medium
        });
      }
      case "task_update": {
        const id = getString(args.id);
        if (!id) throw new Error("id is required");
        const newStatus = getString(args.status) as "todo" | "in_progress" | "blocked" | "review" | "done" | undefined;
        const task = await store.updateTask({
          id,
          title: getString(args.title),
          description: getString(args.description),
          status: newStatus,
          complexity: getString(args.complexity) as "simple" | "medium" | "complex" | "critical" | undefined,
          owner: getString(args.owner),
          tags: getStringArray(args.tags),
          metadata: getObject(args.metadata),
        });

        // Check if all tasks are now complete
        if (newStatus === "done") {
          const todoTasks = await store.listTasks({ status: "todo" });
          const inProgressTasks = await store.listTasks({ status: "in_progress" });
          const reviewTasks = await store.listTasks({ status: "review" });
          if (todoTasks.length === 0 && inProgressTasks.length === 0 && reviewTasks.length === 0) {
            // All tasks complete - notify planner
            await store.appendNote({
              text: "[SYSTEM] ALL TASKS COMPLETE! Planner: review the work and call project_status_set({ status: 'complete' }) if satisfied, or create more tasks.",
              author: "system"
            });
          }
        }

        return jsonResponse(task);
      }
      case "task_submit_for_review": {
        const id = getString(args.id);
        const owner = getString(args.owner);
        const reviewNotes = getString(args.reviewNotes);
        if (!id || !owner || !reviewNotes) {
          throw new Error("id, owner, and reviewNotes are required");
        }
        const task = await store.submitTaskForReview({ id, owner, reviewNotes });

        // Notify planner
        await store.appendNote({
          text: `[REVIEW] Task "${task.title}" submitted for review by ${owner}. Planner: use task_approve or task_request_changes.`,
          author: "system"
        });

        return jsonResponse({
          ...task,
          _instruction: "Task submitted for planner review. Continue with other tasks while waiting."
        });
      }
      case "task_approve": {
        const id = getString(args.id);
        if (!id) throw new Error("id is required");
        const feedback = getString(args.feedback);
        const task = await store.approveTask({ id, feedback });

        // Notify implementer
        await store.appendNote({
          text: `[APPROVED] Task "${task.title}" approved by planner.${feedback ? ` Feedback: ${feedback}` : ""}`,
          author: "system"
        });

        // Check if all tasks are now complete
        const todoTasks = await store.listTasks({ status: "todo" });
        const inProgressTasks = await store.listTasks({ status: "in_progress" });
        const reviewTasks = await store.listTasks({ status: "review" });
        if (todoTasks.length === 0 && inProgressTasks.length === 0 && reviewTasks.length === 0) {
          await store.appendNote({
            text: "[SYSTEM] ALL TASKS COMPLETE! Planner: review the work and call project_status_set({ status: 'complete' }) if satisfied, or create more tasks.",
            author: "system"
          });
        }

        return jsonResponse(task);
      }
      case "task_request_changes": {
        const id = getString(args.id);
        const feedback = getString(args.feedback);
        if (!id || !feedback) throw new Error("id and feedback are required");
        const task = await store.requestTaskChanges({ id, feedback });

        // Notify implementer
        await store.appendNote({
          text: `[CHANGES REQUESTED] Task "${task.title}" needs changes: ${feedback}`,
          author: "system"
        });

        return jsonResponse({
          ...task,
          _instruction: `Changes requested by planner: ${feedback}. Task returned to in_progress.`
        });
      }
      case "task_approve_batch": {
        const ids = getStringArray(args.ids);
        if (!ids || ids.length === 0) throw new Error("ids array is required and must not be empty");
        const feedback = getString(args.feedback);

        const results: Array<{ id: string; success: boolean; title?: string; error?: string }> = [];

        for (const id of ids) {
          try {
            const task = await store.approveTask({ id, feedback });
            results.push({ id, success: true, title: task.title });

            // Notify for each task
            await store.appendNote({
              text: `[APPROVED] Task "${task.title}" approved by planner.${feedback ? ` Feedback: ${feedback}` : ""}`,
              author: "system"
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            results.push({ id, success: false, error: message });
          }
        }

        // Check if all tasks are now complete
        const todoTasks = await store.listTasks({ status: "todo" });
        const inProgressTasks = await store.listTasks({ status: "in_progress" });
        const reviewTasks = await store.listTasks({ status: "review" });
        if (todoTasks.length === 0 && inProgressTasks.length === 0 && reviewTasks.length === 0) {
          await store.appendNote({
            text: "[SYSTEM] ALL TASKS COMPLETE! Planner: review the work and call project_status_set({ status: 'complete' }) if satisfied, or create more tasks.",
            author: "system"
          });
        }

        const successCount = results.filter(r => r.success).length;
        return jsonResponse({
          total: ids.length,
          approved: successCount,
          failed: ids.length - successCount,
          results,
          _instruction: successCount === ids.length
            ? `All ${successCount} tasks approved successfully.`
            : `Approved ${successCount}/${ids.length} tasks. Check results for failures.`
        });
      }
      case "task_summary": {
        const allTasks = await store.listTasks({});
        const summary = {
          total: allTasks.length,
          todo: allTasks.filter(t => t.status === "todo").length,
          in_progress: allTasks.filter(t => t.status === "in_progress").length,
          blocked: allTasks.filter(t => t.status === "blocked").length,
          review: allTasks.filter(t => t.status === "review").length,
          done: allTasks.filter(t => t.status === "done").length,
        };

        // Calculate completion percentage
        const completionPercent = summary.total > 0
          ? Math.round((summary.done / summary.total) * 100)
          : 0;

        // Get project status
        const projectRoot = config.roots[0] ?? process.cwd();
        const context = await store.getProjectContext(projectRoot);

        return jsonResponse({
          summary,
          completionPercent,
          projectStatus: context?.status ?? "unknown",
          _hint: summary.review > 0
            ? `${summary.review} task(s) pending review - use task_list({ status: "review" }) to see them`
            : summary.todo === 0 && summary.in_progress === 0 && summary.review === 0 && summary.total > 0
              ? "All tasks complete!"
              : undefined
        });
      }
      case "task_list": {
        const statusFilter = getString(args.status) as "todo" | "in_progress" | "blocked" | "review" | "done" | undefined;
        const includeDone = getBoolean(args.includeDone) ?? false;
        const offset = getNumber(args.offset) ?? 0;
        const limit = getNumber(args.limit);

        let tasks = await store.listTasks({
          status: statusFilter,
          owner: getString(args.owner),
          tag: getString(args.tag),
          limit: undefined, // We'll handle pagination ourselves
        });

        // If no specific status filter and includeDone is false, exclude done tasks for smaller responses
        if (!statusFilter && !includeDone) {
          tasks = tasks.filter(t => t.status !== "done");
        }

        // Apply pagination
        const totalBeforePagination = tasks.length;
        if (offset > 0) {
          tasks = tasks.slice(offset);
        }
        if (limit !== undefined && limit > 0) {
          tasks = tasks.slice(0, limit);
        }

        // Include project status so implementers can check if they should stop
        const projectRoot = config.roots[0] ?? process.cwd();
        const context = await store.getProjectContext(projectRoot);

        // Get counts for summary
        const allTasks = await store.listTasks({});
        const doneTasks = allTasks.filter(t => t.status === "done").length;

        return jsonResponse({
          tasks,
          total: totalBeforePagination,
          offset,
          hasMore: offset + tasks.length < totalBeforePagination,
          doneCount: doneTasks,
          projectStatus: context?.status ?? "unknown",
          _hint: context?.status === "stopped" ? "PROJECT STOPPED - cease work immediately" :
                 context?.status === "complete" ? "PROJECT COMPLETE - no more work needed" :
                 (!includeDone && doneTasks > 0) ? `${doneTasks} done task(s) hidden. Use includeDone=true or task_summary to see counts.` : undefined
        });
      }
      case "lock_acquire": {
        const pathValue = getString(args.path);
        if (!pathValue) throw new Error("path is required");
        const lock = await store.acquireLock({
          path: pathValue,
          owner: getString(args.owner),
          note: getString(args.note),
        });
        return jsonResponse(lock);
      }
      case "lock_release": {
        const pathValue = getString(args.path);
        if (!pathValue) throw new Error("path is required");
        const lock = await store.releaseLock({ path: pathValue, owner: getString(args.owner) });
        return jsonResponse(lock);
      }
      case "lock_list": {
        const locks = await store.listLocks({
          status: getString(args.status) as "active" | "resolved" | undefined,
          owner: getString(args.owner),
        });
        return jsonResponse(locks);
      }
      case "note_append": {
        const text = getString(args.text);
        if (!text) throw new Error("text is required");
        const note = await store.appendNote({ text, author: getString(args.author) });
        return jsonResponse(note);
      }
      case "note_list": {
        const notes = await store.listNotes(getNumber(args.limit));
        return jsonResponse(notes);
      }
      case "artifact_read": {
        const filePath = getString(args.path);
        if (!filePath) throw new Error("path is required");
        const result = await readFileSafe(filePath, {
          encoding: getString(args.encoding) as BufferEncoding | undefined,
          maxBytes: getNumber(args.maxBytes),
          binary: getBoolean(args.binary),
        });
        return jsonResponse(result);
      }
      case "artifact_write": {
        const filePath = getString(args.path);
        const content = getString(args.content);
        if (!filePath || content === undefined) throw new Error("path and content are required");
        const result = await writeFileSafe(filePath, content, {
          encoding: getString(args.encoding) as BufferEncoding | undefined,
          mode: getString(args.mode) as "overwrite" | "append" | undefined,
          createDirs: getBoolean(args.createDirs),
        });
        return jsonResponse(result);
      }
      case "file_read": {
        const filePath = getString(args.path);
        if (!filePath) throw new Error("path is required");
        const result = await readFileSafe(filePath, {
          encoding: getString(args.encoding) as BufferEncoding | undefined,
          maxBytes: getNumber(args.maxBytes),
          binary: getBoolean(args.binary),
        });
        return jsonResponse(result);
      }
      case "file_write": {
        const filePath = getString(args.path);
        const content = getString(args.content);
        if (!filePath || content === undefined) throw new Error("path and content are required");
        const result = await writeFileSafe(filePath, content, {
          encoding: getString(args.encoding) as BufferEncoding | undefined,
          mode: getString(args.mode) as "overwrite" | "append" | undefined,
          createDirs: getBoolean(args.createDirs),
        });
        return jsonResponse(result);
      }
      case "command_run": {
        const command = getString(args.command);
        if (!command) throw new Error("command is required");
        const result = await runCommand(command, {
          cwd: getString(args.cwd),
          timeoutMs: getNumber(args.timeoutMs),
          maxOutputBytes: getNumber(args.maxOutputBytes),
          env: getObject(args.env) as Record<string, string> | undefined,
        });
        return jsonResponse(result);
      }
      case "tool_install": {
        const manager = getString(args.manager);
        if (!manager) throw new Error("manager is required");
        const installArgs = getStringArray(args.args) ?? [];
        const command = [manager, ...installArgs].join(" ");
        const result = await runCommand(command, {
          cwd: getString(args.cwd),
          timeoutMs: getNumber(args.timeoutMs),
          env: getObject(args.env) as Record<string, string> | undefined,
        });
        return jsonResponse(result);
      }
      case "log_append": {
        const event = getString(args.event);
        if (!event) throw new Error("event is required");
        await store.appendLogEntry(event, getObject(args.payload));
        return jsonResponse({ ok: true });
      }
      case "coordination_init": {
        const role = getString(args.role);
        if (!role || (role !== "planner" && role !== "implementer")) {
          throw new Error("role must be 'planner' or 'implementer'");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const context = await store.getProjectContext(projectRoot);
        const tasks = await store.listTasks({ status: "todo" });
        const inProgressTasks = await store.listTasks({ status: "in_progress" });
        const doneTasks = await store.listTasks({ status: "done" });

        if (role === "planner") {
          // Phase 1: No project context - need to gather information
          if (!context) {
            return jsonResponse({
              role: "planner",
              status: "needs_context",
              phase: "gather_info",
              message: "No project context found. Follow these steps IN ORDER:",
              steps: [
                "1. If user already said what to work on, acknowledge it. Otherwise ASK.",
                "2. EXPLORE: Scan README.md, package.json, etc. to understand the codebase",
                "3. SUMMARIZE: Tell the user what you found",
                "4. ⛔ MANDATORY - ASK these questions and WAIT for answers:",
                "   - What is the desired END STATE? (What does 'done' look like?)",
                "   - What are your ACCEPTANCE CRITERIA?",
                "   - Any CONSTRAINTS I should know about?",
                "   - Should I use CLAUDE or CODEX as implementer?",
                "5. ONLY AFTER user answers: Call project_context_set"
              ],
              instruction: `CRITICAL: You MUST ask the user these questions and WAIT for their answers before proceeding.

Step 1: Explore the codebase (README, package.json, etc.)

Step 2: Summarize what you found to the user

Step 3: ⛔ STOP AND ASK - These questions are MANDATORY (do not skip or infer):
   "Before I create a plan, I need your input on a few things:

   1. What is the END STATE you want? What does 'done' look like?
   2. What are your ACCEPTANCE CRITERIA? How will we know it's complete?
   3. Are there any CONSTRAINTS or things I should avoid?
   4. Should I use CLAUDE or CODEX as the implementer?"

Step 4: WAIT for the user to answer

Step 5: Only AFTER getting answers, call project_context_set

DO NOT skip the questions. DO NOT infer the answers. The user must explicitly tell you.`
            });
          }

          // Phase 2: Have context but no implementation plan
          if (!context.implementationPlan?.length) {
            return jsonResponse({
              role: "planner",
              status: "needs_plan",
              phase: "create_plan",
              projectContext: context,
              message: "Project context exists. Now create and review the implementation plan WITH THE USER.",
              instruction: `Based on the project context, create a detailed implementation plan. Then BEFORE saving it:

1. EXPLAIN THE PLAN to the user:
   - Present each step/phase clearly
   - Explain your reasoning for the approach
   - Mention any trade-offs or decisions you made

2. ASK FOR FEEDBACK:
   - "Is there any additional context I should know?"
   - "Do you want me to change or add anything to this plan?"
   - "Any specific instructions or preferences for implementation?"

3. ASK FOR PERMISSION:
   - "Do I have your permission to proceed with implementation?"

4. ONLY AFTER user approves:
   - Call project_context_set with the implementationPlan array
   - Set status to 'ready'

DO NOT proceed to implementation without explicit user approval.`
            });
          }

          // Phase 3: Have plan but no tasks created
          if (tasks.length === 0 && inProgressTasks.length === 0 && doneTasks.length === 0) {
            const implType = context.preferredImplementer ?? "codex";
            return jsonResponse({
              role: "planner",
              status: "needs_tasks",
              phase: "create_tasks",
              projectContext: context,
              preferredImplementer: implType,
              message: "Implementation plan exists. Now create tasks from the plan.",
              instruction: `Create tasks using task_create based on the implementation plan. Each task should be specific and actionable. After creating tasks, use launch_implementer with type="${implType}" to spawn workers. Recommend 1-2 implementers for simple projects, more for complex ones (but avoid too many to prevent conflicts).`
            });
          }

          // Phase 4: Tasks exist - monitor progress
          const implementers = await store.listImplementers(projectRoot);
          const activeImplementers = implementers.filter(i => i.status === "active");
          const implType = context.preferredImplementer ?? "codex";

          return jsonResponse({
            role: "planner",
            status: "monitoring",
            phase: "monitor",
            projectContext: context,
            preferredImplementer: implType,
            taskSummary: {
              todo: tasks.length,
              inProgress: inProgressTasks.length,
              done: doneTasks.length
            },
            implementers: {
              total: implementers.length,
              active: activeImplementers.length
            },
instruction: tasks.length === 0 && inProgressTasks.length === 0
              ? "All tasks complete! Ask the user to verify the work. If satisfied, call project_status_set with status 'complete'. Otherwise create more tasks."
              : `FIRST STEPS (do these IN ORDER):
1. Call dashboard_open to launch the monitoring dashboard
2. Call implementer_reset to clear stale implementers from previous sessions
3. ASK THE USER: "Should I use Claude or Codex as the implementer?"
4. WAIT for their answer before launching any implementers
5. After user answers, call launch_implementer with their chosen type

${activeImplementers.length === 0
  ? `⚠️ NO ACTIVE IMPLEMENTERS - but ASK USER first which type they want before launching!`
  : `Active implementers: ${activeImplementers.length}. If they seem stale (not responding), call implementer_reset first.`}

⛔ CRITICAL REMINDERS:
- You MUST ask the user about implementer type before launching
- You are PROHIBITED from writing code or running builds
- DO NOT assume or infer the user's preferences - ASK THEM

Your allowed actions:
1. dashboard_open - Open monitoring dashboard
2. implementer_reset - Clear stale implementers
3. ASK user which implementer type they want (claude or codex)
4. launch_implementer - ONLY after user tells you which type
5. task_list, note_list - Monitor progress
6. task_approve, task_request_changes - Review submitted work
7. project_status_set - Mark complete when done`
          });
        } else {
          // IMPLEMENTER ROLE

          // Check if project is stopped or complete
          if (context?.status === "stopped") {
            return jsonResponse({
              role: "implementer",
              status: "stopped",
              message: "Project has been STOPPED by the planner. Cease all work.",
              instruction: "Stop working on tasks. The planner has halted the project. Wait for further instructions from the user."
            });
          }

          if (context?.status === "complete") {
            return jsonResponse({
              role: "implementer",
              status: "complete",
              message: "Project is COMPLETE. No more work needed.",
              instruction: "The project has been marked complete. No further action needed."
            });
          }

          // No tasks available
          if (tasks.length === 0 && inProgressTasks.length === 0) {
            return jsonResponse({
              role: "implementer",
              status: "waiting",
              message: "No tasks available yet. Waiting for planner to create tasks.",
              projectContext: context,
              instruction: "Wait briefly, then call task_list to check for new tasks. Keep checking periodically. Also check project status - if 'stopped' or 'complete', stop working."
            });
          }

          // Tasks available - work loop
          return jsonResponse({
            role: "implementer",
            status: "ready",
            projectContext: context,
            availableTasks: tasks.length,
            inProgressTasks: inProgressTasks.length,
            instruction: `CONTINUOUS WORK LOOP:
1. Call task_list to see available tasks
2. Call discussion_inbox({ agent: "YOUR_NAME" }) to check for discussions needing your input
3. If discussions waiting -> respond with discussion_reply before continuing
4. Call task_claim to take a 'todo' task
5. Call lock_acquire before editing any file
6. Do the work
7. Call lock_release when done with file
8. Call task_update to mark task 'done'
9. REPEAT: Go back to step 1 and get the next task
10. STOP CONDITIONS: If project status becomes 'stopped' or 'complete', cease work

DISCUSSIONS:
- Use discussion_start to ask questions about architecture or implementation
- Check discussion_inbox between tasks
- Respond with discussion_reply including your recommendation

IMPORTANT: Keep working until all tasks are done or project is stopped. Do not wait for user input between tasks.`
          });
        }
      }
      case "project_context_set": {
        const description = getString(args.description);
        const endState = getString(args.endState);
        if (!description || !endState) {
          throw new Error("description and endState are required");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const statusValue = getString(args.status) as "planning" | "ready" | "in_progress" | "complete" | "stopped" | undefined;
        const preferredImpl = getString(args.preferredImplementer) as "claude" | "codex" | undefined;
        const context = await store.setProjectContext({
          projectRoot,
          description,
          endState,
          techStack: getStringArray(args.techStack),
          constraints: getStringArray(args.constraints),
          acceptanceCriteria: getStringArray(args.acceptanceCriteria),
          tests: getStringArray(args.tests),
          implementationPlan: getStringArray(args.implementationPlan),
          preferredImplementer: preferredImpl,
          status: statusValue,
        });

        // Determine next instruction based on what's provided
        let instruction = "Project context saved.";
        if (!context.acceptanceCriteria?.length) {
          instruction += " Consider adding acceptance criteria.";
        }
        if (!context.implementationPlan?.length) {
          instruction += " Create an implementation plan, then create tasks with task_create.";
        } else {
          instruction += " Create tasks from the implementation plan with task_create, or use launch_implementer to spawn workers.";
        }

        return jsonResponse({
          success: true,
          context,
          instruction
        });
      }
      case "project_context_get": {
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const context = await store.getProjectContext(projectRoot);
        if (!context) {
          return jsonResponse({
            found: false,
            message: "No project context found. The planner needs to set it using project_context_set."
          });
        }
        return jsonResponse({
          found: true,
          context
        });
      }
      case "project_status_set": {
        const status = getString(args.status) as "planning" | "ready" | "in_progress" | "complete" | "stopped" | undefined;
        if (!status) {
          throw new Error("status is required");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const context = await store.updateProjectStatus(projectRoot, status);

        let message = `Project status updated to '${status}'.`;
        if (status === "stopped") {
          message += " All implementers should stop working and check back.";
          // Add a note to communicate the stop signal
          await store.appendNote({
            text: `[SYSTEM] Project status changed to STOPPED. All implementers should cease work.`,
            author: "system"
          });
        } else if (status === "complete") {
          message += " Project is marked as complete.";
          await store.appendNote({
            text: `[SYSTEM] Project marked as COMPLETE. Great work!`,
            author: "system"
          });
        }

        return jsonResponse({
          success: true,
          context,
          message
        });
      }
      case "launch_implementer": {
        const type = getString(args.type) as "claude" | "codex" | undefined;
        if (!type) {
          throw new Error("type is required");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();

        // Auto-generate name if not provided
        let name = getString(args.name);
        if (!name) {
          const existingImplementers = await store.listImplementers(projectRoot);
          // Find the highest impl-N number
          let maxNum = 0;
          for (const impl of existingImplementers) {
            const match = impl.name.match(/^impl-(\d+)$/);
            if (match) {
              maxNum = Math.max(maxNum, parseInt(match[1], 10));
            }
          }
          name = `impl-${maxNum + 1}`;
        }
        const isolation = getString(args.isolation) as "shared" | "worktree" | undefined ?? "shared";

        // Check if this is the first implementer - if so, launch dashboard too
        const existingImplementers = await store.listImplementers(projectRoot);
        const isFirstImplementer = existingImplementers.filter(i => i.status === "active").length === 0;

        // Handle worktree creation if isolation is worktree
        let worktreePath: string | undefined;
        let branchName: string | undefined;
        let workingDirectory = projectRoot;

        if (isolation === "worktree") {
          // Check if this is a git repo
          const isGit = await isGitRepo(projectRoot);
          if (!isGit) {
            return jsonResponse({
              success: false,
              error: "Cannot use worktree isolation: project is not a git repository. Use isolation='shared' instead."
            });
          }

          try {
            const wtResult = await createWorktree(projectRoot, name);
            worktreePath = wtResult.worktreePath;
            branchName = wtResult.branchName;
            workingDirectory = worktreePath;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return jsonResponse({
              success: false,
              error: `Failed to create worktree: ${message}. Try isolation='shared' instead.`
            });
          }
        }

        // Build the prompt that will be injected
        const worktreeNote = isolation === "worktree" ? ` You are working in an isolated worktree at ${worktreePath}. Your changes are on branch ${branchName}.` : "";
        const prompt = `You are implementer ${name}.${worktreeNote} Run: coordination_init({ role: "implementer" })`;

        // Determine the command to run
        let terminalCmd: string;
        if (type === "claude") {
          // Claude: use --dangerously-skip-permissions for autonomous work
          // Use -p for initial prompt, which will start an interactive session
          terminalCmd = `claude --dangerously-skip-permissions "${prompt}"`;
        } else {
          // Codex: --full-auto for autonomous work, pass prompt as quoted argument
          terminalCmd = `codex --full-auto "${prompt}"`;
        }

        try {
          // Helper to escape strings for AppleScript inside shell
          const escapeForAppleScript = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

          // Launch dashboard first if this is the first implementer
          if (isFirstImplementer) {
            const cliPath = path.resolve(__dirname, "cli.js");
            // Pass --roots so dashboard knows which project to display
            const dashCmd = `node "${escapeForAppleScript(cliPath)}" dashboard --roots "${escapeForAppleScript(projectRoot)}"`;
            // Use spawn instead of execSync to avoid blocking/session issues
            spawn("osascript", ["-e", `tell application "Terminal" to do script "${escapeForAppleScript(dashCmd)}"`], {
              detached: true,
              stdio: "ignore"
            }).unref();
            // Open browser after a brief delay (in background)
            spawn("sh", ["-c", "sleep 3 && open http://127.0.0.1:8787"], {
              detached: true,
              stdio: "ignore"
            }).unref();
          }

          // Launch the implementer terminal (in worktree directory if applicable)
          const implCmd = `cd "${escapeForAppleScript(workingDirectory)}" && ${terminalCmd}`;
          // Use spawn instead of execSync to avoid blocking/session issues
          spawn("osascript", ["-e", `tell application "Terminal" to do script "${escapeForAppleScript(implCmd)}"`], {
            detached: true,
            stdio: "ignore"
          }).unref();

          // Register the implementer with worktree info
          const implementer = await store.registerImplementer({
            name,
            type,
            projectRoot,
            pid: undefined,
            isolation,
            worktreePath,
            branchName,
          });

          // Update project status to in_progress if it was ready
          const context = await store.getProjectContext(projectRoot);
          if (context?.status === "ready") {
            await store.updateProjectStatus(projectRoot, "in_progress");
          }

          const worktreeMsg = isolation === "worktree" ? ` with isolated worktree (branch: ${branchName})` : "";
          await store.appendNote({
            text: `[SYSTEM] Launched implementer "${name}" (${type})${worktreeMsg}${isFirstImplementer ? " and dashboard" : ""}`,
            author: "system"
          });

          return jsonResponse({
            success: true,
            implementer,
            dashboardLaunched: isFirstImplementer,
            isolation,
            worktreePath,
            branchName,
            message: `Launched ${type} implementer "${name}"${worktreeMsg} in a new terminal window.${isFirstImplementer ? " Dashboard also launched at http://127.0.0.1:8787" : ""}`
          });
        } catch (error) {
          // Clean up worktree if launch failed
          if (worktreePath) {
            try {
              await removeWorktree(worktreePath);
            } catch {
              // Ignore cleanup errors
            }
          }
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            success: false,
            error: `Failed to launch implementer: ${message}. You may need to launch manually: cd '${workingDirectory}' && ${terminalCmd}`
          });
        }
      }
      case "implementer_list": {
        const projectRoot = getString(args.projectRoot);
        const implementers = await store.listImplementers(projectRoot);
        const active = implementers.filter(i => i.status === "active");
        return jsonResponse({
          total: implementers.length,
          active: active.length,
          implementers
        });
      }
      case "implementer_reset": {
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const count = await store.resetImplementers(projectRoot);
        await store.appendNote({
          text: `[SYSTEM] Reset ${count} implementer(s) to stopped status for fresh session`,
          author: "system"
        });
        return jsonResponse({
          success: true,
          resetCount: count,
          message: `Reset ${count} implementer(s) to stopped status. You can now launch fresh implementers.`
        });
      }
      case "session_reset": {
        const confirm = getBoolean(args.confirm);
        if (!confirm) {
          return jsonResponse({
            success: false,
            error: "Session reset requires confirm: true to proceed. This will clear all tasks, locks, notes, and archive discussions."
          });
        }

        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const keepProjectContext = getBoolean(args.keepProjectContext) ?? false;

        const result = await store.resetSession(projectRoot, { keepProjectContext });

        return jsonResponse({
          success: true,
          ...result,
          message: `Session reset complete. Cleared ${result.tasksCleared} tasks, ${result.locksCleared} locks, ${result.notesCleared} notes. Reset ${result.implementersReset} implementers, archived ${result.discussionsArchived} discussions.${keepProjectContext ? " Project context preserved (status reset to planning)." : " Project context cleared."}`,
          nextSteps: [
            "1. Call coordination_init({ role: 'planner' }) to start fresh",
            "2. Set up project context with project_context_set",
            "3. Create tasks and launch implementers"
          ]
        });
      }
      case "dashboard_open": {
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        try {
          const escapeForAppleScript = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const cliPath = path.resolve(__dirname, "cli.js");
          const dashCmd = `node "${escapeForAppleScript(cliPath)}" dashboard --roots "${escapeForAppleScript(projectRoot)}"`;

          // Launch dashboard in new terminal
          spawn("osascript", ["-e", `tell application "Terminal" to do script "${escapeForAppleScript(dashCmd)}"`], {
            detached: true,
            stdio: "ignore"
          }).unref();

          // Open browser after a brief delay
          spawn("sh", ["-c", "sleep 2 && open http://127.0.0.1:8787"], {
            detached: true,
            stdio: "ignore"
          }).unref();

          return jsonResponse({
            success: true,
            message: "Dashboard launching at http://127.0.0.1:8787"
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            success: false,
            error: `Failed to launch dashboard: ${message}`
          });
        }
      }
      // Discussion handlers
      case "discussion_start": {
        const topic = getString(args.topic);
        const message = getString(args.message);
        const author = getString(args.author);
        if (!topic || !message || !author) {
          throw new Error("topic, message, and author are required");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();
        const category = (getString(args.category) ?? "other") as "architecture" | "implementation" | "blocker" | "question" | "other";
        const priority = (getString(args.priority) ?? "medium") as "low" | "medium" | "high" | "blocking";
        const waitingOn = getString(args.waitingOn);

        const result = await store.createDiscussion({
          topic,
          category,
          priority,
          message,
          createdBy: author,
          projectRoot,
          waitingOn,
        });

        // Also post a note so other agents see the new discussion
        await store.appendNote({
          text: `[DISCUSSION] New thread: "${topic}" (${result.discussion.id}) - ${author} is waiting for input${waitingOn ? ` from ${waitingOn}` : ""}`,
          author: "system"
        });

        return jsonResponse({
          success: true,
          discussion: result.discussion,
          message: result.message,
          instruction: waitingOn
            ? `Discussion started. Waiting for ${waitingOn} to respond. Continue with other work and check back later.`
            : "Discussion started. Other agents can reply using discussion_reply."
        });
      }
      case "discussion_reply": {
        const discussionId = getString(args.discussionId);
        const message = getString(args.message);
        const author = getString(args.author);
        if (!discussionId || !message || !author) {
          throw new Error("discussionId, message, and author are required");
        }

        const result = await store.replyToDiscussion({
          discussionId,
          author,
          message,
          recommendation: getString(args.recommendation),
          waitingOn: getString(args.waitingOn),
        });

        return jsonResponse({
          success: true,
          discussion: result.discussion,
          message: result.message,
          instruction: result.discussion.waitingOn
            ? `Reply posted. Now waiting for ${result.discussion.waitingOn} to respond.`
            : "Reply posted. Discussion is open for further replies or resolution."
        });
      }
      case "discussion_resolve": {
        const discussionId = getString(args.discussionId);
        const decision = getString(args.decision);
        const reasoning = getString(args.reasoning);
        const decidedBy = getString(args.decidedBy);
        if (!discussionId || !decision || !reasoning || !decidedBy) {
          throw new Error("discussionId, decision, reasoning, and decidedBy are required");
        }

        const discussion = await store.resolveDiscussion({
          discussionId,
          decision,
          reasoning,
          decidedBy,
          linkedTaskId: getString(args.linkedTaskId),
        });

        // Post a note about the resolution
        await store.appendNote({
          text: `[DECISION] "${discussion.topic}" resolved: ${decision} (by ${decidedBy})`,
          author: "system"
        });

        return jsonResponse({
          success: true,
          discussion,
          instruction: "Discussion resolved and decision recorded. This creates an audit trail for future reference."
        });
      }
      case "discussion_get": {
        const discussionId = getString(args.discussionId);
        if (!discussionId) throw new Error("discussionId is required");

        const result = await store.getDiscussion(discussionId);
        if (!result) {
          return jsonResponse({ found: false, message: "Discussion not found" });
        }

        return jsonResponse({
          found: true,
          discussion: result.discussion,
          messages: result.messages,
          messageCount: result.messages.length
        });
      }
      case "discussion_list": {
        const discussions = await store.listDiscussions({
          status: getString(args.status) as "open" | "waiting" | "resolved" | "archived" | undefined,
          category: getString(args.category) as "architecture" | "implementation" | "blocker" | "question" | "other" | undefined,
          projectRoot: getString(args.projectRoot),
          waitingOn: getString(args.waitingOn),
          limit: getNumber(args.limit),
        });

        return jsonResponse({
          count: discussions.length,
          discussions
        });
      }
      case "discussion_inbox": {
        const agent = getString(args.agent);
        if (!agent) throw new Error("agent is required");

        const projectRoot = getString(args.projectRoot);
        const discussions = await store.listDiscussions({
          status: "waiting",
          waitingOn: agent,
          projectRoot,
        });

        return jsonResponse({
          agent,
          waitingCount: discussions.length,
          discussions,
          instruction: discussions.length > 0
            ? `You have ${discussions.length} discussion(s) waiting for your input. Use discussion_get to see full thread, then discussion_reply to respond.`
            : "No discussions waiting for your input."
        });
      }
      case "discussion_archive": {
        const discussionId = getString(args.discussionId);
        if (!discussionId) throw new Error("discussionId is required");

        const discussion = await store.archiveDiscussion(discussionId);
        return jsonResponse({
          success: true,
          discussion,
          message: "Discussion archived. It will be deleted after the retention period."
        });
      }
      case "discussion_cleanup": {
        const archiveDays = getNumber(args.archiveOlderThanDays) ?? 7;
        const deleteDays = getNumber(args.deleteOlderThanDays) ?? 30;
        const projectRoot = getString(args.projectRoot);

        const archived = await store.archiveOldDiscussions({
          olderThanDays: archiveDays,
          projectRoot,
        });

        const deleted = await store.deleteArchivedDiscussions({
          olderThanDays: deleteDays,
          projectRoot,
        });

        return jsonResponse({
          success: true,
          archived,
          deleted,
          message: `Archived ${archived} resolved discussions older than ${archiveDays} days. Deleted ${deleted} archived discussions older than ${deleteDays} days.`
        });
      }
      // Worktree handlers
      case "worktree_status": {
        const implementerId = getString(args.implementerId);
        if (!implementerId) throw new Error("implementerId is required");

        const implementers = await store.listImplementers();
        const impl = implementers.find(i => i.id === implementerId);
        if (!impl) {
          return jsonResponse({ found: false, error: "Implementer not found" });
        }

        if (impl.isolation !== "worktree" || !impl.worktreePath) {
          return jsonResponse({
            found: true,
            implementer: impl,
            isolation: impl.isolation,
            message: "Implementer is not using worktree isolation"
          });
        }

        try {
          const status = await getWorktreeStatus(impl.worktreePath);
          const diff = await getWorktreeDiff(impl.worktreePath);
          return jsonResponse({
            found: true,
            implementer: impl,
            worktreeStatus: status,
            diff,
            instruction: status.hasUncommittedChanges
              ? "Implementer has uncommitted changes. They should commit before merge."
              : status.ahead > 0
                ? `Implementer has ${status.ahead} commit(s) ready to merge.`
                : "No changes to merge."
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            found: true,
            implementer: impl,
            error: `Failed to get worktree status: ${message}`
          });
        }
      }
      case "worktree_merge": {
        const implementerId = getString(args.implementerId);
        if (!implementerId) throw new Error("implementerId is required");

        const implementers = await store.listImplementers();
        const impl = implementers.find(i => i.id === implementerId);
        if (!impl) {
          return jsonResponse({ success: false, error: "Implementer not found" });
        }

        if (impl.isolation !== "worktree" || !impl.worktreePath) {
          return jsonResponse({
            success: false,
            error: "Implementer is not using worktree isolation"
          });
        }

        const targetBranch = getString(args.targetBranch);

        try {
          const result = await mergeWorktree(impl.worktreePath, targetBranch);

          if (result.success && result.merged) {
            // Optionally clean up the worktree after successful merge
            await store.appendNote({
              text: `[SYSTEM] Merged ${impl.name}'s worktree (${impl.branchName}) to ${targetBranch ?? "main"}`,
              author: "system"
            });
          }

          return jsonResponse({
            success: result.success,
            merged: result.merged,
            conflicts: result.conflicts,
            error: result.error,
            instruction: result.conflicts
              ? `Merge has conflicts in: ${result.conflicts.join(", ")}. Resolve manually or use task_request_changes to have implementer fix.`
              : result.merged
                ? "Changes merged successfully."
                : result.error
                  ? `Merge failed: ${result.error}`
                  : "Nothing to merge."
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            success: false,
            error: `Failed to merge worktree: ${message}`
          });
        }
      }
      case "worktree_list": {
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();

        const isGit = await isGitRepo(projectRoot);
        if (!isGit) {
          return jsonResponse({
            worktrees: [],
            message: "Project is not a git repository"
          });
        }

        try {
          const worktrees = await listWorktrees(projectRoot);
          const implementers = await store.listImplementers(projectRoot);

          // Enrich worktree info with implementer data
          const enriched = worktrees.map(wt => {
            const impl = implementers.find(i => i.worktreePath === wt.path);
            return {
              ...wt,
              implementer: impl ? { id: impl.id, name: impl.name, status: impl.status } : null
            };
          });

          return jsonResponse({
            count: worktrees.length,
            worktrees: enriched
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            worktrees: [],
            error: `Failed to list worktrees: ${message}`
          });
        }
      }
      case "worktree_cleanup": {
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();

        const isGit = await isGitRepo(projectRoot);
        if (!isGit) {
          return jsonResponse({
            success: false,
            error: "Project is not a git repository"
          });
        }

        try {
          const cleaned = await cleanupOrphanedWorktrees(projectRoot);
          return jsonResponse({
            success: true,
            cleanedCount: cleaned.length,
            cleaned,
            message: cleaned.length > 0
              ? `Cleaned up ${cleaned.length} orphaned worktree(s)`
              : "No orphaned worktrees found"
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            success: false,
            error: `Failed to cleanup worktrees: ${message}`
          });
        }
      }
      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(message);
  }
});

export async function startServer() {
  await store.init();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

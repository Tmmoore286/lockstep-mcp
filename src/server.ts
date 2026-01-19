import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

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
    description: "Create a task",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] },
        owner: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
      required: ["title"],
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
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] },
        owner: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_list",
    description: "List tasks with optional filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["todo", "in_progress", "blocked", "done"] },
        owner: { type: "string" },
        tag: { type: "string" },
        limit: { type: "number" },
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
    description: "Launch a new implementer agent (Claude or Codex) in a new terminal window. The planner uses this to spawn workers.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["claude", "codex"], description: "Type of agent to launch" },
        name: { type: "string", description: "Name for this implementer (e.g., 'impl-1')" },
        projectRoot: { type: "string", description: "Project root path (defaults to first configured root)" },
      },
      required: ["type", "name"],
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
        if (!title) throw new Error("title is required");
        const task = await store.createTask({
          title,
          description: getString(args.description),
          status: getString(args.status) as "todo" | "in_progress" | "blocked" | "done" | undefined,
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
        return jsonResponse(task);
      }
      case "task_update": {
        const id = getString(args.id);
        if (!id) throw new Error("id is required");
        const newStatus = getString(args.status) as "todo" | "in_progress" | "blocked" | "done" | undefined;
        const task = await store.updateTask({
          id,
          title: getString(args.title),
          description: getString(args.description),
          status: newStatus,
          owner: getString(args.owner),
          tags: getStringArray(args.tags),
          metadata: getObject(args.metadata),
        });

        // Check if all tasks are now complete
        if (newStatus === "done") {
          const todoTasks = await store.listTasks({ status: "todo" });
          const inProgressTasks = await store.listTasks({ status: "in_progress" });
          if (todoTasks.length === 0 && inProgressTasks.length === 0) {
            // All tasks complete - notify planner
            await store.appendNote({
              text: "[SYSTEM] ALL TASKS COMPLETE! Planner: review the work and call project_status_set({ status: 'complete' }) if satisfied, or create more tasks.",
              author: "system"
            });
          }
        }

        return jsonResponse(task);
      }
      case "task_list": {
        const tasks = await store.listTasks({
          status: getString(args.status) as "todo" | "in_progress" | "blocked" | "done" | undefined,
          owner: getString(args.owner),
          tag: getString(args.tag),
          limit: getNumber(args.limit),
        });
        // Include project status so implementers can check if they should stop
        const projectRoot = config.roots[0] ?? process.cwd();
        const context = await store.getProjectContext(projectRoot);
        return jsonResponse({
          tasks,
          projectStatus: context?.status ?? "unknown",
          _hint: context?.status === "stopped" ? "PROJECT STOPPED - cease work immediately" :
                 context?.status === "complete" ? "PROJECT COMPLETE - no more work needed" : undefined
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
              message: "No project context found. Gather information in this order:",
              steps: [
                "1. ASK: What project/task are we working on today?",
                "2. EXPLORE: Scan for README.md, package.json, and other docs to understand the codebase",
                "3. SUMMARIZE: Tell the user what you found and your understanding",
                "4. ASK CLARIFYING QUESTIONS based on what's missing or unclear:",
                "   - What is the desired end state/goal?",
                "   - Any specific requirements or constraints?",
                "   - What are the acceptance criteria?",
                "   - What tests should pass when complete?",
                "   - What type of implementer should I launch - Claude or Codex?",
                "5. SAVE: Call project_context_set with gathered + user-provided info"
              ],
              instruction: `START by asking the user: "What project or task are we working on today?"

After they answer:
1. Read README.md, package.json, CLAUDE.md, and other relevant docs
2. Summarize what you found: "Based on the codebase, I can see this is a [X] project using [Y]..."
3. Ask CLARIFYING questions for anything not covered:
   - End state/goal (what does "done" look like?)
   - Constraints or requirements
   - Acceptance criteria
   - Tests that should pass
   - Preferred implementer type (Claude or Codex)
4. Only call project_context_set AFTER user confirms

The user is waiting. Start by asking what we're working on.`
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
              ? "All tasks complete! Review the work, run tests, and if satisfied, call project_status_set with status 'complete'. Otherwise create more tasks."
              : `Monitor progress via task_list and note_list. Use note_append to communicate with implementers. Use launch_implementer with type="${implType}" to add more workers if needed. When all work is done, set project status to 'complete'. To stop all work, set status to 'stopped'.`
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
        const name = getString(args.name);
        if (!type || !name) {
          throw new Error("type and name are required");
        }
        const projectRoot = getString(args.projectRoot) ?? config.roots[0] ?? process.cwd();

        // Check if this is the first implementer - if so, launch dashboard too
        const existingImplementers = await store.listImplementers(projectRoot);
        const isFirstImplementer = existingImplementers.filter(i => i.status === "active").length === 0;

        // Determine the command to run
        const cmd = type === "claude" ? "claude" : "codex";

        // Build the prompt that will be injected
        const prompt = `You are the implementer named "${name}". Initialize with: coordination_init({ role: "implementer" }). Then continuously work on tasks until the project status is "stopped" or "complete".`;

        // Launch in a new terminal window (macOS)
        const osascript = `
          tell application "Terminal"
            activate
            do script "cd '${projectRoot}' && ${cmd} --print '${prompt.replace(/'/g, "\\'")}'"
          end tell
        `;

        try {
          // Launch dashboard first if this is the first implementer
          if (isFirstImplementer) {
            // Use full path to cli.js instead of relying on lockstep-mcp being in PATH
            const cliPath = path.resolve(__dirname, "cli.js");
            const dashboardScript = `
              tell application "Terminal"
                activate
                do script "cd '${projectRoot}' && node '${cliPath}' dashboard"
              end tell
            `;
            const dashChild = spawn("osascript", ["-e", dashboardScript], {
              detached: true,
              stdio: "ignore"
            });
            dashChild.unref();
          }

          const child = spawn("osascript", ["-e", osascript], {
            detached: true,
            stdio: "ignore"
          });
          child.unref();

          // Register the implementer
          const implementer = await store.registerImplementer({
            name,
            type,
            projectRoot,
            pid: child.pid
          });

          // Update project status to in_progress if it was ready
          const context = await store.getProjectContext(projectRoot);
          if (context?.status === "ready") {
            await store.updateProjectStatus(projectRoot, "in_progress");
          }

          await store.appendNote({
            text: `[SYSTEM] Launched implementer "${name}" (${type})${isFirstImplementer ? " and dashboard" : ""}`,
            author: "system"
          });

          return jsonResponse({
            success: true,
            implementer,
            dashboardLaunched: isFirstImplementer,
            message: `Launched ${type} implementer "${name}" in a new terminal window.${isFirstImplementer ? " Dashboard also launched at http://127.0.0.1:8787" : ""}`
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return jsonResponse({
            success: false,
            error: `Failed to launch implementer: ${message}. You may need to launch manually: cd '${projectRoot}' && ${cmd}`
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

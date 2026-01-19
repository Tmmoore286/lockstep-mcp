import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { resolvePath, ensureDir } from "./utils.js";
import { Store } from "./storage.js";

const config = loadConfig();
const store = new Store(config.dataDir, config.logDir);

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
        const task = await store.updateTask({
          id,
          title: getString(args.title),
          description: getString(args.description),
          status: getString(args.status) as "todo" | "in_progress" | "blocked" | "done" | undefined,
          owner: getString(args.owner),
          tags: getStringArray(args.tags),
          metadata: getObject(args.metadata),
        });
        return jsonResponse(task);
      }
      case "task_list": {
        const tasks = await store.listTasks({
          status: getString(args.status) as "todo" | "in_progress" | "blocked" | "done" | undefined,
          owner: getString(args.owner),
          tag: getString(args.tag),
          limit: getNumber(args.limit),
        });
        return jsonResponse(tasks);
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

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, sleep } from "./utils.js";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export type LockStatus = "active" | "resolved";

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  owner?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type Lock = {
  path: string;
  owner?: string;
  note?: string;
  status: LockStatus;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  text: string;
  author?: string;
  createdAt: string;
};

export type State = {
  tasks: Task[];
  locks: Lock[];
  notes: Note[];
};

const DEFAULT_STATE: State = {
  tasks: [],
  locks: [],
  notes: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

export class Store {
  private statePath: string;
  private lockPath: string;
  private logDir: string;

  constructor(private dataDir: string, logDir: string) {
    this.statePath = path.join(this.dataDir, "state.json");
    this.lockPath = path.join(this.dataDir, "state.lock");
    this.logDir = logDir;
  }

  async init(): Promise<void> {
    await ensureDir(this.dataDir);
    await ensureDir(this.logDir);
  }

  private async loadState(): Promise<State> {
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      return { ...DEFAULT_STATE, ...JSON.parse(raw) } as State;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return { ...DEFAULT_STATE };
      throw error;
    }
  }

  private async saveState(state: State): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify(state, null, 2), "utf8");
  }

  private async withStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    const timeoutMs = 5000;
    while (true) {
      try {
        const handle = await fs.open(this.lockPath, "wx");
        await handle.close();
        break;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== "EEXIST") throw error;
        if (Date.now() - start > timeoutMs) {
          throw new Error("Timed out waiting for state lock");
        }
        await sleep(50);
      }
    }

    try {
      return await fn();
    } finally {
      await fs.unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async appendLog(event: string, payload: Record<string, unknown>): Promise<void> {
    const logPath = path.join(this.logDir, "events.jsonl");
    const line = JSON.stringify({ ts: nowIso(), event, ...payload });
    await fs.appendFile(logPath, `${line}\n`, "utf8");
  }

  async status(): Promise<State> {
    return this.loadState();
  }

  async createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task> {
    return this.withStateLock(async () => {
      const state = await this.loadState();
      const task: Task = {
        id: crypto.randomUUID(),
        title: input.title,
        description: input.description,
        status: input.status ?? "todo",
        owner: input.owner,
        tags: input.tags,
        metadata: input.metadata,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.tasks.push(task);
      await this.saveState(state);
      await this.appendLog("task_create", { task });
      return task;
    });
  }

  async updateTask(input: {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task> {
    return this.withStateLock(async () => {
      const state = await this.loadState();
      const task = state.tasks.find((item) => item.id === input.id);
      if (!task) throw new Error(`Task not found: ${input.id}`);
      if (input.title !== undefined) task.title = input.title;
      if (input.description !== undefined) task.description = input.description;
      if (input.status !== undefined) task.status = input.status;
      if (input.owner !== undefined) task.owner = input.owner;
      if (input.tags !== undefined) task.tags = input.tags;
      if (input.metadata !== undefined) task.metadata = input.metadata;
      task.updatedAt = nowIso();
      await this.saveState(state);
      await this.appendLog("task_update", { task });
      return task;
    });
  }

  async claimTask(input: { id: string; owner: string }): Promise<Task> {
    return this.updateTask({ id: input.id, owner: input.owner, status: "in_progress" });
  }

  async listTasks(filters?: {
    status?: TaskStatus;
    owner?: string;
    tag?: string;
    limit?: number;
  }): Promise<Task[]> {
    const state = await this.loadState();
    let tasks = [...state.tasks];
    if (filters?.status) tasks = tasks.filter((task) => task.status === filters.status);
    if (filters?.owner) tasks = tasks.filter((task) => task.owner === filters.owner);
    if (filters?.tag) tasks = tasks.filter((task) => task.tags?.includes(filters.tag ?? ""));
    if (filters?.limit && filters.limit > 0) tasks = tasks.slice(0, filters.limit);
    return tasks;
  }

  async acquireLock(input: { path: string; owner?: string; note?: string }): Promise<Lock> {
    return this.withStateLock(async () => {
      const state = await this.loadState();
      const existing = state.locks.find((lock) => lock.path === input.path && lock.status === "active");
      if (existing) throw new Error(`Lock already active for ${input.path}`);
      const lock: Lock = {
        path: input.path,
        owner: input.owner,
        note: input.note,
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      state.locks.push(lock);
      await this.saveState(state);
      await this.appendLog("lock_acquire", { lock });
      return lock;
    });
  }

  async releaseLock(input: { path: string; owner?: string }): Promise<Lock> {
    return this.withStateLock(async () => {
      const state = await this.loadState();
      const lock = state.locks.find((item) => item.path === input.path && item.status === "active");
      if (!lock) throw new Error(`Active lock not found for ${input.path}`);
      if (input.owner && lock.owner && input.owner !== lock.owner) {
        throw new Error(`Lock owned by ${lock.owner}, not ${input.owner}`);
      }
      lock.status = "resolved";
      lock.updatedAt = nowIso();
      await this.saveState(state);
      await this.appendLog("lock_release", { lock });
      return lock;
    });
  }

  async listLocks(filters?: { status?: LockStatus; owner?: string }): Promise<Lock[]> {
    const state = await this.loadState();
    let locks = [...state.locks];
    if (filters?.status) locks = locks.filter((lock) => lock.status === filters.status);
    if (filters?.owner) locks = locks.filter((lock) => lock.owner === filters.owner);
    return locks;
  }

  async appendNote(input: { text: string; author?: string }): Promise<Note> {
    return this.withStateLock(async () => {
      const state = await this.loadState();
      const note: Note = {
        id: crypto.randomUUID(),
        text: input.text,
        author: input.author,
        createdAt: nowIso(),
      };
      state.notes.push(note);
      await this.saveState(state);
      await this.appendLog("note_append", { note });
      return note;
    });
  }

  async listNotes(limit?: number): Promise<Note[]> {
    const state = await this.loadState();
    if (!limit || limit <= 0) return [...state.notes];
    return state.notes.slice(Math.max(state.notes.length - limit, 0));
  }

  async appendLogEntry(event: string, payload?: Record<string, unknown>): Promise<void> {
    await this.appendLog(event, payload ?? {});
  }
}

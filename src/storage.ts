import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { ensureDir, sleep } from "./utils.js";
import type { Config } from "./config.js";

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

export interface Store {
  init(): Promise<void>;
  status(): Promise<State>;
  createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task>;
  updateTask(input: {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task>;
  claimTask(input: { id: string; owner: string }): Promise<Task>;
  listTasks(filters?: {
    status?: TaskStatus;
    owner?: string;
    tag?: string;
    limit?: number;
  }): Promise<Task[]>;
  acquireLock(input: { path: string; owner?: string; note?: string }): Promise<Lock>;
  releaseLock(input: { path: string; owner?: string }): Promise<Lock>;
  listLocks(filters?: { status?: LockStatus; owner?: string }): Promise<Lock[]>;
  appendNote(input: { text: string; author?: string }): Promise<Note>;
  listNotes(limit?: number): Promise<Note[]>;
  appendLogEntry(event: string, payload?: Record<string, unknown>): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function appendLog(logDir: string, event: string, payload: Record<string, unknown>): Promise<void> {
  const logPath = path.join(logDir, "events.jsonl");
  const line = JSON.stringify({ ts: nowIso(), event, ...payload });
  await fs.appendFile(logPath, `${line}\n`, "utf8");
}

const DEFAULT_STATE: State = {
  tasks: [],
  locks: [],
  notes: [],
};

export class JsonStore implements Store {
  private statePath: string;
  private lockPath: string;

  constructor(private dataDir: string, private logDir: string) {
    this.statePath = path.join(this.dataDir, "state.json");
    this.lockPath = path.join(this.dataDir, "state.lock");
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
      await appendLog(this.logDir, "task_create", { task });
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
      await appendLog(this.logDir, "task_update", { task });
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
      await appendLog(this.logDir, "lock_acquire", { lock });
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
      await appendLog(this.logDir, "lock_release", { lock });
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
      await appendLog(this.logDir, "note_append", { note });
      return note;
    });
  }

  async listNotes(limit?: number): Promise<Note[]> {
    const state = await this.loadState();
    if (!limit || limit <= 0) return [...state.notes];
    return state.notes.slice(Math.max(state.notes.length - limit, 0));
  }

  async appendLogEntry(event: string, payload?: Record<string, unknown>): Promise<void> {
    await appendLog(this.logDir, event, payload ?? {});
  }
}

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  owner: string | null;
  tags: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
};

type LockRow = {
  path: string;
  owner: string | null;
  note: string | null;
  status: LockStatus;
  created_at: string;
  updated_at: string;
};

type NoteRow = {
  id: string;
  text: string;
  author: string | null;
  created_at: string;
};

export class SqliteStore implements Store {
  private db?: Database.Database;

  constructor(private dbPath: string, private logDir: string) {}

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.dbPath));
    await ensureDir(this.logDir);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL,
        owner TEXT,
        tags TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS locks (
        path TEXT PRIMARY KEY,
        owner TEXT,
        note TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        author TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }

  private parseTask(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status,
      owner: row.owner ?? undefined,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseLock(row: LockRow): Lock {
    return {
      path: row.path,
      owner: row.owner ?? undefined,
      note: row.note ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseNote(row: NoteRow): Note {
    return {
      id: row.id,
      text: row.text,
      author: row.author ?? undefined,
      createdAt: row.created_at,
    };
  }

  async status(): Promise<State> {
    const db = this.getDb();
    const tasks = db.prepare("SELECT * FROM tasks ORDER BY created_at ASC").all() as TaskRow[];
    const locks = db.prepare("SELECT * FROM locks ORDER BY created_at ASC").all() as LockRow[];
    const notes = db.prepare("SELECT * FROM notes ORDER BY created_at ASC").all() as NoteRow[];
    return {
      tasks: tasks.map((row) => this.parseTask(row)),
      locks: locks.map((row) => this.parseLock(row)),
      notes: notes.map((row) => this.parseNote(row)),
    };
  }

  async createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task> {
    const db = this.getDb();
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

    db.prepare(
      `INSERT INTO tasks (id, title, description, status, owner, tags, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.title,
      task.description ?? null,
      task.status,
      task.owner ?? null,
      task.tags ? JSON.stringify(task.tags) : null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.createdAt,
      task.updatedAt
    );

    await appendLog(this.logDir, "task_create", { task });
    return task;
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
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${input.id}`);
    const task = this.parseTask(row);

    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.status !== undefined) task.status = input.status;
    if (input.owner !== undefined) task.owner = input.owner;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.metadata !== undefined) task.metadata = input.metadata;
    task.updatedAt = nowIso();

    db.prepare(
      `UPDATE tasks
       SET title = ?, description = ?, status = ?, owner = ?, tags = ?, metadata = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      task.title,
      task.description ?? null,
      task.status,
      task.owner ?? null,
      task.tags ? JSON.stringify(task.tags) : null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.updatedAt,
      task.id
    );

    await appendLog(this.logDir, "task_update", { task });
    return task;
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
    const db = this.getDb();
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters?.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.owner) {
      where.push("owner = ?");
      params.push(filters.owner);
    }
    const sql = `SELECT * FROM tasks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`;
    let tasks = (db.prepare(sql).all(...params) as TaskRow[]).map((row) => this.parseTask(row));
    if (filters?.tag) {
      tasks = tasks.filter((task) => task.tags?.includes(filters.tag ?? ""));
    }
    if (filters?.limit && filters.limit > 0) tasks = tasks.slice(0, filters.limit);
    return tasks;
  }

  async acquireLock(input: { path: string; owner?: string; note?: string }): Promise<Lock> {
    const db = this.getDb();
    const lock: Lock = {
      path: input.path,
      owner: input.owner,
      note: input.note,
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const transaction = db.transaction(() => {
      const existing = db
        .prepare("SELECT * FROM locks WHERE path = ? AND status = 'active'")
        .get(input.path) as LockRow | undefined;
      if (existing) throw new Error(`Lock already active for ${input.path}`);
      db.prepare(
        `INSERT INTO locks (path, owner, note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        lock.path,
        lock.owner ?? null,
        lock.note ?? null,
        lock.status,
        lock.createdAt,
        lock.updatedAt
      );
    });

    transaction();
    await appendLog(this.logDir, "lock_acquire", { lock });
    return lock;
  }

  async releaseLock(input: { path: string; owner?: string }): Promise<Lock> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM locks WHERE path = ? AND status = 'active'")
      .get(input.path) as LockRow | undefined;
    if (!row) throw new Error(`Active lock not found for ${input.path}`);
    const lock = this.parseLock(row);
    if (input.owner && lock.owner && input.owner !== lock.owner) {
      throw new Error(`Lock owned by ${lock.owner}, not ${input.owner}`);
    }
    lock.status = "resolved";
    lock.updatedAt = nowIso();
    db.prepare("UPDATE locks SET status = ?, updated_at = ? WHERE path = ?").run(
      lock.status,
      lock.updatedAt,
      lock.path
    );
    await appendLog(this.logDir, "lock_release", { lock });
    return lock;
  }

  async listLocks(filters?: { status?: LockStatus; owner?: string }): Promise<Lock[]> {
    const db = this.getDb();
    const where: string[] = [];
    const params: string[] = [];
    if (filters?.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.owner) {
      where.push("owner = ?");
      params.push(filters.owner);
    }
    const sql = `SELECT * FROM locks${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC`;
    const locks = db.prepare(sql).all(...params) as LockRow[];
    return locks.map((row) => this.parseLock(row));
  }

  async appendNote(input: { text: string; author?: string }): Promise<Note> {
    const db = this.getDb();
    const note: Note = {
      id: crypto.randomUUID(),
      text: input.text,
      author: input.author,
      createdAt: nowIso(),
    };
    db.prepare(
      `INSERT INTO notes (id, text, author, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(note.id, note.text, note.author ?? null, note.createdAt);
    await appendLog(this.logDir, "note_append", { note });
    return note;
  }

  async listNotes(limit?: number): Promise<Note[]> {
    const db = this.getDb();
    const sql = "SELECT * FROM notes ORDER BY created_at ASC";
    let notes = (db.prepare(sql).all() as NoteRow[]).map((row) => this.parseNote(row));
    if (limit && limit > 0) notes = notes.slice(Math.max(notes.length - limit, 0));
    return notes;
  }

  async appendLogEntry(event: string, payload?: Record<string, unknown>): Promise<void> {
    await appendLog(this.logDir, event, payload ?? {});
  }
}

export function createStore(config: Config): Store {
  if (config.storage === "json") {
    return new JsonStore(config.dataDir, config.logDir);
  }
  return new SqliteStore(config.dbPath, config.logDir);
}

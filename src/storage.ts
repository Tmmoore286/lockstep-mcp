import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { ensureDir, sleep } from "./utils.js";
import type { Config } from "./config.js";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "review" | "done";
export type TaskComplexity = "simple" | "medium" | "complex" | "critical";
export type TaskIsolation = "shared" | "worktree";
export type LockStatus = "active" | "resolved";

export type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  complexity: TaskComplexity;
  isolation: TaskIsolation;
  owner?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  // Review workflow fields
  reviewNotes?: string;        // Notes from implementer when submitting for review
  reviewFeedback?: string;     // Feedback from planner after review
  reviewRequestedAt?: string;  // When review was requested
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

export type ProjectStatus = "planning" | "ready" | "in_progress" | "complete" | "stopped";

export type ProjectContext = {
  projectRoot: string;
  description: string;
  endState: string;
  techStack?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  tests?: string[];
  implementationPlan?: string[];
  preferredImplementer?: "claude" | "codex";
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
};

export type ImplementerIsolation = "shared" | "worktree";

export type Implementer = {
  id: string;
  name: string;
  type: "claude" | "codex";
  projectRoot: string;
  status: "active" | "stopped";
  pid?: number;
  isolation: ImplementerIsolation;
  worktreePath?: string;    // Path to worktree directory (if isolation="worktree")
  branchName?: string;      // Git branch name for this implementer
  createdAt: string;
  updatedAt: string;
};

// Discussion Thread System
export type DiscussionStatus = "open" | "waiting" | "resolved" | "archived";
export type DiscussionCategory = "architecture" | "implementation" | "blocker" | "question" | "other";
export type DiscussionPriority = "low" | "medium" | "high" | "blocking";

export type Discussion = {
  id: string;
  topic: string;
  category: DiscussionCategory;
  priority: DiscussionPriority;
  status: DiscussionStatus;
  projectRoot: string;
  createdBy: string;
  waitingOn?: string;  // Which agent is expected to respond
  decision?: string;
  decisionReasoning?: string;
  decidedBy?: string;
  linkedTaskId?: string;  // Task spawned from this decision
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  archivedAt?: string;
};

export type DiscussionMessage = {
  id: string;
  discussionId: string;
  author: string;
  message: string;
  recommendation?: string;  // Optional vote/recommendation
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
    complexity?: TaskComplexity;
    isolation?: TaskIsolation;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Task>;
  updateTask(input: {
    id: string;
    title?: string;
    description?: string;
    status?: TaskStatus;
    complexity?: TaskComplexity;
    isolation?: TaskIsolation;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    reviewNotes?: string;
    reviewFeedback?: string;
    reviewRequestedAt?: string;
  }): Promise<Task>;
  submitTaskForReview(input: {
    id: string;
    owner: string;
    reviewNotes: string;
  }): Promise<Task>;
  approveTask(input: {
    id: string;
    feedback?: string;
  }): Promise<Task>;
  requestTaskChanges(input: {
    id: string;
    feedback: string;
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
  setProjectContext(input: {
    projectRoot: string;
    description: string;
    endState: string;
    techStack?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    tests?: string[];
    implementationPlan?: string[];
    preferredImplementer?: "claude" | "codex";
    status?: ProjectStatus;
  }): Promise<ProjectContext>;
  getProjectContext(projectRoot: string): Promise<ProjectContext | null>;
  listAllProjectContexts(): Promise<ProjectContext[]>;
  updateProjectStatus(projectRoot: string, status: ProjectStatus): Promise<ProjectContext>;
  registerImplementer(input: {
    name: string;
    type: "claude" | "codex";
    projectRoot: string;
    pid?: number;
    isolation?: ImplementerIsolation;
    worktreePath?: string;
    branchName?: string;
  }): Promise<Implementer>;
  updateImplementer(id: string, status: "active" | "stopped"): Promise<Implementer>;
  listImplementers(projectRoot?: string): Promise<Implementer[]>;
  resetImplementers(projectRoot: string): Promise<number>;

  // Discussion methods
  createDiscussion(input: {
    topic: string;
    category: DiscussionCategory;
    priority: DiscussionPriority;
    message: string;
    createdBy: string;
    projectRoot: string;
    waitingOn?: string;
  }): Promise<{ discussion: Discussion; message: DiscussionMessage }>;

  replyToDiscussion(input: {
    discussionId: string;
    author: string;
    message: string;
    recommendation?: string;
    waitingOn?: string;
  }): Promise<{ discussion: Discussion; message: DiscussionMessage }>;

  resolveDiscussion(input: {
    discussionId: string;
    decision: string;
    reasoning: string;
    decidedBy: string;
    linkedTaskId?: string;
  }): Promise<Discussion>;

  getDiscussion(id: string): Promise<{ discussion: Discussion; messages: DiscussionMessage[] } | null>;

  listDiscussions(filters?: {
    status?: DiscussionStatus;
    category?: DiscussionCategory;
    projectRoot?: string;
    waitingOn?: string;
    limit?: number;
  }): Promise<Discussion[]>;

  archiveDiscussion(id: string): Promise<Discussion>;

  archiveOldDiscussions(options: {
    olderThanDays?: number;  // Archive resolved discussions older than X days
    projectRoot?: string;
  }): Promise<number>;  // Returns count of archived

  deleteArchivedDiscussions(options: {
    olderThanDays?: number;  // Delete archived discussions older than X days
    projectRoot?: string;
  }): Promise<number>;  // Returns count of deleted
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

type ProjectContextStore = Record<string, ProjectContext>;

export class JsonStore implements Store {
  private statePath: string;
  private lockPath: string;
  private contextPath: string;

  constructor(private dataDir: string, private logDir: string) {
    this.statePath = path.join(this.dataDir, "state.json");
    this.lockPath = path.join(this.dataDir, "state.lock");
    this.contextPath = path.join(this.dataDir, "project_contexts.json");
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
    complexity?: TaskComplexity;
    isolation?: TaskIsolation;
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
        complexity: input.complexity ?? "medium",
        isolation: input.isolation ?? "shared",
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

  // Review workflow methods - not fully implemented for JSON storage
  async submitTaskForReview(): Promise<Task> {
    throw new Error("Review workflow requires SQLite storage. Set storage: 'sqlite' in config.");
  }
  async approveTask(): Promise<Task> {
    throw new Error("Review workflow requires SQLite storage.");
  }
  async requestTaskChanges(): Promise<Task> {
    throw new Error("Review workflow requires SQLite storage.");
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

  private async loadContexts(): Promise<ProjectContextStore> {
    try {
      const raw = await fs.readFile(this.contextPath, "utf8");
      return JSON.parse(raw) as ProjectContextStore;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return {};
      throw error;
    }
  }

  private async saveContexts(contexts: ProjectContextStore): Promise<void> {
    await fs.writeFile(this.contextPath, JSON.stringify(contexts, null, 2), "utf8");
  }

  async setProjectContext(input: {
    projectRoot: string;
    description: string;
    endState: string;
    techStack?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    tests?: string[];
    implementationPlan?: string[];
    preferredImplementer?: "claude" | "codex";
    status?: ProjectStatus;
  }): Promise<ProjectContext> {
    return this.withStateLock(async () => {
      const contexts = await this.loadContexts();
      const existing = contexts[input.projectRoot];
      const context: ProjectContext = {
        projectRoot: input.projectRoot,
        description: input.description,
        endState: input.endState,
        techStack: input.techStack,
        constraints: input.constraints,
        acceptanceCriteria: input.acceptanceCriteria,
        tests: input.tests,
        implementationPlan: input.implementationPlan,
        preferredImplementer: input.preferredImplementer ?? existing?.preferredImplementer,
        status: input.status ?? existing?.status ?? "planning",
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      contexts[input.projectRoot] = context;
      await this.saveContexts(contexts);
      await appendLog(this.logDir, "project_context_set", { context });
      return context;
    });
  }

  async getProjectContext(projectRoot: string): Promise<ProjectContext | null> {
    const contexts = await this.loadContexts();
    return contexts[projectRoot] ?? null;
  }

  async listAllProjectContexts(): Promise<ProjectContext[]> {
    const contexts = await this.loadContexts();
    return Object.values(contexts);
  }

  async updateProjectStatus(projectRoot: string, status: ProjectStatus): Promise<ProjectContext> {
    return this.withStateLock(async () => {
      const contexts = await this.loadContexts();
      const existing = contexts[projectRoot];
      if (!existing) throw new Error(`Project context not found: ${projectRoot}`);
      existing.status = status;
      existing.updatedAt = nowIso();
      await this.saveContexts(contexts);
      await appendLog(this.logDir, "project_status_update", { projectRoot, status });
      return existing;
    });
  }

  private get implementersPath(): string {
    return path.join(this.dataDir, "implementers.json");
  }

  private async loadImplementers(): Promise<Record<string, Implementer>> {
    try {
      const raw = await fs.readFile(this.implementersPath, "utf8");
      return JSON.parse(raw) as Record<string, Implementer>;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return {};
      throw error;
    }
  }

  private async saveImplementers(implementers: Record<string, Implementer>): Promise<void> {
    await fs.writeFile(this.implementersPath, JSON.stringify(implementers, null, 2), "utf8");
  }

  async registerImplementer(input: {
    name: string;
    type: "claude" | "codex";
    projectRoot: string;
    pid?: number;
    isolation?: ImplementerIsolation;
    worktreePath?: string;
    branchName?: string;
  }): Promise<Implementer> {
    return this.withStateLock(async () => {
      const implementers = await this.loadImplementers();
      const implementer: Implementer = {
        id: crypto.randomUUID(),
        name: input.name,
        type: input.type,
        projectRoot: input.projectRoot,
        status: "active",
        pid: input.pid,
        isolation: input.isolation ?? "shared",
        worktreePath: input.worktreePath,
        branchName: input.branchName,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      implementers[implementer.id] = implementer;
      await this.saveImplementers(implementers);
      await appendLog(this.logDir, "implementer_register", { implementer });
      return implementer;
    });
  }

  async updateImplementer(id: string, status: "active" | "stopped"): Promise<Implementer> {
    return this.withStateLock(async () => {
      const implementers = await this.loadImplementers();
      const implementer = implementers[id];
      if (!implementer) throw new Error(`Implementer not found: ${id}`);
      implementer.status = status;
      implementer.updatedAt = nowIso();
      await this.saveImplementers(implementers);
      await appendLog(this.logDir, "implementer_update", { implementer });
      return implementer;
    });
  }

  async listImplementers(projectRoot?: string): Promise<Implementer[]> {
    const implementers = await this.loadImplementers();
    let list = Object.values(implementers);
    if (projectRoot) {
      list = list.filter((impl) => impl.projectRoot === projectRoot);
    }
    return list;
  }

  async resetImplementers(projectRoot: string): Promise<number> {
    return this.withStateLock(async () => {
      const implementers = await this.loadImplementers();
      let count = 0;
      for (const id of Object.keys(implementers)) {
        const impl = implementers[id];
        if (impl.projectRoot === projectRoot && impl.status === "active") {
          impl.status = "stopped";
          impl.updatedAt = nowIso();
          count++;
        }
      }
      await this.saveImplementers(implementers);
      await appendLog(this.logDir, "implementers_reset", { projectRoot, count });
      return count;
    });
  }

  // Discussion methods - not implemented for JSON storage (use SQLite)
  async createDiscussion(): Promise<{ discussion: Discussion; message: DiscussionMessage }> {
    throw new Error("Discussion features require SQLite storage. Set storage: 'sqlite' in config.");
  }
  async replyToDiscussion(): Promise<{ discussion: Discussion; message: DiscussionMessage }> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async resolveDiscussion(): Promise<Discussion> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async getDiscussion(): Promise<{ discussion: Discussion; messages: DiscussionMessage[] } | null> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async listDiscussions(): Promise<Discussion[]> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async archiveDiscussion(): Promise<Discussion> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async archiveOldDiscussions(): Promise<number> {
    throw new Error("Discussion features require SQLite storage.");
  }
  async deleteArchivedDiscussions(): Promise<number> {
    throw new Error("Discussion features require SQLite storage.");
  }
}

type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  complexity: TaskComplexity;
  isolation: TaskIsolation;
  owner: string | null;
  tags: string | null;
  metadata: string | null;
  review_notes: string | null;
  review_feedback: string | null;
  review_requested_at: string | null;
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

type ProjectContextRow = {
  project_root: string;
  description: string;
  end_state: string;
  tech_stack: string | null;
  constraints: string | null;
  acceptance_criteria: string | null;
  tests: string | null;
  implementation_plan: string | null;
  preferred_implementer: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type ImplementerRow = {
  id: string;
  name: string;
  type: string;
  project_root: string;
  status: string;
  pid: number | null;
  isolation: string;
  worktree_path: string | null;
  branch_name: string | null;
  created_at: string;
  updated_at: string;
};

type DiscussionRow = {
  id: string;
  topic: string;
  category: string;
  priority: string;
  status: string;
  project_root: string;
  created_by: string;
  waiting_on: string | null;
  decision: string | null;
  decision_reasoning: string | null;
  decided_by: string | null;
  linked_task_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  archived_at: string | null;
};

type DiscussionMessageRow = {
  id: string;
  discussion_id: string;
  author: string;
  message: string;
  recommendation: string | null;
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
        complexity TEXT NOT NULL DEFAULT 'medium',
        isolation TEXT NOT NULL DEFAULT 'shared',
        owner TEXT,
        tags TEXT,
        metadata TEXT,
        review_notes TEXT,
        review_feedback TEXT,
        review_requested_at TEXT,
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

      CREATE TABLE IF NOT EXISTS project_contexts (
        project_root TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        end_state TEXT NOT NULL,
        tech_stack TEXT,
        constraints TEXT,
        acceptance_criteria TEXT,
        tests TEXT,
        implementation_plan TEXT,
        status TEXT NOT NULL DEFAULT 'planning',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS implementers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        project_root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pid INTEGER,
        isolation TEXT NOT NULL DEFAULT 'shared',
        worktree_path TEXT,
        branch_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS discussions (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'open',
        project_root TEXT NOT NULL,
        created_by TEXT NOT NULL,
        waiting_on TEXT,
        decision TEXT,
        decision_reasoning TEXT,
        decided_by TEXT,
        linked_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        archived_at TEXT
      );

      CREATE TABLE IF NOT EXISTS discussion_messages (
        id TEXT PRIMARY KEY,
        discussion_id TEXT NOT NULL,
        author TEXT NOT NULL,
        message TEXT NOT NULL,
        recommendation TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (discussion_id) REFERENCES discussions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_discussions_status ON discussions(status);
      CREATE INDEX IF NOT EXISTS idx_discussions_project ON discussions(project_root);
      CREATE INDEX IF NOT EXISTS idx_discussion_messages_discussion ON discussion_messages(discussion_id);
    `);

    // Migration: add new columns if they don't exist
    try {
      this.db.exec("ALTER TABLE project_contexts ADD COLUMN acceptance_criteria TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE project_contexts ADD COLUMN tests TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE project_contexts ADD COLUMN implementation_plan TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE project_contexts ADD COLUMN preferred_implementer TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE project_contexts ADD COLUMN status TEXT NOT NULL DEFAULT 'planning'");
    } catch { /* column exists */ }
    // Task review workflow columns
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN complexity TEXT NOT NULL DEFAULT 'medium'");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN review_notes TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN review_feedback TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN review_requested_at TEXT");
    } catch { /* column exists */ }
    // Worktree isolation columns
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE implementers ADD COLUMN isolation TEXT NOT NULL DEFAULT 'shared'");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE implementers ADD COLUMN worktree_path TEXT");
    } catch { /* column exists */ }
    try {
      this.db.exec("ALTER TABLE implementers ADD COLUMN branch_name TEXT");
    } catch { /* column exists */ }
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
      complexity: row.complexity ?? "medium",
      isolation: row.isolation ?? "shared",
      owner: row.owner ?? undefined,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
      metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
      reviewNotes: row.review_notes ?? undefined,
      reviewFeedback: row.review_feedback ?? undefined,
      reviewRequestedAt: row.review_requested_at ?? undefined,
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
    complexity?: TaskComplexity;
    isolation?: TaskIsolation;
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
      complexity: input.complexity ?? "medium",
      isolation: input.isolation ?? "shared",
      owner: input.owner,
      tags: input.tags,
      metadata: input.metadata,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    db.prepare(
      `INSERT INTO tasks (id, title, description, status, complexity, isolation, owner, tags, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.title,
      task.description ?? null,
      task.status,
      task.complexity,
      task.isolation,
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
    complexity?: TaskComplexity;
    isolation?: TaskIsolation;
    owner?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    reviewNotes?: string;
    reviewFeedback?: string;
    reviewRequestedAt?: string;
  }): Promise<Task> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${input.id}`);
    const task = this.parseTask(row);

    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.status !== undefined) task.status = input.status;
    if (input.complexity !== undefined) task.complexity = input.complexity;
    if (input.isolation !== undefined) task.isolation = input.isolation;
    if (input.owner !== undefined) task.owner = input.owner;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.metadata !== undefined) task.metadata = input.metadata;
    if (input.reviewNotes !== undefined) task.reviewNotes = input.reviewNotes;
    if (input.reviewFeedback !== undefined) task.reviewFeedback = input.reviewFeedback;
    if (input.reviewRequestedAt !== undefined) task.reviewRequestedAt = input.reviewRequestedAt;
    task.updatedAt = nowIso();

    db.prepare(
      `UPDATE tasks
       SET title = ?, description = ?, status = ?, complexity = ?, isolation = ?, owner = ?, tags = ?, metadata = ?,
           review_notes = ?, review_feedback = ?, review_requested_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      task.title,
      task.description ?? null,
      task.status,
      task.complexity,
      task.isolation,
      task.owner ?? null,
      task.tags ? JSON.stringify(task.tags) : null,
      task.metadata ? JSON.stringify(task.metadata) : null,
      task.reviewNotes ?? null,
      task.reviewFeedback ?? null,
      task.reviewRequestedAt ?? null,
      task.updatedAt,
      task.id
    );

    await appendLog(this.logDir, "task_update", { task });
    return task;
  }

  async claimTask(input: { id: string; owner: string }): Promise<Task> {
    return this.updateTask({ id: input.id, owner: input.owner, status: "in_progress" });
  }

  async submitTaskForReview(input: {
    id: string;
    owner: string;
    reviewNotes: string;
  }): Promise<Task> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${input.id}`);
    if (row.owner !== input.owner) {
      throw new Error(`Task owned by ${row.owner}, not ${input.owner}`);
    }
    return this.updateTask({
      id: input.id,
      status: "review",
      reviewNotes: input.reviewNotes,
      reviewRequestedAt: nowIso(),
    });
  }

  async approveTask(input: {
    id: string;
    feedback?: string;
  }): Promise<Task> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${input.id}`);
    if (row.status !== "review") {
      throw new Error(`Task is not in review status (current: ${row.status})`);
    }
    return this.updateTask({
      id: input.id,
      status: "done",
      reviewFeedback: input.feedback ?? "Approved",
    });
  }

  async requestTaskChanges(input: {
    id: string;
    feedback: string;
  }): Promise<Task> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(input.id) as TaskRow | undefined;
    if (!row) throw new Error(`Task not found: ${input.id}`);
    if (row.status !== "review") {
      throw new Error(`Task is not in review status (current: ${row.status})`);
    }
    return this.updateTask({
      id: input.id,
      status: "in_progress",  // Send back to in_progress for rework
      reviewFeedback: input.feedback,
    });
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

  private parseProjectContext(row: ProjectContextRow): ProjectContext {
    return {
      projectRoot: row.project_root,
      description: row.description,
      endState: row.end_state,
      techStack: row.tech_stack ? (JSON.parse(row.tech_stack) as string[]) : undefined,
      constraints: row.constraints ? (JSON.parse(row.constraints) as string[]) : undefined,
      acceptanceCriteria: row.acceptance_criteria ? (JSON.parse(row.acceptance_criteria) as string[]) : undefined,
      tests: row.tests ? (JSON.parse(row.tests) as string[]) : undefined,
      implementationPlan: row.implementation_plan ? (JSON.parse(row.implementation_plan) as string[]) : undefined,
      preferredImplementer: row.preferred_implementer as "claude" | "codex" | undefined,
      status: (row.status as ProjectStatus) ?? "planning",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseImplementer(row: ImplementerRow): Implementer {
    return {
      id: row.id,
      name: row.name,
      type: row.type as "claude" | "codex",
      projectRoot: row.project_root,
      status: row.status as "active" | "stopped",
      pid: row.pid ?? undefined,
      isolation: (row.isolation as ImplementerIsolation) ?? "shared",
      worktreePath: row.worktree_path ?? undefined,
      branchName: row.branch_name ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async setProjectContext(input: {
    projectRoot: string;
    description: string;
    endState: string;
    techStack?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    tests?: string[];
    implementationPlan?: string[];
    preferredImplementer?: "claude" | "codex";
    status?: ProjectStatus;
  }): Promise<ProjectContext> {
    const db = this.getDb();
    const existing = db
      .prepare("SELECT * FROM project_contexts WHERE project_root = ?")
      .get(input.projectRoot) as ProjectContextRow | undefined;

    const context: ProjectContext = {
      projectRoot: input.projectRoot,
      description: input.description,
      endState: input.endState,
      techStack: input.techStack,
      constraints: input.constraints,
      acceptanceCriteria: input.acceptanceCriteria,
      tests: input.tests,
      implementationPlan: input.implementationPlan,
      preferredImplementer: input.preferredImplementer ?? existing?.preferred_implementer as "claude" | "codex" | undefined,
      status: input.status ?? existing?.status as ProjectStatus ?? "planning",
      createdAt: existing?.created_at ?? nowIso(),
      updatedAt: nowIso(),
    };

    if (existing) {
      db.prepare(
        `UPDATE project_contexts
         SET description = ?, end_state = ?, tech_stack = ?, constraints = ?,
             acceptance_criteria = ?, tests = ?, implementation_plan = ?, preferred_implementer = ?, status = ?, updated_at = ?
         WHERE project_root = ?`
      ).run(
        context.description,
        context.endState,
        context.techStack ? JSON.stringify(context.techStack) : null,
        context.constraints ? JSON.stringify(context.constraints) : null,
        context.acceptanceCriteria ? JSON.stringify(context.acceptanceCriteria) : null,
        context.tests ? JSON.stringify(context.tests) : null,
        context.implementationPlan ? JSON.stringify(context.implementationPlan) : null,
        context.preferredImplementer ?? null,
        context.status,
        context.updatedAt,
        context.projectRoot
      );
    } else {
      db.prepare(
        `INSERT INTO project_contexts (project_root, description, end_state, tech_stack, constraints,
         acceptance_criteria, tests, implementation_plan, preferred_implementer, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        context.projectRoot,
        context.description,
        context.endState,
        context.techStack ? JSON.stringify(context.techStack) : null,
        context.constraints ? JSON.stringify(context.constraints) : null,
        context.acceptanceCriteria ? JSON.stringify(context.acceptanceCriteria) : null,
        context.tests ? JSON.stringify(context.tests) : null,
        context.implementationPlan ? JSON.stringify(context.implementationPlan) : null,
        context.preferredImplementer ?? null,
        context.status,
        context.createdAt,
        context.updatedAt
      );
    }

    await appendLog(this.logDir, "project_context_set", { context });
    return context;
  }

  async getProjectContext(projectRoot: string): Promise<ProjectContext | null> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM project_contexts WHERE project_root = ?")
      .get(projectRoot) as ProjectContextRow | undefined;
    return row ? this.parseProjectContext(row) : null;
  }

  async listAllProjectContexts(): Promise<ProjectContext[]> {
    const db = this.getDb();
    const rows = db
      .prepare("SELECT * FROM project_contexts ORDER BY updated_at DESC")
      .all() as ProjectContextRow[];
    return rows.map((row) => this.parseProjectContext(row));
  }

  async updateProjectStatus(projectRoot: string, status: ProjectStatus): Promise<ProjectContext> {
    const db = this.getDb();
    const row = db
      .prepare("SELECT * FROM project_contexts WHERE project_root = ?")
      .get(projectRoot) as ProjectContextRow | undefined;
    if (!row) throw new Error(`Project context not found: ${projectRoot}`);

    const updatedAt = nowIso();
    db.prepare("UPDATE project_contexts SET status = ?, updated_at = ? WHERE project_root = ?")
      .run(status, updatedAt, projectRoot);

    await appendLog(this.logDir, "project_status_update", { projectRoot, status });

    const updated = db
      .prepare("SELECT * FROM project_contexts WHERE project_root = ?")
      .get(projectRoot) as ProjectContextRow;
    return this.parseProjectContext(updated);
  }

  async registerImplementer(input: {
    name: string;
    type: "claude" | "codex";
    projectRoot: string;
    pid?: number;
    isolation?: ImplementerIsolation;
    worktreePath?: string;
    branchName?: string;
  }): Promise<Implementer> {
    const db = this.getDb();
    const implementer: Implementer = {
      id: crypto.randomUUID(),
      name: input.name,
      type: input.type,
      projectRoot: input.projectRoot,
      status: "active",
      pid: input.pid,
      isolation: input.isolation ?? "shared",
      worktreePath: input.worktreePath,
      branchName: input.branchName,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    db.prepare(
      `INSERT INTO implementers (id, name, type, project_root, status, pid, isolation, worktree_path, branch_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      implementer.id,
      implementer.name,
      implementer.type,
      implementer.projectRoot,
      implementer.status,
      implementer.pid ?? null,
      implementer.isolation,
      implementer.worktreePath ?? null,
      implementer.branchName ?? null,
      implementer.createdAt,
      implementer.updatedAt
    );

    await appendLog(this.logDir, "implementer_register", { implementer });
    return implementer;
  }

  async updateImplementer(id: string, status: "active" | "stopped"): Promise<Implementer> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM implementers WHERE id = ?").get(id) as ImplementerRow | undefined;
    if (!row) throw new Error(`Implementer not found: ${id}`);

    const updatedAt = nowIso();
    db.prepare("UPDATE implementers SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);

    await appendLog(this.logDir, "implementer_update", { id, status });

    const updated = db.prepare("SELECT * FROM implementers WHERE id = ?").get(id) as ImplementerRow;
    return this.parseImplementer(updated);
  }

  async listImplementers(projectRoot?: string): Promise<Implementer[]> {
    const db = this.getDb();
    let rows: ImplementerRow[];
    if (projectRoot) {
      rows = db.prepare("SELECT * FROM implementers WHERE project_root = ? ORDER BY created_at ASC")
        .all(projectRoot) as ImplementerRow[];
    } else {
      rows = db.prepare("SELECT * FROM implementers ORDER BY created_at ASC").all() as ImplementerRow[];
    }
    return rows.map((row) => this.parseImplementer(row));
  }

  async resetImplementers(projectRoot: string): Promise<number> {
    const db = this.getDb();
    const updatedAt = nowIso();
    const result = db.prepare(
      "UPDATE implementers SET status = 'stopped', updated_at = ? WHERE project_root = ? AND status = 'active'"
    ).run(updatedAt, projectRoot);
    await appendLog(this.logDir, "implementers_reset", { projectRoot, count: result.changes });
    return result.changes;
  }

  // Discussion methods
  private parseDiscussion(row: DiscussionRow): Discussion {
    return {
      id: row.id,
      topic: row.topic,
      category: row.category as DiscussionCategory,
      priority: row.priority as DiscussionPriority,
      status: row.status as DiscussionStatus,
      projectRoot: row.project_root,
      createdBy: row.created_by,
      waitingOn: row.waiting_on ?? undefined,
      decision: row.decision ?? undefined,
      decisionReasoning: row.decision_reasoning ?? undefined,
      decidedBy: row.decided_by ?? undefined,
      linkedTaskId: row.linked_task_id ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? undefined,
      archivedAt: row.archived_at ?? undefined,
    };
  }

  private parseDiscussionMessage(row: DiscussionMessageRow): DiscussionMessage {
    return {
      id: row.id,
      discussionId: row.discussion_id,
      author: row.author,
      message: row.message,
      recommendation: row.recommendation ?? undefined,
      createdAt: row.created_at,
    };
  }

  async createDiscussion(input: {
    topic: string;
    category: DiscussionCategory;
    priority: DiscussionPriority;
    message: string;
    createdBy: string;
    projectRoot: string;
    waitingOn?: string;
  }): Promise<{ discussion: Discussion; message: DiscussionMessage }> {
    const db = this.getDb();
    const now = nowIso();

    const discussion: Discussion = {
      id: crypto.randomUUID(),
      topic: input.topic,
      category: input.category,
      priority: input.priority,
      status: input.waitingOn ? "waiting" : "open",
      projectRoot: input.projectRoot,
      createdBy: input.createdBy,
      waitingOn: input.waitingOn,
      createdAt: now,
      updatedAt: now,
    };

    const msg: DiscussionMessage = {
      id: crypto.randomUUID(),
      discussionId: discussion.id,
      author: input.createdBy,
      message: input.message,
      createdAt: now,
    };

    db.prepare(
      `INSERT INTO discussions (id, topic, category, priority, status, project_root, created_by, waiting_on, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      discussion.id,
      discussion.topic,
      discussion.category,
      discussion.priority,
      discussion.status,
      discussion.projectRoot,
      discussion.createdBy,
      discussion.waitingOn ?? null,
      discussion.createdAt,
      discussion.updatedAt
    );

    db.prepare(
      `INSERT INTO discussion_messages (id, discussion_id, author, message, recommendation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.discussionId, msg.author, msg.message, null, msg.createdAt);

    await appendLog(this.logDir, "discussion_create", { discussion, message: msg });
    return { discussion, message: msg };
  }

  async replyToDiscussion(input: {
    discussionId: string;
    author: string;
    message: string;
    recommendation?: string;
    waitingOn?: string;
  }): Promise<{ discussion: Discussion; message: DiscussionMessage }> {
    const db = this.getDb();
    const now = nowIso();

    const row = db.prepare("SELECT * FROM discussions WHERE id = ?").get(input.discussionId) as DiscussionRow | undefined;
    if (!row) throw new Error(`Discussion not found: ${input.discussionId}`);
    if (row.status === "resolved" || row.status === "archived") {
      throw new Error(`Cannot reply to ${row.status} discussion`);
    }

    const msg: DiscussionMessage = {
      id: crypto.randomUUID(),
      discussionId: input.discussionId,
      author: input.author,
      message: input.message,
      recommendation: input.recommendation,
      createdAt: now,
    };

    db.prepare(
      `INSERT INTO discussion_messages (id, discussion_id, author, message, recommendation, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.discussionId, msg.author, msg.message, msg.recommendation ?? null, msg.createdAt);

    // Update discussion status and waiting_on
    const newStatus = input.waitingOn ? "waiting" : "open";
    db.prepare(
      `UPDATE discussions SET status = ?, waiting_on = ?, updated_at = ? WHERE id = ?`
    ).run(newStatus, input.waitingOn ?? null, now, input.discussionId);

    const updated = db.prepare("SELECT * FROM discussions WHERE id = ?").get(input.discussionId) as DiscussionRow;
    await appendLog(this.logDir, "discussion_reply", { discussion: this.parseDiscussion(updated), message: msg });
    return { discussion: this.parseDiscussion(updated), message: msg };
  }

  async resolveDiscussion(input: {
    discussionId: string;
    decision: string;
    reasoning: string;
    decidedBy: string;
    linkedTaskId?: string;
  }): Promise<Discussion> {
    const db = this.getDb();
    const now = nowIso();

    const row = db.prepare("SELECT * FROM discussions WHERE id = ?").get(input.discussionId) as DiscussionRow | undefined;
    if (!row) throw new Error(`Discussion not found: ${input.discussionId}`);

    db.prepare(
      `UPDATE discussions
       SET status = 'resolved', decision = ?, decision_reasoning = ?, decided_by = ?,
           linked_task_id = ?, waiting_on = NULL, resolved_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.decision,
      input.reasoning,
      input.decidedBy,
      input.linkedTaskId ?? null,
      now,
      now,
      input.discussionId
    );

    const updated = db.prepare("SELECT * FROM discussions WHERE id = ?").get(input.discussionId) as DiscussionRow;
    const discussion = this.parseDiscussion(updated);
    await appendLog(this.logDir, "discussion_resolve", { discussion });
    return discussion;
  }

  async getDiscussion(id: string): Promise<{ discussion: Discussion; messages: DiscussionMessage[] } | null> {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM discussions WHERE id = ?").get(id) as DiscussionRow | undefined;
    if (!row) return null;

    const msgRows = db.prepare("SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY created_at ASC")
      .all(id) as DiscussionMessageRow[];

    return {
      discussion: this.parseDiscussion(row),
      messages: msgRows.map((r) => this.parseDiscussionMessage(r)),
    };
  }

  async listDiscussions(filters?: {
    status?: DiscussionStatus;
    category?: DiscussionCategory;
    projectRoot?: string;
    waitingOn?: string;
    limit?: number;
  }): Promise<Discussion[]> {
    const db = this.getDb();
    const where: string[] = [];
    const params: string[] = [];

    if (filters?.status) {
      where.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.category) {
      where.push("category = ?");
      params.push(filters.category);
    }
    if (filters?.projectRoot) {
      where.push("project_root = ?");
      params.push(filters.projectRoot);
    }
    if (filters?.waitingOn) {
      where.push("waiting_on = ?");
      params.push(filters.waitingOn);
    }

    let sql = `SELECT * FROM discussions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY
      CASE priority WHEN 'blocking' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      created_at DESC`;

    if (filters?.limit && filters.limit > 0) {
      sql += ` LIMIT ${filters.limit}`;
    }

    const rows = db.prepare(sql).all(...params) as DiscussionRow[];
    return rows.map((row) => this.parseDiscussion(row));
  }

  async archiveDiscussion(id: string): Promise<Discussion> {
    const db = this.getDb();
    const now = nowIso();

    const row = db.prepare("SELECT * FROM discussions WHERE id = ?").get(id) as DiscussionRow | undefined;
    if (!row) throw new Error(`Discussion not found: ${id}`);

    db.prepare(
      `UPDATE discussions SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?`
    ).run(now, now, id);

    const updated = db.prepare("SELECT * FROM discussions WHERE id = ?").get(id) as DiscussionRow;
    const discussion = this.parseDiscussion(updated);
    await appendLog(this.logDir, "discussion_archive", { discussion });
    return discussion;
  }

  async archiveOldDiscussions(options: {
    olderThanDays?: number;
    projectRoot?: string;
  }): Promise<number> {
    const db = this.getDb();
    const days = options.olderThanDays ?? 7;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const now = nowIso();

    let sql = `UPDATE discussions SET status = 'archived', archived_at = ?, updated_at = ?
               WHERE status = 'resolved' AND resolved_at < ?`;
    const params: string[] = [now, now, cutoff];

    if (options.projectRoot) {
      sql += " AND project_root = ?";
      params.push(options.projectRoot);
    }

    const result = db.prepare(sql).run(...params);
    await appendLog(this.logDir, "discussions_bulk_archive", { count: result.changes, olderThanDays: days });
    return result.changes;
  }

  async deleteArchivedDiscussions(options: {
    olderThanDays?: number;
    projectRoot?: string;
  }): Promise<number> {
    const db = this.getDb();
    const days = options.olderThanDays ?? 30;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // First get IDs to delete
    let selectSql = `SELECT id FROM discussions WHERE status = 'archived' AND archived_at < ?`;
    const selectParams: string[] = [cutoff];
    if (options.projectRoot) {
      selectSql += " AND project_root = ?";
      selectParams.push(options.projectRoot);
    }

    const ids = db.prepare(selectSql).all(...selectParams) as { id: string }[];
    if (ids.length === 0) return 0;

    const idList = ids.map((r) => r.id);

    // Delete messages first (foreign key)
    const placeholders = idList.map(() => "?").join(",");
    db.prepare(`DELETE FROM discussion_messages WHERE discussion_id IN (${placeholders})`).run(...idList);

    // Delete discussions
    const result = db.prepare(`DELETE FROM discussions WHERE id IN (${placeholders})`).run(...idList);

    await appendLog(this.logDir, "discussions_bulk_delete", { count: result.changes, olderThanDays: days });
    return result.changes;
  }
}

export function createStore(config: Config): Store {
  if (config.storage === "json") {
    return new JsonStore(config.dataDir, config.logDir);
  }
  return new SqliteStore(config.dbPath, config.logDir);
}

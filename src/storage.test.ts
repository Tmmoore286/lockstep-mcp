import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from './storage.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('SqliteStore', () => {
  let store: SqliteStore;
  let tempDir: string;
  let dbPath: string;
  let logDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockstep-test-'));
    dbPath = path.join(tempDir, 'test.db');
    logDir = path.join(tempDir, 'logs');
    store = new SqliteStore(dbPath, logDir);
    await store.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('Task CRUD', () => {
    it('should create a task with complexity', async () => {
      const task = await store.createTask({
        title: 'Test Task',
        description: 'Test description',
        complexity: 'medium',
        tags: ['test'],
      });

      expect(task.id).toBeDefined();
      expect(task.title).toBe('Test Task');
      expect(task.complexity).toBe('medium');
      expect(task.status).toBe('todo');
      expect(task.tags).toEqual(['test']);
    });

    it('should default complexity to medium', async () => {
      const task = await store.createTask({
        title: 'No complexity specified',
      });

      expect(task.complexity).toBe('medium');
    });

    it('should update task complexity', async () => {
      const task = await store.createTask({
        title: 'Task to update',
        complexity: 'simple',
      });

      const updated = await store.updateTask({
        id: task.id,
        complexity: 'critical',
      });

      expect(updated.complexity).toBe('critical');
    });

    it('should claim a task', async () => {
      const task = await store.createTask({
        title: 'Task to claim',
        complexity: 'medium',
      });

      const claimed = await store.claimTask({
        id: task.id,
        owner: 'impl-1',
      });

      expect(claimed.status).toBe('in_progress');
      expect(claimed.owner).toBe('impl-1');
    });

    it('should list tasks by status', async () => {
      await store.createTask({ title: 'Todo 1', complexity: 'simple' });
      await store.createTask({ title: 'Todo 2', complexity: 'medium' });
      const task3 = await store.createTask({ title: 'In progress', complexity: 'complex' });
      await store.claimTask({ id: task3.id, owner: 'impl-1' });

      const todoTasks = await store.listTasks({ status: 'todo' });
      const inProgressTasks = await store.listTasks({ status: 'in_progress' });

      expect(todoTasks).toHaveLength(2);
      expect(inProgressTasks).toHaveLength(1);
    });
  });

  describe('Review Workflow', () => {
    it('should submit task for review', async () => {
      const task = await store.createTask({
        title: 'Task to review',
        complexity: 'complex',
      });
      await store.claimTask({ id: task.id, owner: 'impl-1' });

      const reviewed = await store.submitTaskForReview({
        id: task.id,
        owner: 'impl-1',
        reviewNotes: 'Made changes to X, Y, Z files',
      });

      expect(reviewed.status).toBe('review');
      expect(reviewed.reviewNotes).toBe('Made changes to X, Y, Z files');
      expect(reviewed.reviewRequestedAt).toBeDefined();
    });

    it('should reject submit from wrong owner', async () => {
      const task = await store.createTask({
        title: 'Task to review',
        complexity: 'complex',
      });
      await store.claimTask({ id: task.id, owner: 'impl-1' });

      await expect(
        store.submitTaskForReview({
          id: task.id,
          owner: 'impl-2',  // Wrong owner
          reviewNotes: 'Should fail',
        })
      ).rejects.toThrow('owned by impl-1');
    });

    it('should approve task', async () => {
      const task = await store.createTask({
        title: 'Task to approve',
        complexity: 'complex',
      });
      await store.claimTask({ id: task.id, owner: 'impl-1' });
      await store.submitTaskForReview({
        id: task.id,
        owner: 'impl-1',
        reviewNotes: 'Done',
      });

      const approved = await store.approveTask({
        id: task.id,
        feedback: 'Great work!',
      });

      expect(approved.status).toBe('done');
      expect(approved.reviewFeedback).toBe('Great work!');
    });

    it('should reject approval for non-review task', async () => {
      const task = await store.createTask({
        title: 'Not in review',
        complexity: 'simple',
      });

      await expect(
        store.approveTask({ id: task.id })
      ).rejects.toThrow('not in review status');
    });

    it('should request changes on task', async () => {
      const task = await store.createTask({
        title: 'Task needs changes',
        complexity: 'complex',
      });
      await store.claimTask({ id: task.id, owner: 'impl-1' });
      await store.submitTaskForReview({
        id: task.id,
        owner: 'impl-1',
        reviewNotes: 'First attempt',
      });

      const changesRequested = await store.requestTaskChanges({
        id: task.id,
        feedback: 'Please fix the error handling',
      });

      expect(changesRequested.status).toBe('in_progress');
      expect(changesRequested.reviewFeedback).toBe('Please fix the error handling');
    });
  });

  describe('Complexity Levels', () => {
    it('should create tasks with all complexity levels', async () => {
      const simple = await store.createTask({ title: 'Simple', complexity: 'simple' });
      const medium = await store.createTask({ title: 'Medium', complexity: 'medium' });
      const complex = await store.createTask({ title: 'Complex', complexity: 'complex' });
      const critical = await store.createTask({ title: 'Critical', complexity: 'critical' });

      expect(simple.complexity).toBe('simple');
      expect(medium.complexity).toBe('medium');
      expect(complex.complexity).toBe('complex');
      expect(critical.complexity).toBe('critical');
    });
  });

  describe('Locks', () => {
    it('should acquire and release locks', async () => {
      const lock = await store.acquireLock({
        path: '/test/file.ts',
        owner: 'impl-1',
        note: 'Working on feature',
      });

      expect(lock.status).toBe('active');
      expect(lock.owner).toBe('impl-1');

      const released = await store.releaseLock({
        path: '/test/file.ts',
        owner: 'impl-1',
      });

      expect(released.status).toBe('resolved');
    });

    it('should prevent double-locking', async () => {
      await store.acquireLock({
        path: '/test/file.ts',
        owner: 'impl-1',
      });

      await expect(
        store.acquireLock({
          path: '/test/file.ts',
          owner: 'impl-2',
        })
      ).rejects.toThrow('Lock already active');
    });

    it('should prevent wrong owner from releasing', async () => {
      await store.acquireLock({
        path: '/test/file.ts',
        owner: 'impl-1',
      });

      await expect(
        store.releaseLock({
          path: '/test/file.ts',
          owner: 'impl-2',  // Wrong owner
        })
      ).rejects.toThrow('owned by impl-1');
    });
  });

  describe('Notes', () => {
    it('should append and list notes', async () => {
      await store.appendNote({ text: 'First note', author: 'planner' });
      await store.appendNote({ text: 'Second note', author: 'impl-1' });

      const notes = await store.listNotes();

      expect(notes).toHaveLength(2);
      expect(notes[0].text).toBe('First note');
      expect(notes[1].text).toBe('Second note');
    });

    it('should limit notes returned', async () => {
      for (let i = 1; i <= 10; i++) {
        await store.appendNote({ text: `Note ${i}`, author: 'system' });
      }

      const lastFive = await store.listNotes(5);

      expect(lastFive).toHaveLength(5);
      expect(lastFive[0].text).toBe('Note 6');
      expect(lastFive[4].text).toBe('Note 10');
    });
  });

  describe('Project Context', () => {
    it('should set and get project context', async () => {
      const context = await store.setProjectContext({
        projectRoot: '/test/project',
        description: 'Test project',
        endState: 'All tests passing',
        techStack: ['TypeScript', 'Node.js'],
        preferredImplementer: 'codex',
      });

      expect(context.description).toBe('Test project');
      expect(context.status).toBe('planning');

      const retrieved = await store.getProjectContext('/test/project');
      expect(retrieved?.endState).toBe('All tests passing');
    });

    it('should update project status', async () => {
      await store.setProjectContext({
        projectRoot: '/test/project',
        description: 'Test',
        endState: 'Done',
      });

      const updated = await store.updateProjectStatus('/test/project', 'in_progress');
      expect(updated.status).toBe('in_progress');
    });
  });

  describe('Implementers', () => {
    it('should register and list implementers', async () => {
      const impl = await store.registerImplementer({
        name: 'impl-1',
        type: 'codex',
        projectRoot: '/test/project',
        pid: 12345,
      });

      expect(impl.name).toBe('impl-1');
      expect(impl.status).toBe('active');

      const list = await store.listImplementers('/test/project');
      expect(list).toHaveLength(1);
    });

    it('should update implementer status', async () => {
      const impl = await store.registerImplementer({
        name: 'impl-1',
        type: 'claude',
        projectRoot: '/test/project',
      });

      const stopped = await store.updateImplementer(impl.id, 'stopped');
      expect(stopped.status).toBe('stopped');
    });
  });

  describe('Discussions', () => {
    it('should create and reply to discussions', async () => {
      const { discussion, message } = await store.createDiscussion({
        topic: 'Architecture decision',
        category: 'architecture',
        priority: 'high',
        message: 'Should we use pattern A or B?',
        createdBy: 'planner',
        projectRoot: '/test/project',
        waitingOn: 'impl-1',
      });

      expect(discussion.topic).toBe('Architecture decision');
      expect(discussion.status).toBe('waiting');
      expect(message.author).toBe('planner');

      const { discussion: updated } = await store.replyToDiscussion({
        discussionId: discussion.id,
        author: 'impl-1',
        message: 'I recommend pattern A because...',
        recommendation: 'pattern-a',
      });

      expect(updated.status).toBe('open');
    });

    it('should resolve discussions', async () => {
      const { discussion } = await store.createDiscussion({
        topic: 'Quick question',
        category: 'question',
        priority: 'medium',
        message: 'How should we handle X?',
        createdBy: 'impl-1',
        projectRoot: '/test/project',
      });

      const resolved = await store.resolveDiscussion({
        discussionId: discussion.id,
        decision: 'Use approach Y',
        reasoning: 'It\'s simpler and more maintainable',
        decidedBy: 'planner',
      });

      expect(resolved.status).toBe('resolved');
      expect(resolved.decision).toBe('Use approach Y');
    });

    it('should list discussions with filters', async () => {
      await store.createDiscussion({
        topic: 'Open discussion',
        category: 'implementation',
        priority: 'low',
        message: 'Test',
        createdBy: 'planner',
        projectRoot: '/test/project',
      });

      const { discussion } = await store.createDiscussion({
        topic: 'Waiting discussion',
        category: 'blocker',
        priority: 'blocking',
        message: 'Need help',
        createdBy: 'impl-1',
        projectRoot: '/test/project',
        waitingOn: 'planner',
      });

      const waiting = await store.listDiscussions({ waitingOn: 'planner' });
      expect(waiting).toHaveLength(1);
      expect(waiting[0].topic).toBe('Waiting discussion');

      const blocking = await store.listDiscussions({ status: 'waiting' });
      expect(blocking).toHaveLength(1);
    });
  });

  describe('Full Workflow Integration', () => {
    it('should complete a full task workflow with review', async () => {
      // 1. Set up project
      await store.setProjectContext({
        projectRoot: '/test/project',
        description: 'Integration test project',
        endState: 'All features working',
        preferredImplementer: 'codex',
      });

      // 2. Create a complex task
      const task = await store.createTask({
        title: 'Implement feature X',
        description: 'Add the X feature with full error handling',
        complexity: 'complex',
        tags: ['feature', 'priority'],
      });
      expect(task.status).toBe('todo');

      // 3. Register implementer
      const impl = await store.registerImplementer({
        name: 'impl-1',
        type: 'codex',
        projectRoot: '/test/project',
      });

      // 4. Claim task
      const claimed = await store.claimTask({
        id: task.id,
        owner: impl.name,
      });
      expect(claimed.status).toBe('in_progress');

      // 5. Acquire lock
      await store.acquireLock({
        path: '/test/project/src/feature.ts',
        owner: impl.name,
        note: 'Implementing feature X',
      });

      // 6. Work on task (simulated by notes)
      await store.appendNote({
        text: `[${impl.name}] Started working on feature X`,
        author: impl.name,
      });

      // 7. Release lock
      await store.releaseLock({
        path: '/test/project/src/feature.ts',
        owner: impl.name,
      });

      // 8. Submit for review
      const submitted = await store.submitTaskForReview({
        id: task.id,
        owner: impl.name,
        reviewNotes: 'Implemented feature X with error handling. Modified feature.ts and added tests.',
      });
      expect(submitted.status).toBe('review');

      // 9. Planner requests changes
      const needsChanges = await store.requestTaskChanges({
        id: task.id,
        feedback: 'Please add input validation',
      });
      expect(needsChanges.status).toBe('in_progress');

      // 10. Implementer fixes and resubmits
      const resubmitted = await store.submitTaskForReview({
        id: task.id,
        owner: impl.name,
        reviewNotes: 'Added input validation as requested',
      });
      expect(resubmitted.status).toBe('review');

      // 11. Planner approves
      const approved = await store.approveTask({
        id: task.id,
        feedback: 'Looks good! Well done.',
      });
      expect(approved.status).toBe('done');

      // 12. Verify final state
      const allTasks = await store.listTasks();
      expect(allTasks).toHaveLength(1);
      expect(allTasks[0].status).toBe('done');

      const notes = await store.listNotes();
      expect(notes.length).toBeGreaterThan(0);
    });
  });
});

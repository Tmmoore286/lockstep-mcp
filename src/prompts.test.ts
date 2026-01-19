import { describe, it, expect } from 'vitest';
import { getPlannerPrompt, getImplementerPrompt, getAutopilotPrompts } from './prompts.js';

describe('Prompts', () => {
  describe('getPlannerPrompt', () => {
    it('should return planner prompt with absolute prohibitions', () => {
      const prompt = getPlannerPrompt();

      // Check for prohibitions
      expect(prompt).toContain('ABSOLUTE PROHIBITIONS');
      expect(prompt).toContain('NEVER use file write/edit/update tools');
      expect(prompt).toContain('NEVER run build commands');
      expect(prompt).toContain('NEVER fix code errors yourself');
    });

    it('should include task complexity guidance', () => {
      const prompt = getPlannerPrompt();

      expect(prompt).toContain('TASK COMPLEXITY');
      expect(prompt).toContain('SIMPLE');
      expect(prompt).toContain('MEDIUM');
      expect(prompt).toContain('COMPLEX');
      expect(prompt).toContain('CRITICAL');
    });

    it('should include review workflow instructions', () => {
      const prompt = getPlannerPrompt();

      expect(prompt).toContain('REVIEWING TASKS');
      expect(prompt).toContain('task_approve');
      expect(prompt).toContain('task_request_changes');
    });

    it('should include coordination_init instruction', () => {
      const prompt = getPlannerPrompt();

      expect(prompt).toContain('coordination_init');
      expect(prompt).toContain('role: "planner"');
    });

    it('should include all phases', () => {
      const prompt = getPlannerPrompt();

      expect(prompt).toContain('PHASE 1 (gather_info)');
      expect(prompt).toContain('PHASE 2 (create_plan)');
      expect(prompt).toContain('PHASE 3 (create_tasks)');
      expect(prompt).toContain('PHASE 4 (monitor and review)');
    });
  });

  describe('getImplementerPrompt', () => {
    it('should return implementer prompt', () => {
      const prompt = getImplementerPrompt();

      expect(prompt).toContain('IMPLEMENTER');
      expect(prompt).toContain('coordination_init');
    });

    it('should include complexity protocol table', () => {
      const prompt = getImplementerPrompt();

      expect(prompt).toContain('TASK COMPLEXITY PROTOCOL');
      expect(prompt).toContain('| Complexity |');
      expect(prompt).toContain('SIMPLE');
      expect(prompt).toContain('MEDIUM');
      expect(prompt).toContain('COMPLEX');
      expect(prompt).toContain('CRITICAL');
    });

    it('should include continuous work loop', () => {
      const prompt = getImplementerPrompt();

      expect(prompt).toContain('CONTINUOUS WORK LOOP');
      expect(prompt).toContain('task_list');
      expect(prompt).toContain('task_claim');
      expect(prompt).toContain('lock_acquire');
      expect(prompt).toContain('lock_release');
    });

    it('should include review submission instructions', () => {
      const prompt = getImplementerPrompt();

      expect(prompt).toContain('task_submit_for_review');
      expect(prompt).toContain('reviewNotes');
    });

    it('should include discussion instructions', () => {
      const prompt = getImplementerPrompt();

      expect(prompt).toContain('WHEN TO DISCUSS WITH PLANNER');
      expect(prompt).toContain('discussion_inbox');
      expect(prompt).toContain('discussion_reply');
    });
  });

  describe('getAutopilotPrompts', () => {
    it('should include both prompts', () => {
      const combined = getAutopilotPrompts();

      expect(combined).toContain('PLANNER PROMPT');
      expect(combined).toContain('IMPLEMENTER PROMPT');
    });

    it('should include full planner prompt', () => {
      const combined = getAutopilotPrompts();
      const plannerPrompt = getPlannerPrompt();

      expect(combined).toContain(plannerPrompt);
    });

    it('should include full implementer prompt', () => {
      const combined = getAutopilotPrompts();
      const implementerPrompt = getImplementerPrompt();

      expect(combined).toContain(implementerPrompt);
    });
  });
});

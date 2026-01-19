import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  expandHome,
  normalizeRoots,
  isPathUnderRoot,
  resolvePath,
  ensureDir,
} from './utils.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('Utils', () => {
  describe('expandHome', () => {
    it('should expand ~ to HOME directory', () => {
      const home = process.env.HOME;
      if (!home) return; // Skip if HOME not set

      const expanded = expandHome('~/test/path');
      expect(expanded).toBe(path.join(home, 'test/path'));
    });

    it('should return unchanged if no ~', () => {
      const result = expandHome('/absolute/path');
      expect(result).toBe('/absolute/path');
    });

    it('should return unchanged for relative paths', () => {
      const result = expandHome('relative/path');
      expect(result).toBe('relative/path');
    });
  });

  describe('normalizeRoots', () => {
    it('should expand home and resolve paths', () => {
      const home = process.env.HOME;
      if (!home) return;

      const roots = normalizeRoots(['~/projects', './local']);
      expect(roots[0]).toBe(path.join(home, 'projects'));
      expect(path.isAbsolute(roots[1])).toBe(true);
    });

    it('should handle absolute paths', () => {
      const roots = normalizeRoots(['/absolute/path']);
      expect(roots[0]).toBe('/absolute/path');
    });

    it('should handle empty array', () => {
      const roots = normalizeRoots([]);
      expect(roots).toEqual([]);
    });
  });

  describe('isPathUnderRoot', () => {
    it('should return true for paths under root', () => {
      expect(isPathUnderRoot('/root/sub/file.ts', '/root')).toBe(true);
      expect(isPathUnderRoot('/root/file.ts', '/root')).toBe(true);
    });

    it('should return true for exact root match', () => {
      expect(isPathUnderRoot('/root', '/root')).toBe(true);
    });

    it('should return false for paths outside root', () => {
      expect(isPathUnderRoot('/other/file.ts', '/root')).toBe(false);
      expect(isPathUnderRoot('/root-other/file.ts', '/root')).toBe(false);
    });

    it('should return false for parent directories', () => {
      expect(isPathUnderRoot('/root/../parent', '/root')).toBe(false);
    });
  });

  describe('resolvePath', () => {
    it('should resolve path in open mode', () => {
      const result = resolvePath('/any/path', 'open', ['/root']);
      expect(result).toBe('/any/path');
    });

    it('should allow paths under root in strict mode', () => {
      const result = resolvePath('/root/sub/file.ts', 'strict', ['/root']);
      expect(result).toBe('/root/sub/file.ts');
    });

    it('should throw for paths outside root in strict mode', () => {
      expect(() => {
        resolvePath('/other/file.ts', 'strict', ['/root']);
      }).toThrow('Path not allowed in strict mode');
    });

    it('should check multiple roots in strict mode', () => {
      const result = resolvePath('/second/file.ts', 'strict', ['/first', '/second']);
      expect(result).toBe('/second/file.ts');
    });

    it('should expand home in path', () => {
      const home = process.env.HOME;
      if (!home) return;

      const result = resolvePath('~/file.ts', 'open', []);
      expect(result).toBe(path.join(home, 'file.ts'));
    });
  });

  describe('ensureDir', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lockstep-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('should create nested directories', async () => {
      const nestedPath = path.join(tempDir, 'a', 'b', 'c');
      await ensureDir(nestedPath);

      const stat = await fs.stat(nestedPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should not error if directory exists', async () => {
      await ensureDir(tempDir);
      const stat = await fs.stat(tempDir);
      expect(stat.isDirectory()).toBe(true);
    });
  });
});

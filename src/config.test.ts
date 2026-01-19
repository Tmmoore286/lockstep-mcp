import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';

describe('Config', () => {
  const originalArgv = process.argv;
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset modules cache to reload config with new args/env
    vi.resetModules();
    process.argv = ['node', 'script.js'];
    process.env = { ...originalEnv };
    // Clear config-related env vars
    delete process.env.COORD_SERVER_NAME;
    delete process.env.COORD_SERVER_VERSION;
    delete process.env.COORD_MODE;
    delete process.env.COORD_ROOTS;
    delete process.env.COORD_DATA_DIR;
    delete process.env.COORD_LOG_DIR;
    delete process.env.COORD_STORAGE;
    delete process.env.COORD_DB_PATH;
    delete process.env.COORD_COMMAND_MODE;
    delete process.env.COORD_COMMAND_ALLOW;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
  });

  it('should use default values', async () => {
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.serverName).toBe('lockstep-mcp');
    expect(config.serverVersion).toBe('0.1.0');
    expect(config.mode).toBe('open');
    expect(config.storage).toBe('sqlite');
    expect(config.command.mode).toBe('open');
    expect(config.command.allow).toEqual([]);
  });

  it('should parse --server-name argument', async () => {
    process.argv = ['node', 'script.js', '--server-name', 'custom-server'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.serverName).toBe('custom-server');
  });

  it('should use environment variable for server name', async () => {
    process.env.COORD_SERVER_NAME = 'env-server';
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.serverName).toBe('env-server');
  });

  it('should parse --mode argument', async () => {
    process.argv = ['node', 'script.js', '--mode', 'strict'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.mode).toBe('strict');
  });

  it('should parse --roots argument', async () => {
    process.argv = ['node', 'script.js', '--roots', '/project1,/project2'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.roots).toContain('/project1');
    expect(config.roots).toContain('/project2');
  });

  it('should parse --storage argument', async () => {
    process.argv = ['node', 'script.js', '--storage', 'json'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.storage).toBe('json');
  });

  it('should parse --command-mode argument', async () => {
    process.argv = ['node', 'script.js', '--command-mode', 'allowlist'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.command.mode).toBe('allowlist');
  });

  it('should parse --command-allow argument', async () => {
    process.argv = ['node', 'script.js', '--command-allow', 'git,npm,pnpm'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    expect(config.command.allow).toContain('git');
    expect(config.command.allow).toContain('npm');
    expect(config.command.allow).toContain('pnpm');
  });

  it('should handle invalid mode gracefully', async () => {
    process.argv = ['node', 'script.js', '--mode', 'invalid'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    // Should default to 'open' for invalid mode
    expect(config.mode).toBe('open');
  });

  it('should handle invalid storage gracefully', async () => {
    process.argv = ['node', 'script.js', '--storage', 'invalid'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    // Should default to 'sqlite' for invalid storage
    expect(config.storage).toBe('sqlite');
  });

  it('should expand home in data-dir', async () => {
    process.argv = ['node', 'script.js', '--data-dir', '~/custom-data'];
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();

    const home = process.env.HOME;
    if (home) {
      expect(config.dataDir).toBe(path.resolve(path.join(home, 'custom-data')));
    }
  });
});

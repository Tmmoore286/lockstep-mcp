import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

export type InstallTarget = "claude" | "codex" | "all" | "config";

export type InstallOptions = {
  target?: InstallTarget;
  configPath?: string;
  name?: string;
  mode?: string;
  roots?: string;
  storage?: string;
  dbPath?: string;
  dataDir?: string;
  logDir?: string;
  commandMode?: string;
  commandAllow?: string;
};

function expandHome(input: string): string {
  if (!input.startsWith("~")) return input;
  const home = os.homedir();
  return path.join(home, input.slice(1));
}

function getClaudeConfigPath(): string {
  // Claude Code uses project-level .mcp.json or we create in home
  const localConfig = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(localConfig)) return localConfig;
  return localConfig; // Default to creating in current directory
}

function getCodexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function resolveConfigPath(configPath?: string): string | undefined {
  if (configPath) return path.resolve(expandHome(configPath));
  const localConfig = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(localConfig)) return localConfig;
  return undefined;
}

function loadJsonConfig(configPath: string): { mcpServers: Record<string, unknown> } {
  if (!fs.existsSync(configPath)) {
    return { mcpServers: {} };
  }
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") {
    parsed.mcpServers = {};
  }
  return parsed;
}

function resolveServerEntry() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const distCli = path.join(repoRoot, "dist", "cli.js");
  const srcCli = path.join(repoRoot, "src", "cli.ts");
  if (fs.existsSync(distCli)) {
    return { command: "node", args: [distCli, "server"], distCli };
  }
  return { command: "node", args: ["--import", "tsx", srcCli, "server"], distCli };
}

function getNodePath(): string {
  // Try to find node in common locations
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    process.execPath,
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "node";
}

function buildServerArgs(options: InstallOptions): string[] {
  const entry = resolveServerEntry();
  const args = [...entry.args];

  if (options.mode) {
    args.push("--mode", options.mode);
  }
  if (options.roots) {
    args.push("--roots", options.roots);
  }
  if (options.dataDir) {
    args.push("--data-dir", options.dataDir);
  }
  if (options.logDir) {
    args.push("--log-dir", options.logDir);
  }
  if (options.storage) {
    args.push("--storage", options.storage);
  }
  if (options.dbPath) {
    args.push("--db-path", options.dbPath);
  }
  if (options.commandMode) {
    args.push("--command-mode", options.commandMode);
  }
  if (options.commandAllow) {
    args.push("--command-allow", options.commandAllow);
  }

  return args;
}

// Install to Claude's .mcp.json
function installToClaude(options: InstallOptions): { configPath: string; name: string } {
  const configPath = options.configPath ? expandHome(options.configPath) : getClaudeConfigPath();
  const config = loadJsonConfig(configPath);
  const entryName = options.name ?? "lockstep";
  const entry = resolveServerEntry();
  const args = buildServerArgs(options);

  config.mcpServers[entryName] = {
    command: getNodePath(),
    args: args.slice(1), // Remove 'node' from args since command is node
  };

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, name: entryName };
}

// Install to Codex's config.toml
function installToCodex(options: InstallOptions): { configPath: string; name: string } {
  const configPath = getCodexConfigPath();
  const entryName = options.name ?? "lockstep";
  const entry = resolveServerEntry();
  const args = buildServerArgs(options);

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Read existing config or create new
  let existingContent = "";
  if (fs.existsSync(configPath)) {
    existingContent = fs.readFileSync(configPath, "utf8");
  }

  // Check if entry already exists
  const sectionRegex = new RegExp(`\\[mcp_servers\\.${entryName}\\]`);
  if (sectionRegex.test(existingContent)) {
    // Update existing entry - remove old section first
    const sectionStart = existingContent.search(sectionRegex);
    const nextSectionMatch = existingContent.slice(sectionStart + 1).search(/\n\[/);
    const sectionEnd = nextSectionMatch === -1
      ? existingContent.length
      : sectionStart + 1 + nextSectionMatch;
    existingContent = existingContent.slice(0, sectionStart) + existingContent.slice(sectionEnd);
  }

  // Build TOML entry
  const nodePath = getNodePath();
  const argsWithoutNode = args.slice(1); // Remove 'node' since command handles it
  const argsToml = argsWithoutNode.map(a => `"${a}"`).join(", ");

  const tomlEntry = `
[mcp_servers.${entryName}]
command = "${nodePath}"
args = [${argsToml}]
env = { }
`;

  // Append to config
  const newContent = existingContent.trim() + "\n" + tomlEntry;
  fs.writeFileSync(configPath, newContent);

  return { configPath, name: entryName };
}

// Uninstall from Claude's .mcp.json
function uninstallFromClaude(name: string, configPath?: string): boolean {
  const fullPath = configPath ? expandHome(configPath) : getClaudeConfigPath();
  if (!fs.existsSync(fullPath)) return false;

  const config = loadJsonConfig(fullPath);
  if (!config.mcpServers[name]) return false;

  delete config.mcpServers[name];
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2));
  return true;
}

// Uninstall from Codex's config.toml
function uninstallFromCodex(name: string): boolean {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return false;

  let content = fs.readFileSync(configPath, "utf8");
  const sectionRegex = new RegExp(`\\[mcp_servers\\.${name}\\]`);

  if (!sectionRegex.test(content)) return false;

  // Remove the section
  const sectionStart = content.search(sectionRegex);
  const nextSectionMatch = content.slice(sectionStart + 1).search(/\n\[/);
  const sectionEnd = nextSectionMatch === -1
    ? content.length
    : sectionStart + 1 + nextSectionMatch;

  content = content.slice(0, sectionStart) + content.slice(sectionEnd);
  fs.writeFileSync(configPath, content.trim() + "\n");
  return true;
}

export function installMcpEntry(options: InstallOptions) {
  const target = options.target ?? "config";
  const results: { target: string; configPath: string; name: string }[] = [];

  if (target === "config") {
    // Legacy behavior: install to specified config path
    const configPath = resolveConfigPath(options.configPath);
    if (!configPath) {
      throw new Error("Missing --config. Provide the MCP config path (or run from a repo with .mcp.json).");
    }
    const config = loadJsonConfig(configPath);
    const entryName = options.name ?? "lockstep-mcp";
    const entry = resolveServerEntry();
    const args = buildServerArgs(options);

    config.mcpServers[entryName] = {
      command: entry.command,
      args,
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    return { configPath, name: entryName, serverPath: args.join(" ") };
  }

  if (target === "claude" || target === "all") {
    const result = installToClaude(options);
    results.push({ target: "claude", ...result });
  }

  if (target === "codex" || target === "all") {
    const result = installToCodex(options);
    results.push({ target: "codex", ...result });
  }

  return { results };
}

export function uninstallMcpEntry(options: { target?: InstallTarget; name?: string; configPath?: string }) {
  const target = options.target ?? "all";
  const name = options.name ?? "lockstep";
  const results: { target: string; removed: boolean }[] = [];

  if (target === "claude" || target === "all") {
    const removed = uninstallFromClaude(name, options.configPath);
    results.push({ target: "claude", removed });
  }

  if (target === "codex" || target === "all") {
    const removed = uninstallFromCodex(name);
    results.push({ target: "codex", removed });
  }

  return { results };
}

export function getInstallStatus(): { claude: boolean; codex: boolean; claudePath: string; codexPath: string } {
  const claudePath = getClaudeConfigPath();
  const codexPath = getCodexConfigPath();

  let claudeInstalled = false;
  let codexInstalled = false;

  if (fs.existsSync(claudePath)) {
    try {
      const config = loadJsonConfig(claudePath);
      claudeInstalled = !!config.mcpServers["lockstep"] || !!config.mcpServers["lockstep-mcp"];
    } catch {
      // ignore
    }
  }

  if (fs.existsSync(codexPath)) {
    try {
      const content = fs.readFileSync(codexPath, "utf8");
      codexInstalled = /\[mcp_servers\.lockstep/.test(content);
    } catch {
      // ignore
    }
  }

  return { claude: claudeInstalled, codex: codexInstalled, claudePath, codexPath };
}

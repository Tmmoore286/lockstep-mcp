import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type InstallOptions = {
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
  const home = process.env.HOME || "";
  return path.join(home, input.slice(1));
}

function resolveConfigPath(configPath?: string): string | undefined {
  if (configPath) return path.resolve(expandHome(configPath));
  const localConfig = path.resolve(process.cwd(), ".mcp.json");
  if (fs.existsSync(localConfig)) return localConfig;
  return undefined;
}

function loadConfig(configPath: string): { mcpServers: Record<string, unknown> } {
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
    return { command: "node", args: [distCli, "server"] };
  }
  return { command: "node", args: ["--import", "tsx", srcCli, "server"] };
}

export function installMcpEntry(options: InstallOptions) {
  const configPath = resolveConfigPath(options.configPath);
  if (!configPath) {
    throw new Error("Missing --config. Provide the MCP config path (or run from a repo with .mcp.json).");
  }

  const config = loadConfig(configPath);
  const entryName = options.name ?? "lockstep-mcp";
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

  config.mcpServers[entryName] = {
    command: entry.command,
    args,
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    configPath,
    name: entryName,
    serverPath: args.join(" "),
  };
}

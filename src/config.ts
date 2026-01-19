import path from "node:path";
import { expandHome, normalizeRoots } from "./utils.js";

export type AccessMode = "open" | "strict";
export type CommandMode = "open" | "allowlist";
export type StorageBackend = "json" | "sqlite";

export type CommandPolicy = {
  mode: CommandMode;
  allow: string[];
};

export type Config = {
  serverName: string;
  serverVersion: string;
  dataDir: string;
  logDir: string;
  storage: StorageBackend;
  dbPath: string;
  mode: AccessMode;
  roots: string[];
  command: CommandPolicy;
};

const DEFAULT_ROOT = process.cwd();

function parseArgValue(args: string[], key: string): string | undefined {
  const idx = args.indexOf(key);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export function loadConfig(): Config {
  const args = process.argv.slice(2);
  const serverName =
    parseArgValue(args, "--server-name") || process.env.COORD_SERVER_NAME || "lockstep-mcp";
  const serverVersion =
    parseArgValue(args, "--server-version") || process.env.COORD_SERVER_VERSION || "0.1.0";

  const mode =
    (parseArgValue(args, "--mode") || process.env.COORD_MODE || "open") as AccessMode;

  const rootsRaw =
    parseArgValue(args, "--roots") || process.env.COORD_ROOTS || DEFAULT_ROOT;
  const roots = normalizeRoots(
    rootsRaw
      .split(",")
      .map((root: string) => root.trim())
      .filter(Boolean)
  );

  const dataDirRaw =
    parseArgValue(args, "--data-dir") || process.env.COORD_DATA_DIR || "~/.lockstep-mcp/data";
  const logDirRaw =
    parseArgValue(args, "--log-dir") || process.env.COORD_LOG_DIR || "~/.lockstep-mcp/logs";
  const dataDir = path.resolve(expandHome(dataDirRaw));
  const logDir = path.resolve(expandHome(logDirRaw));

  const storage =
    (parseArgValue(args, "--storage") || process.env.COORD_STORAGE || "sqlite") as StorageBackend;
  const dbPathRaw =
    parseArgValue(args, "--db-path") || process.env.COORD_DB_PATH || path.join(dataDir, "coordinator.db");

  const commandMode =
    (parseArgValue(args, "--command-mode") ||
      process.env.COORD_COMMAND_MODE ||
      "open") as CommandMode;
  const commandAllowRaw =
    parseArgValue(args, "--command-allow") || process.env.COORD_COMMAND_ALLOW || "";
  const commandAllow = commandAllowRaw
    .split(",")
    .map((cmd: string) => cmd.trim())
    .filter(Boolean);

  return {
    serverName,
    serverVersion,
    dataDir,
    logDir,
    storage: storage === "json" ? "json" : "sqlite",
    dbPath: path.resolve(expandHome(dbPathRaw)),
    mode: mode === "strict" ? "strict" : "open",
    roots,
    command: {
      mode: commandMode === "allowlist" ? "allowlist" : "open",
      allow: commandAllow,
    },
  };
}

import { installMcpEntry } from "./install.js";
import { getAutopilotPrompts, getPlannerPrompt, getImplementerPrompt } from "./prompts.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args[token] = true;
      } else {
        args[token] = value;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, args };
}

function printHelp() {
  const text = `lockstep-mcp

Usage:
  lockstep-mcp server [--mode open|strict] [--roots <paths>] [--storage sqlite|json] [--db-path <path>] [--data-dir <path>] [--log-dir <path>]
  lockstep-mcp dashboard [--host <host>] [--port <port>] [--poll-ms <ms>]
  lockstep-mcp tmux [--repo <path>] [--session <name>] [--claude-cmd <cmd>] [--codex-cmd <cmd>] [--no-prompts]
  lockstep-mcp prompts [--role planner|implementer]
  lockstep-mcp install --config <path> [--name <server-name>] [--mode open|strict] [--roots <paths>] [--storage sqlite|json] [--db-path <path>]

Examples:
  lockstep-mcp server --mode strict --roots /path/to/repo,/tmp --storage sqlite
  lockstep-mcp dashboard --host 127.0.0.1 --port 8787
  lockstep-mcp tmux --repo /path/to/repo
  lockstep-mcp install --config ~/.codex/.mcp.json --mode strict --roots /path/to/repo,/tmp --storage sqlite
  lockstep-mcp prompts
`;
  process.stdout.write(text);
}

async function main() {
  const { positional, args } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "server";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "install") {
    const result = installMcpEntry({
      configPath: typeof args["--config"] === "string" ? args["--config"] : undefined,
      name: typeof args["--name"] === "string" ? args["--name"] : undefined,
      mode: typeof args["--mode"] === "string" ? args["--mode"] : undefined,
      roots: typeof args["--roots"] === "string" ? args["--roots"] : undefined,
      storage: typeof args["--storage"] === "string" ? args["--storage"] : undefined,
      dbPath: typeof args["--db-path"] === "string" ? args["--db-path"] : undefined,
      dataDir: typeof args["--data-dir"] === "string" ? args["--data-dir"] : undefined,
      logDir: typeof args["--log-dir"] === "string" ? args["--log-dir"] : undefined,
      commandMode: typeof args["--command-mode"] === "string" ? args["--command-mode"] : undefined,
      commandAllow: typeof args["--command-allow"] === "string" ? args["--command-allow"] : undefined,
    });

    process.stdout.write(`Wrote MCP server entry "${result.name}" to ${result.configPath}\n`);
    process.stdout.write(`Server args: ${result.serverPath}\n`);
    return;
  }

  if (command === "prompts") {
    const role = typeof args["--role"] === "string" ? args["--role"] : undefined;
    if (role === "planner") {
      process.stdout.write(getPlannerPrompt());
      return;
    }
    if (role === "implementer") {
      process.stdout.write(getImplementerPrompt());
      return;
    }
    process.stdout.write(getAutopilotPrompts());
    return;
  }

  if (command === "dashboard") {
    const { startDashboard } = await import("./dashboard.js");
    const port = typeof args["--port"] === "string" ? Number(args["--port"]) : undefined;
    const host = typeof args["--host"] === "string" ? args["--host"] : undefined;
    const pollMs = typeof args["--poll-ms"] === "string" ? Number(args["--poll-ms"]) : undefined;
    await startDashboard({ port, host, pollMs });
    return;
  }

  if (command === "tmux") {
    const { launchTmux } = await import("./tmux.js");
    const repo = typeof args["--repo"] === "string" ? args["--repo"] : undefined;
    const session = typeof args["--session"] === "string" ? args["--session"] : undefined;
    const claudeCmd = typeof args["--claude-cmd"] === "string" ? args["--claude-cmd"] : undefined;
    const codexCmd = typeof args["--codex-cmd"] === "string" ? args["--codex-cmd"] : undefined;
    const injectPrompts = args["--no-prompts"] ? false : true;
    await launchTmux({ repo, session, claudeCmd, codexCmd, injectPrompts });
    return;
  }

  if (command === "server") {
    const { startServer } = await import("./server.js");
    await startServer();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

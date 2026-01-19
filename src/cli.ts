import { installMcpEntry, uninstallMcpEntry, getInstallStatus, type InstallTarget } from "./install.js";
import { getAutopilotPrompts, getPlannerPrompt, getImplementerPrompt } from "./prompts.js";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

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

const LOCKSTEP_MARKER_START = "<!-- LOCKSTEP COORDINATION -->";
const LOCKSTEP_MARKER_END = "<!-- END LOCKSTEP -->";

const LOCKSTEP_INSTRUCTIONS = `${LOCKSTEP_MARKER_START}
This project uses lockstep-mcp for multi-agent coordination.

When starting a coordination session, call \`coordination_init\` with your role:
- role: "planner" - You'll plan tasks and create work items
- role: "implementer" - You'll claim and complete tasks

The planner will be asked to provide project context if not already set.
The implementer will see available tasks or be told to wait for the planner.

**If the user says "don't use lockstep" or "work independently", stop using lockstep tools and work normally.**

For more info: https://github.com/anthropics/lockstep-mcp
${LOCKSTEP_MARKER_END}`;

function printHelp() {
  const text = `lockstep-mcp - Multi-agent coordination for Claude and Codex

Usage:
  lockstep-mcp install [--claude] [--codex] [--all] [--config <path>] [--mode open|strict] [--roots <paths>] [--storage sqlite|json]
  lockstep-mcp uninstall [--claude] [--codex] [--all] [--name <server-name>]
  lockstep-mcp init [--force]
  lockstep-mcp disable
  lockstep-mcp enable
  lockstep-mcp status
  lockstep-mcp server [--mode open|strict] [--roots <paths>] [--storage sqlite|json] [--db-path <path>]
  lockstep-mcp dashboard [--host <host>] [--port <port>] [--poll-ms <ms>]
  lockstep-mcp tmux [--repo <path>] [--session <name>] [--layout windows|panes]
  lockstep-mcp macos [--repo <path>]
  lockstep-mcp prompts [--role planner|implementer]

Commands:
  install     Add lockstep-mcp to Claude and/or Codex MCP configs
  uninstall   Remove lockstep-mcp from configs
  init        Add coordination instructions to CLAUDE.md (creates if needed)
  disable     Remove coordination instructions from CLAUDE.md
  enable      Re-add coordination instructions to CLAUDE.md
  status      Show installation status
  server      Start the MCP server (called by Claude/Codex)
  dashboard   Start the web dashboard
  tmux        Launch Claude + Codex in tmux
  macos       Launch Claude + Codex in macOS Terminal

Examples:
  lockstep-mcp install --all                    # Install for both Claude and Codex
  lockstep-mcp install --codex --mode strict    # Install for Codex only
  lockstep-mcp init                             # Add instructions to current project
  lockstep-mcp status                           # Check installation status
`;
  process.stdout.write(text);
}

function findInstructionsFile(): string {
  // Look for existing files in order of preference
  const candidates = ["CLAUDE.md", "AGENTS.md"];
  for (const candidate of candidates) {
    const fullPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  // Default to CLAUDE.md
  return path.resolve(process.cwd(), "CLAUDE.md");
}

function initProject(force: boolean): { file: string; action: string } {
  const filePath = findInstructionsFile();
  const fileName = path.basename(filePath);

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf8");

    // Check if already has lockstep instructions
    if (content.includes(LOCKSTEP_MARKER_START)) {
      if (!force) {
        return { file: filePath, action: "already_exists" };
      }
      // Remove existing section and re-add
      const newContent = removeLockstepSection(content);
      fs.writeFileSync(filePath, newContent + "\n\n" + LOCKSTEP_INSTRUCTIONS + "\n");
      return { file: filePath, action: "updated" };
    }

    // Append to existing file
    fs.writeFileSync(filePath, content.trimEnd() + "\n\n" + LOCKSTEP_INSTRUCTIONS + "\n");
    return { file: filePath, action: "appended" };
  }

  // Create new file
  fs.writeFileSync(filePath, `# Project Instructions\n\n${LOCKSTEP_INSTRUCTIONS}\n`);
  return { file: filePath, action: "created" };
}

function removeLockstepSection(content: string): string {
  const startIdx = content.indexOf(LOCKSTEP_MARKER_START);
  if (startIdx === -1) return content;

  const endIdx = content.indexOf(LOCKSTEP_MARKER_END);
  if (endIdx === -1) return content;

  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + LOCKSTEP_MARKER_END.length).trimStart();

  return before + (after ? "\n\n" + after : "");
}

function disableProject(): { file: string; action: string } {
  const filePath = findInstructionsFile();

  if (!fs.existsSync(filePath)) {
    return { file: filePath, action: "not_found" };
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (!content.includes(LOCKSTEP_MARKER_START)) {
    return { file: filePath, action: "not_enabled" };
  }

  const newContent = removeLockstepSection(content);
  fs.writeFileSync(filePath, newContent.trimEnd() + "\n");
  return { file: filePath, action: "disabled" };
}

function enableProject(): { file: string; action: string } {
  return initProject(false);
}

function getProjectStatus(): { enabled: boolean; file: string | null } {
  const candidates = ["CLAUDE.md", "AGENTS.md"];
  for (const candidate of candidates) {
    const fullPath = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf8");
      if (content.includes(LOCKSTEP_MARKER_START)) {
        return { enabled: true, file: fullPath };
      }
    }
  }
  return { enabled: false, file: null };
}

async function main() {
  const { positional, args } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "server";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "install") {
    // Determine target
    let target: InstallTarget = "config";
    if (args["--all"]) target = "all";
    else if (args["--claude"]) target = "claude";
    else if (args["--codex"]) target = "codex";
    else if (args["--config"]) target = "config";
    else target = "all"; // Default to all

    const result = installMcpEntry({
      target,
      configPath: typeof args["--config"] === "string" ? args["--config"] : undefined,
      name: typeof args["--name"] === "string" ? args["--name"] : undefined,
      mode: typeof args["--mode"] === "string" ? args["--mode"] : "open",
      roots: typeof args["--roots"] === "string" ? args["--roots"] : undefined,
      storage: typeof args["--storage"] === "string" ? args["--storage"] : "sqlite",
      dbPath: typeof args["--db-path"] === "string" ? args["--db-path"] : undefined,
      dataDir: typeof args["--data-dir"] === "string" ? args["--data-dir"] : undefined,
      logDir: typeof args["--log-dir"] === "string" ? args["--log-dir"] : undefined,
      commandMode: typeof args["--command-mode"] === "string" ? args["--command-mode"] : undefined,
      commandAllow: typeof args["--command-allow"] === "string" ? args["--command-allow"] : undefined,
    });

    if ("results" in result && result.results) {
      for (const r of result.results) {
        process.stdout.write(`✓ Installed lockstep to ${r.target}: ${r.configPath}\n`);
      }
      process.stdout.write(`\nNext step: Run 'lockstep-mcp init' in your project directory to enable coordination.\n`);
    } else if ("configPath" in result) {
      process.stdout.write(`Wrote MCP server entry "${result.name}" to ${result.configPath}\n`);
    }
    return;
  }

  if (command === "uninstall") {
    let target: InstallTarget = "all";
    if (args["--claude"]) target = "claude";
    else if (args["--codex"]) target = "codex";

    const result = uninstallMcpEntry({
      target,
      name: typeof args["--name"] === "string" ? args["--name"] : undefined,
      configPath: typeof args["--config"] === "string" ? args["--config"] : undefined,
    });

    for (const r of result.results) {
      if (r.removed) {
        process.stdout.write(`✓ Removed lockstep from ${r.target}\n`);
      } else {
        process.stdout.write(`- lockstep not found in ${r.target}\n`);
      }
    }
    return;
  }

  if (command === "init") {
    const force = !!args["--force"];
    const result = initProject(force);

    if (result.action === "already_exists") {
      process.stdout.write(`Lockstep instructions already exist in ${result.file}\n`);
      process.stdout.write(`Use --force to update them.\n`);
    } else if (result.action === "created") {
      process.stdout.write(`✓ Created ${result.file} with lockstep instructions\n`);
    } else if (result.action === "appended") {
      process.stdout.write(`✓ Added lockstep instructions to ${result.file}\n`);
    } else if (result.action === "updated") {
      process.stdout.write(`✓ Updated lockstep instructions in ${result.file}\n`);
    }
    return;
  }

  if (command === "disable") {
    const result = disableProject();

    if (result.action === "not_found") {
      process.stdout.write(`No CLAUDE.md or AGENTS.md found in current directory.\n`);
    } else if (result.action === "not_enabled") {
      process.stdout.write(`Lockstep instructions not found in ${result.file}\n`);
    } else {
      process.stdout.write(`✓ Removed lockstep instructions from ${result.file}\n`);
    }
    return;
  }

  if (command === "enable") {
    const result = enableProject();

    if (result.action === "already_exists") {
      process.stdout.write(`Lockstep already enabled in ${result.file}\n`);
    } else {
      process.stdout.write(`✓ Enabled lockstep in ${result.file}\n`);
    }
    return;
  }

  if (command === "status") {
    const installStatus = getInstallStatus();
    const projectStatus = getProjectStatus();

    process.stdout.write(`\nLockstep MCP Status\n`);
    process.stdout.write(`${"─".repeat(50)}\n\n`);

    process.stdout.write(`Global Installation:\n`);
    process.stdout.write(`  Claude: ${installStatus.claude ? "✓ Installed" : "✗ Not installed"}\n`);
    process.stdout.write(`          ${installStatus.claudePath}\n`);
    process.stdout.write(`  Codex:  ${installStatus.codex ? "✓ Installed" : "✗ Not installed"}\n`);
    process.stdout.write(`          ${installStatus.codexPath}\n\n`);

    process.stdout.write(`Current Project (${process.cwd()}):\n`);
    if (projectStatus.enabled) {
      process.stdout.write(`  Coordination: ✓ Enabled\n`);
      process.stdout.write(`  Instructions: ${projectStatus.file}\n`);
    } else {
      process.stdout.write(`  Coordination: ✗ Not enabled\n`);
      process.stdout.write(`  Run 'lockstep-mcp init' to enable.\n`);
    }
    process.stdout.write(`\n`);
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
    const layout = typeof args["--layout"] === "string" ? args["--layout"] : undefined;
    const split = typeof args["--split"] === "string" ? args["--split"] : undefined;
    const showDashboard = args["--no-dashboard"] ? false : true;
    const dashboardHost = typeof args["--dashboard-host"] === "string" ? args["--dashboard-host"] : "127.0.0.1";
    const dashboardPort = typeof args["--dashboard-port"] === "string" ? Number(args["--dashboard-port"]) : 8787;
    const cliPath = path.resolve(fileURLToPath(import.meta.url));
    const nodePath = process.execPath;
    const dashboardArgs = ["dashboard", "--host", dashboardHost, "--port", String(dashboardPort)];
    const dashboardCmd = cliPath.endsWith(".ts")
      ? `${nodePath} --import tsx ${cliPath} ${dashboardArgs.join(" ")}`
      : `${nodePath} ${cliPath} ${dashboardArgs.join(" ")}`;

    await launchTmux({
      repo,
      session,
      claudeCmd,
      codexCmd,
      injectPrompts,
      layout: layout === "panes" ? "panes" : "windows",
      split: split === "horizontal" ? "horizontal" : "vertical",
      dashboard: showDashboard,
      dashboardCmd,
    });
    return;
  }

  if (command === "macos") {
    const { launchMacos } = await import("./macos.js");
    const repo = typeof args["--repo"] === "string" ? args["--repo"] : undefined;
    const claudeCmd = typeof args["--claude-cmd"] === "string" ? args["--claude-cmd"] : undefined;
    const codexCmd = typeof args["--codex-cmd"] === "string" ? args["--codex-cmd"] : undefined;
    const dashboardHost = typeof args["--dashboard-host"] === "string" ? args["--dashboard-host"] : "127.0.0.1";
    const dashboardPort = typeof args["--dashboard-port"] === "string" ? Number(args["--dashboard-port"]) : 8787;
    await launchMacos({ repo, claudeCmd, codexCmd, dashboardHost, dashboardPort });
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

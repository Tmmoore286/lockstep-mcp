import { spawnSync } from "node:child_process";
import path from "node:path";
import { getPlannerPrompt, getImplementerPrompt } from "./prompts.js";

export type TmuxOptions = {
  session?: string;
  repo?: string;
  claudeCmd?: string;
  codexCmd?: string;
  injectPrompts?: boolean;
  layout?: "windows" | "panes";
  split?: "horizontal" | "vertical";
  dashboard?: boolean;
  dashboardCmd?: string;
  statusBar?: boolean;
};

function runTmux(args: string[], inherit = false) {
  const result = spawnSync("tmux", args, { stdio: inherit ? "inherit" : "pipe" });
  if (result.error) throw result.error;
  return result.status ?? 0;
}

function ensureTmuxAvailable() {
  try {
    const status = runTmux(["-V"]);
    if (status !== 0) throw new Error("tmux not available");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`tmux not found or not available: ${message}`);
  }
}

function sessionExists(session: string): boolean {
  const status = runTmux(["has-session", "-t", session]);
  return status === 0;
}

function sendKeys(target: string, text: string) {
  runTmux(["send-keys", "-t", target, "-l", text]);
  runTmux(["send-keys", "-t", target, "C-m"]);
}

export async function launchTmux(options: TmuxOptions = {}) {
  ensureTmuxAvailable();

  const session = options.session ?? "lockstep";
  const repo = path.resolve(options.repo ?? process.cwd());
  const claudeCmd = options.claudeCmd ?? "claude";
  const codexCmd = options.codexCmd ?? "codex";
  const injectPrompts = options.injectPrompts !== false;
  const layout = options.layout ?? "windows";
  const split = options.split ?? "vertical";
  const showDashboard = options.dashboard !== false;
  const dashboardCmd = options.dashboardCmd ?? "lockstep-mcp dashboard --host 127.0.0.1 --port 8787";
  const statusBar = options.statusBar !== false;

  if (!sessionExists(session)) {
    runTmux(["new-session", "-d", "-s", session, "-c", repo, "-n", "claude"]);
    if (statusBar) {
      runTmux(["set-option", "-t", session, "-g", "status", "on"]);
      runTmux(["set-option", "-t", session, "-g", "status-style", "bg=colour237,fg=colour252"]);
      runTmux(["set-option", "-t", session, "-g", "status-left", " lockstep "]);
      runTmux(["set-option", "-t", session, "-g", "status-right", "Ctrl-b n/p | Ctrl-b w"]);
      runTmux(["set-option", "-t", session, "-g", "window-status-format", " #I:#W "]);
      runTmux(["set-option", "-t", session, "-g", "window-status-current-format", " #[bold]#I:#W "]);
    }
    sendKeys(`${session}:0.0`, claudeCmd);

    if (layout === "panes") {
      if (split === "vertical") {
        runTmux(["split-window", "-h", "-t", `${session}:0`, "-c", repo]);
      } else {
        runTmux(["split-window", "-v", "-t", `${session}:0`, "-c", repo]);
      }
      runTmux(["select-layout", "-t", `${session}:0`, "even-horizontal"]);
      sendKeys(`${session}:0.1`, codexCmd);
    } else {
      runTmux(["new-window", "-t", session, "-n", "codex", "-c", repo]);
      sendKeys(`${session}:1.0`, codexCmd);
    }

    if (injectPrompts) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      sendKeys(`${session}:0.0`, getPlannerPrompt());
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (layout === "panes") {
        sendKeys(`${session}:0.1`, getImplementerPrompt());
      } else {
        sendKeys(`${session}:1.0`, getImplementerPrompt());
      }
    }

    if (showDashboard) {
      const targetIndex = layout === "panes" ? "1.0" : "2.0";
      runTmux(["new-window", "-t", session, "-n", "dashboard", "-c", repo]);
      sendKeys(`${session}:${targetIndex}`, dashboardCmd);
    }

    if (statusBar) {
      runTmux(["display-message", "-t", session, "Lockstep: Ctrl-b n/p switch windows, Ctrl-b w list"]);
    }
  }

  runTmux(["attach", "-t", session], true);
}

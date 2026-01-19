import { spawnSync } from "node:child_process";
import path from "node:path";
import { getPlannerPrompt, getImplementerPrompt } from "./prompts.js";

export type TmuxOptions = {
  session?: string;
  repo?: string;
  claudeCmd?: string;
  codexCmd?: string;
  injectPrompts?: boolean;
  split?: "horizontal" | "vertical";
  dashboard?: boolean;
  dashboardCmd?: string;
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
  const split = options.split ?? "vertical";
  const showDashboard = options.dashboard !== false;
  const dashboardCmd = options.dashboardCmd ?? "lockstep-mcp dashboard --host 127.0.0.1 --port 8787";

  if (!sessionExists(session)) {
    runTmux(["new-session", "-d", "-s", session, "-c", repo]);
    if (split === "vertical") {
      runTmux(["split-window", "-h", "-t", `${session}:0`, "-c", repo]);
    } else {
      runTmux(["split-window", "-v", "-t", `${session}:0`, "-c", repo]);
    }
    runTmux(["select-layout", "-t", `${session}:0`, "even-horizontal"]);

    sendKeys(`${session}:0.0`, claudeCmd);
    sendKeys(`${session}:0.1`, codexCmd);

    if (injectPrompts) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      sendKeys(`${session}:0.0`, getPlannerPrompt());
      await new Promise((resolve) => setTimeout(resolve, 500));
      sendKeys(`${session}:0.1`, getImplementerPrompt());
    }

    if (showDashboard) {
      runTmux(["new-window", "-t", session, "-n", "dashboard", "-c", repo]);
      sendKeys(`${session}:1.0`, dashboardCmd);
    }
  }

  runTmux(["attach", "-t", session], true);
}

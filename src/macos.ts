import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "./utils.js";

export type MacosOptions = {
  repo?: string;
  claudeCmd?: string;
  codexCmd?: string;
  dashboardHost?: string;
  dashboardPort?: number;
};

export async function launchMacos(options: MacosOptions = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macos launcher is only supported on macOS");
  }

  const repo = path.resolve(options.repo ?? process.cwd());
  const claudeCmd = options.claudeCmd ?? "claude";
  const codexCmd = options.codexCmd ?? "codex";
  const dashboardHost = options.dashboardHost ?? "127.0.0.1";
  const dashboardPort = options.dashboardPort ?? 8787;

  const macosPath = path.resolve(fileURLToPath(import.meta.url));
  const baseDir = path.dirname(macosPath);
  const nodePath = process.execPath;
  const cliPath = macosPath.endsWith(".ts")
    ? path.join(baseDir, "cli.ts")
    : path.join(baseDir, "cli.js");
  const dashboardArgs = ["dashboard", "--host", dashboardHost, "--port", String(dashboardPort)];
  const dashboardCmd = cliPath.endsWith(".ts")
    ? `${nodePath} --import tsx ${cliPath} ${dashboardArgs.join(" ")}`
    : `${nodePath} ${cliPath} ${dashboardArgs.join(" ")}`;

  const commands = [
    `cd "${repo}" && ${claudeCmd}`,
    `cd "${repo}" && ${codexCmd}`,
    dashboardCmd,
  ];

  for (const command of commands) {
    const openResult = spawnSync("open", ["-na", "Terminal"]);
    if (openResult.status !== 0) {
      throw new Error("Failed to open Terminal window");
    }

    const escaped = command.replace(/\"/g, "\\\"");
    const script = `tell application \"Terminal\" to do script \"${escaped}\"`;
    let success = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await sleep(500);
      if (process.env.LOCKSTEP_DEBUG) {
        process.stderr.write(`osascript: ${script}\n`);
      }
      const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
      if (result.status === 0) {
        success = true;
        break;
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    if (!success) {
      throw new Error("Failed to run command in Terminal window");
    }
  }
}

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MacosOptions = {
  repo?: string;
  claudeCmd?: string;
  codexCmd?: string;
  dashboardHost?: string;
  dashboardPort?: number;
};

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export async function launchMacos(options: MacosOptions = {}) {
  if (process.platform !== "darwin") {
    throw new Error("macos launcher is only supported on macOS");
  }

  const repo = path.resolve(options.repo ?? process.cwd());
  const claudeCmd = options.claudeCmd ?? "claude";
  const codexCmd = options.codexCmd ?? "codex";
  const dashboardHost = options.dashboardHost ?? "127.0.0.1";
  const dashboardPort = options.dashboardPort ?? 8787;

  const cliPath = path.resolve(fileURLToPath(import.meta.url));
  const nodePath = process.execPath;
  const dashboardArgs = ["dashboard", "--host", dashboardHost, "--port", String(dashboardPort)];
  const dashboardCmd = cliPath.endsWith(".ts")
    ? `${nodePath} --import tsx ${cliPath} ${dashboardArgs.join(" ")}`
    : `${nodePath} ${cliPath} ${dashboardArgs.join(" ")}`;

  const commands = [
    `cd \"${repo}\" && ${claudeCmd}`,
    `cd \"${repo}\" && ${codexCmd}`,
    dashboardCmd,
  ].map(escapeAppleScript);

  const script = `tell application "Terminal"
  activate
  set w1 to (make new window with default settings)
  do script "${commands[0]}" in w1
  set w2 to (make new window with default settings)
  do script "${commands[1]}" in w2
  set w3 to (make new window with default settings)
  do script "${commands[2]}" in w3
end tell`;

  const result = spawnSync("osascript", ["-e", script], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error("Failed to open Terminal windows with osascript");
  }
}

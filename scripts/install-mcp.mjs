import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

const result = spawnSync(
  "node",
  ["--loader", "tsx", cliPath, "install", ...process.argv.slice(2)],
  { stdio: "inherit" }
);

process.exit(result.status ?? 1);

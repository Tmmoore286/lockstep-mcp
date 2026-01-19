import fs from "node:fs/promises";
import path from "node:path";

export function expandHome(input: string): string {
  if (!input.startsWith("~")) return input;
  const home = process.env.HOME;
  if (!home) return input;
  return path.join(home, input.slice(1));
}

export function normalizeRoots(roots: string[]): string[] {
  return roots
    .map((root) => expandHome(root))
    .map((root) => path.resolve(root));
}

export function isPathUnderRoot(targetPath: string, root: string): boolean {
  const rel = path.relative(root, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolvePath(inputPath: string, mode: "open" | "strict", roots: string[]): string {
  const resolved = path.resolve(expandHome(inputPath));
  if (mode === "open") return resolved;
  for (const root of roots) {
    if (isPathUnderRoot(resolved, root)) return resolved;
  }
  throw new Error(`Path not allowed in strict mode: ${resolved}`);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

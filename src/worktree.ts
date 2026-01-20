/**
 * Git worktree management for isolated implementer work
 */
import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const exec = promisify(execCallback);

export type WorktreeInfo = {
  path: string;
  branchName: string;
  head: string;
};

export type WorktreeStatus = {
  ahead: number;
  behind: number;
  hasUncommittedChanges: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
};

export type MergeResult = {
  success: boolean;
  merged: boolean;
  conflicts?: string[];
  error?: string;
};

const LOCKSTEP_WORKTREE_DIR = ".lockstep/worktrees";

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await exec("git rev-parse --git-dir", { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git root directory
 */
export async function getGitRoot(repoPath: string): Promise<string> {
  const { stdout } = await exec("git rev-parse --show-toplevel", { cwd: repoPath });
  return stdout.trim();
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const { stdout } = await exec("git rev-parse --abbrev-ref HEAD", { cwd: repoPath });
  return stdout.trim();
}

/**
 * Create a git worktree for an implementer
 */
export async function createWorktree(
  repoPath: string,
  implName: string
): Promise<{ worktreePath: string; branchName: string }> {
  const gitRoot = await getGitRoot(repoPath);
  const worktreeBase = path.join(gitRoot, LOCKSTEP_WORKTREE_DIR);
  const worktreePath = path.join(worktreeBase, implName);
  const branchName = `lockstep/${implName}`;

  // Ensure the worktree directory exists
  await fs.mkdir(worktreeBase, { recursive: true });

  // Check if worktree already exists
  try {
    await fs.access(worktreePath);
    // Worktree exists, clean it up first
    await removeWorktree(worktreePath);
  } catch {
    // Doesn't exist, that's fine
  }

  // Get current HEAD to branch from
  const { stdout: currentHead } = await exec("git rev-parse HEAD", { cwd: gitRoot });
  const headCommit = currentHead.trim();

  // Delete branch if it exists (from previous run)
  try {
    await exec(`git branch -D "${branchName}"`, { cwd: gitRoot });
  } catch {
    // Branch doesn't exist, that's fine
  }

  // Create the worktree with a new branch
  await exec(`git worktree add -b "${branchName}" "${worktreePath}" "${headCommit}"`, { cwd: gitRoot });

  return { worktreePath, branchName };
}

/**
 * Remove a git worktree and its branch
 */
export async function removeWorktree(worktreePath: string): Promise<void> {
  try {
    // Get the branch name before removing
    const { stdout: branchOutput } = await exec("git rev-parse --abbrev-ref HEAD", { cwd: worktreePath });
    const branchName = branchOutput.trim();

    // Get the main repo path
    const { stdout: gitDirOutput } = await exec("git rev-parse --git-common-dir", { cwd: worktreePath });
    const gitCommonDir = gitDirOutput.trim();
    const mainRepoPath = path.dirname(gitCommonDir);

    // Remove the worktree
    await exec(`git worktree remove --force "${worktreePath}"`, { cwd: mainRepoPath });

    // Delete the branch if it starts with lockstep/
    if (branchName.startsWith("lockstep/")) {
      try {
        await exec(`git branch -D "${branchName}"`, { cwd: mainRepoPath });
      } catch {
        // Branch might not exist or be the current branch
      }
    }
  } catch (error) {
    // Fallback: just try to prune and remove directory
    try {
      const gitRoot = await getGitRoot(path.dirname(worktreePath));
      await exec("git worktree prune", { cwd: gitRoot });
      await fs.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}

/**
 * Get the status of a worktree (commits ahead/behind, uncommitted changes)
 */
export async function getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
  // Fetch latest from remote (silently)
  try {
    await exec("git fetch origin", { cwd: worktreePath, timeout: 10000 });
  } catch {
    // Ignore fetch errors (might be offline)
  }

  // Get the main branch (usually main or master)
  let mainBranch = "main";
  try {
    const { stdout } = await exec("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo 'refs/remotes/origin/main'", { cwd: worktreePath });
    mainBranch = stdout.trim().replace("refs/remotes/origin/", "");
  } catch {
    // Default to main
  }

  // Count commits ahead/behind
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout: aheadOutput } = await exec(`git rev-list --count origin/${mainBranch}..HEAD`, { cwd: worktreePath });
    ahead = parseInt(aheadOutput.trim(), 10) || 0;
    const { stdout: behindOutput } = await exec(`git rev-list --count HEAD..origin/${mainBranch}`, { cwd: worktreePath });
    behind = parseInt(behindOutput.trim(), 10) || 0;
  } catch {
    // Ignore errors (might be no remote)
  }

  // Get modified files
  const { stdout: statusOutput } = await exec("git status --porcelain", { cwd: worktreePath });
  const lines = statusOutput.trim().split("\n").filter(Boolean);

  const modifiedFiles: string[] = [];
  const untrackedFiles: string[] = [];

  for (const line of lines) {
    const status = line.substring(0, 2);
    const file = line.substring(3);
    if (status.includes("?")) {
      untrackedFiles.push(file);
    } else {
      modifiedFiles.push(file);
    }
  }

  return {
    ahead,
    behind,
    hasUncommittedChanges: modifiedFiles.length > 0 || untrackedFiles.length > 0,
    modifiedFiles,
    untrackedFiles,
  };
}

/**
 * Commit all changes in a worktree
 */
export async function commitWorktreeChanges(
  worktreePath: string,
  message: string,
  author: string
): Promise<{ success: boolean; commitHash?: string; error?: string }> {
  try {
    // Stage all changes
    await exec("git add -A", { cwd: worktreePath });

    // Check if there's anything to commit
    const { stdout: statusOutput } = await exec("git status --porcelain", { cwd: worktreePath });
    if (!statusOutput.trim()) {
      return { success: true }; // Nothing to commit
    }

    // Commit
    const fullMessage = `${message}\n\nImplementer: ${author}`;
    await exec(`git commit -m "${fullMessage.replace(/"/g, '\\"')}"`, { cwd: worktreePath });

    // Get the commit hash
    const { stdout: hashOutput } = await exec("git rev-parse HEAD", { cwd: worktreePath });
    return { success: true, commitHash: hashOutput.trim() };
  } catch (error) {
    const err = error as Error;
    return { success: false, error: err.message };
  }
}

/**
 * Attempt to merge a worktree's changes back to main
 */
export async function mergeWorktree(
  worktreePath: string,
  targetBranch?: string
): Promise<MergeResult> {
  try {
    // Get the git root
    const { stdout: gitDirOutput } = await exec("git rev-parse --git-common-dir", { cwd: worktreePath });
    const gitCommonDir = gitDirOutput.trim();
    const mainRepoPath = path.dirname(gitCommonDir);

    // Get the worktree branch
    const { stdout: branchOutput } = await exec("git rev-parse --abbrev-ref HEAD", { cwd: worktreePath });
    const worktreeBranch = branchOutput.trim();

    // Determine target branch
    if (!targetBranch) {
      try {
        const { stdout } = await exec("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo 'refs/remotes/origin/main'", { cwd: mainRepoPath });
        targetBranch = stdout.trim().replace("refs/remotes/origin/", "");
      } catch {
        targetBranch = "main";
      }
    }

    // Commit any uncommitted changes first
    const status = await getWorktreeStatus(worktreePath);
    if (status.hasUncommittedChanges) {
      await commitWorktreeChanges(worktreePath, "WIP: Uncommitted changes before merge", "lockstep");
    }

    // Check if there's anything to merge
    const { stdout: diffOutput } = await exec(`git diff ${targetBranch}..${worktreeBranch} --stat`, { cwd: mainRepoPath });
    if (!diffOutput.trim()) {
      return { success: true, merged: false }; // Nothing to merge
    }

    // Try to rebase onto target branch first (cleaner history)
    try {
      await exec(`git -C "${worktreePath}" rebase origin/${targetBranch}`, { cwd: mainRepoPath });
    } catch {
      // Rebase failed, abort it
      try {
        await exec(`git -C "${worktreePath}" rebase --abort`, { cwd: mainRepoPath });
      } catch {
        // Ignore
      }
    }

    // Switch to target branch and merge
    const currentBranch = await getCurrentBranch(mainRepoPath);
    try {
      await exec(`git checkout ${targetBranch}`, { cwd: mainRepoPath });
      await exec(`git merge --no-ff ${worktreeBranch} -m "Merge ${worktreeBranch}"`, { cwd: mainRepoPath });
      return { success: true, merged: true };
    } catch (error) {
      // Merge conflict - get the conflicting files
      const { stdout: conflictOutput } = await exec("git diff --name-only --diff-filter=U", { cwd: mainRepoPath });
      const conflicts = conflictOutput.trim().split("\n").filter(Boolean);

      // Abort the merge
      await exec("git merge --abort", { cwd: mainRepoPath });

      // Switch back to original branch
      await exec(`git checkout ${currentBranch}`, { cwd: mainRepoPath });

      return { success: false, merged: false, conflicts };
    }
  } catch (error) {
    const err = error as Error;
    return { success: false, merged: false, error: err.message };
  }
}

/**
 * List all lockstep worktrees
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  try {
    const gitRoot = await getGitRoot(repoPath);
    const { stdout } = await exec("git worktree list --porcelain", { cwd: gitRoot });

    const worktrees: WorktreeInfo[] = [];
    const lines = stdout.trim().split("\n");

    let current: Partial<WorktreeInfo> = {};
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        current.path = line.substring(9);
      } else if (line.startsWith("HEAD ")) {
        current.head = line.substring(5);
      } else if (line.startsWith("branch ")) {
        current.branchName = line.substring(7).replace("refs/heads/", "");
      } else if (line === "") {
        if (current.path && current.branchName?.startsWith("lockstep/")) {
          worktrees.push(current as WorktreeInfo);
        }
        current = {};
      }
    }

    // Don't forget the last one
    if (current.path && current.branchName?.startsWith("lockstep/")) {
      worktrees.push(current as WorktreeInfo);
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Clean up orphaned worktrees (those without matching implementers)
 */
export async function cleanupOrphanedWorktrees(repoPath: string): Promise<string[]> {
  const cleaned: string[] = [];
  try {
    const gitRoot = await getGitRoot(repoPath);

    // Prune stale worktree references
    await exec("git worktree prune", { cwd: gitRoot });

    // Get remaining worktrees
    const worktrees = await listWorktrees(repoPath);

    // Check which directories still exist
    for (const wt of worktrees) {
      try {
        await fs.access(wt.path);
      } catch {
        // Directory doesn't exist, clean up the reference
        try {
          await exec(`git worktree remove --force "${wt.path}"`, { cwd: gitRoot });
          cleaned.push(wt.path);
        } catch {
          // Ignore errors
        }
      }
    }

    // Also clean up the lockstep branches that don't have worktrees
    const { stdout: branchOutput } = await exec("git branch --list 'lockstep/*'", { cwd: gitRoot });
    const branches = branchOutput.trim().split("\n").filter(Boolean).map(b => b.trim().replace("* ", ""));

    for (const branch of branches) {
      const hasWorktree = worktrees.some(wt => wt.branchName === branch);
      if (!hasWorktree) {
        try {
          await exec(`git branch -D "${branch}"`, { cwd: gitRoot });
        } catch {
          // Ignore errors
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return cleaned;
}

/**
 * Get diff between worktree and main branch
 */
export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  try {
    // Get the main branch
    let mainBranch = "main";
    try {
      const { stdout } = await exec("git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo 'refs/remotes/origin/main'", { cwd: worktreePath });
      mainBranch = stdout.trim().replace("refs/remotes/origin/", "");
    } catch {
      // Default to main
    }

    const { stdout } = await exec(`git diff origin/${mainBranch}...HEAD --stat`, { cwd: worktreePath });
    return stdout;
  } catch {
    return "";
  }
}

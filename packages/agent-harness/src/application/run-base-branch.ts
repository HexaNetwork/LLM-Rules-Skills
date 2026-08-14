import type { HarnessConfig } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import { GitService } from "../git.js";

export type BranchInspector = Pick<GitService, "listLocalBranches" | "currentBranch">;

/**
 * Resolve the base branch for a new run without assuming that repositories use
 * `main`. Explicit input wins, followed by a valid configured default, followed
 * by the currently checked-out local branch.
 */
export async function resolveRunBaseBranch(
  config: HarnessConfig,
  requested?: string,
  git: BranchInspector = new GitService(config),
): Promise<string> {
  const explicit = requested?.trim();
  if (!config.git.enabled) {
    if (explicit) {
      throw new HarnessFailure(
        "baseBranch cannot be set when git is disabled",
        "config",
        false,
      );
    }
    return config.git.baseBranch;
  }

  const branches = await git.listLocalBranches();
  if (explicit) {
    if (!branches.includes(explicit)) {
      throw new HarnessFailure(`Unknown local branch: ${explicit}`, "config", false);
    }
    return explicit;
  }

  const configured = config.git.baseBranch.trim();
  if (configured && branches.includes(configured)) return configured;

  const current = await git.currentBranch();
  if (current && branches.includes(current)) return current;

  if (branches.length === 1) return branches[0]!;

  throw new HarnessFailure(
    `Configured base branch ${configured || "<empty>"} does not exist locally. ` +
      "Select a base branch explicitly or update git.baseBranch.",
    "config",
    false,
  );
}

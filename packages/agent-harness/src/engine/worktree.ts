import path from "node:path";
import { ensureDir, pathExists } from "../util/fs.js";
import { gitOk, revParse } from "../util/git.js";

export type WorktreeHandle = {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
  headSha: string;
};

export async function createRunWorktree(input: {
  repoRoot: string;
  runDirectory: string;
  runId: string;
  baseBranch: string;
  branchPrefix: string;
}): Promise<WorktreeHandle> {
  const repoRoot = path.resolve(input.repoRoot);
  const worktreePath = path.join(input.runDirectory, input.runId, "worktree");
  const branchName = `${input.branchPrefix}/${input.runId}`;
  await ensureDir(path.dirname(worktreePath));

  await gitOk(repoRoot, ["fetch", "origin", input.baseBranch]).catch(() => undefined);
  const baseRef = await revParse(repoRoot, input.baseBranch).catch(async () =>
    revParse(repoRoot, `origin/${input.baseBranch}`),
  );

  if (await pathExists(worktreePath)) {
    const headSha = await revParse(worktreePath, "HEAD");
    return { repoRoot, worktreePath, branchName, baseRef, headSha };
  }

  const existing = await gitOk(repoRoot, [
    "show-ref",
    "--verify",
    `--quiet`,
    `refs/heads/${branchName}`,
  ]).then(() => true).catch(() => false);

  if (!existing) {
    await gitOk(repoRoot, ["branch", branchName, baseRef]);
  }

  await gitOk(repoRoot, ["worktree", "add", worktreePath, branchName]);
  const headSha = await revParse(worktreePath, "HEAD");
  return { repoRoot, worktreePath, branchName, baseRef, headSha };
}

export async function removeRunWorktree(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  if (!(await pathExists(worktreePath))) return;
  await gitOk(repoRoot, ["worktree", "remove", "--force", worktreePath]).catch(
    async () => {
      await gitOk(repoRoot, ["worktree", "prune"]);
    },
  );
}

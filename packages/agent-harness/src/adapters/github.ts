import {
  ManifestTaskSchema,
  type ManifestTask,
  type SourceDocument,
} from "../schemas/manifest.js";
import type { GitHubLifecycle } from "../schemas/config.js";
import type { GitHubIssue, GitHubPort } from "../agents/ports.js";
import { sha256Text } from "../util/hash.js";
import type { NormalizedSource } from "./local.js";

function parseAcceptance(body: string): Array<{ id: string; text: string }> {
  const lines = body.split(/\r?\n/);
  const criteria: Array<{ id: string; text: string }> = [];
  let inSection = false;
  let index = 1;
  for (const line of lines) {
    if (/^##\s+Acceptance criteria/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const match = line.match(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?(.+)$/);
    if (match?.[1]) {
      criteria.push({ id: `ac-${index}`, text: match[1].trim() });
      index += 1;
    }
  }
  return criteria;
}

function parseBlockedBy(body: string): number[] {
  const lines = body.split(/\r?\n/);
  const refs: number[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Blocked by/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    for (const match of line.matchAll(/#(\d+)/g)) {
      refs.push(Number(match[1]));
    }
  }
  return refs;
}

function isAfk(issue: GitHubIssue, lifecycle: GitHubLifecycle): boolean {
  const labels = issue.labels.map((label) => label.toLowerCase());
  if (labels.includes(lifecycle.hitlLabel.toLowerCase())) return false;
  if (labels.includes(lifecycle.afkLabel.toLowerCase())) return true;
  // Default AFK when no HITL label is present; prepare validation still enforces completeness.
  return true;
}

function toTask(
  issue: GitHubIssue,
  lifecycle: GitHubLifecycle,
  numberToId: Map<number, string>,
): ManifestTask {
  const acceptance = parseAcceptance(issue.body);
  const blockedByNumbers = parseBlockedBy(issue.body);
  return ManifestTaskSchema.parse({
    id: `gh-${issue.number}`,
    title: issue.title,
    mode: isAfk(issue, lifecycle) ? "AFK" : "HITL",
    sourceRef: issue.htmlUrl,
    body: issue.body,
    acceptanceCriteria:
      acceptance.length > 0
        ? acceptance
        : [{ id: "ac-1", text: "Implement the issue acceptance criteria as written." }],
    blockedBy: blockedByNumbers
      .map((num) => numberToId.get(num))
      .filter((id): id is string => Boolean(id)),
    allowedGlobs: ["**/*"],
    testSeams: [],
    browserProbes: [],
  });
}

export async function loadGitHubSource(input: {
  port: GitHubPort;
  lifecycle: GitHubLifecycle;
  entryIssueNumber: number;
}): Promise<NormalizedSource> {
  const { port, lifecycle, entryIssueNumber } = input;
  const root = await port.getIssue(
    lifecycle.owner,
    lifecycle.repo,
    entryIssueNumber,
  );
  const children = await port.listSubIssues(
    lifecycle.owner,
    lifecycle.repo,
    entryIssueNumber,
  );

  let leafIssues: GitHubIssue[] = [];
  if (children.length === 0) {
    leafIssues = [root];
  } else {
    for (const child of children) {
      const grand = await port.listSubIssues(
        lifecycle.owner,
        lifecycle.repo,
        child.number,
      );
      if (grand.length === 0) {
        leafIssues.push(child);
      } else {
        leafIssues.push(...grand);
      }
    }
  }

  const numberToId = new Map(
    leafIssues.map((issue) => [issue.number, `gh-${issue.number}`] as const),
  );
  const tasks = leafIssues.map((issue) =>
    toTask(issue, lifecycle, numberToId),
  );

  const payload = JSON.stringify({
    root: root.number,
    tasks: leafIssues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      labels: issue.labels,
    })),
  });

  return {
    source: {
      kind: "github",
      location: `${lifecycle.owner}/${lifecycle.repo}#${entryIssueNumber}`,
      contentHash: sha256Text(payload),
      fetchedAt: new Date().toISOString(),
    },
    tasks,
  };
}

export function createGitHubApiPort(token = process.env.GITHUB_TOKEN): GitHubPort {
  if (!token) {
    throw new Error("GITHUB_TOKEN is required for GitHub adapters");
  }

  async function gh<T>(
    urlPath: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`https://api.github.com${urlPath}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${urlPath} failed: ${response.status} ${text}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    async getIssue(owner, repo, number) {
      const issue = await gh<{
        number: number;
        id: number;
        title: string;
        body: string | null;
        labels: Array<{ name: string }>;
        state: string;
        html_url: string;
      }>(`/repos/${owner}/${repo}/issues/${number}`);
      return {
        number: issue.number,
        id: issue.id,
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels.map((label) => label.name),
        state: issue.state,
        htmlUrl: issue.html_url,
      };
    },

    async listSubIssues(owner, repo, number) {
      const items = await gh<
        Array<{
          number: number;
          id: number;
          title: string;
          body: string | null;
          labels: Array<{ name: string }>;
          state: string;
          html_url: string;
        }>
      >(`/repos/${owner}/${repo}/issues/${number}/sub_issues`);
      return items.map((issue) => ({
        number: issue.number,
        id: issue.id,
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels.map((label) => label.name),
        state: issue.state,
        htmlUrl: issue.html_url,
      }));
    },

    async assignIssue(owner, repo, number, login) {
      await gh(`/repos/${owner}/${repo}/issues/${number}/assignees`, {
        method: "POST",
        body: JSON.stringify({ assignees: [login] }),
      });
    },

    async commentIssue(owner, repo, number, body) {
      await gh(`/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async createPullRequest(input) {
      const pr = await gh<{ html_url: string; number: number }>(
        `/repos/${input.owner}/${input.repo}/pulls`,
        {
          method: "POST",
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
          }),
        },
      );
      return { url: pr.html_url, number: pr.number };
    },
  };
}

export function createFakeGitHubPort(
  issues: GitHubIssue[],
): GitHubPort & { createdPrs: Array<{ url: string; number: number }> } {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const createdPrs: Array<{ url: string; number: number }> = [];
  return {
    createdPrs,
    async getIssue(_owner, _repo, number) {
      const issue = byNumber.get(number);
      if (!issue) throw new Error(`Missing issue ${number}`);
      return issue;
    },
    async listSubIssues(_owner, _repo, number) {
      return issues.filter((issue) => issue.parentNumber === number);
    },
    async assignIssue() {},
    async commentIssue() {},
    async setProjectStatus() {},
    async createPullRequest(input) {
      const pr = {
        url: `https://github.com/${input.owner}/${input.repo}/pull/${createdPrs.length + 1}`,
        number: createdPrs.length + 1,
      };
      createdPrs.push(pr);
      return pr;
    },
  };
}

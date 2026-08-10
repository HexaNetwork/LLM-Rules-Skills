import path from "node:path";
import { readdir, realpath } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { writeProjectSettings, type HarnessConfig } from "../../../config.js";
import type { UiAppContext } from "../context.js";
import {
  HttpError,
  json,
  optionalBoolean,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalStringArray,
  readJsonBody,
  requiredRecord,
} from "../request.js";

type IntegerSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "integer";
  minimum: number;
  maximum: number;
};
type BooleanSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "boolean";
};
type EnumSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "enum";
  options: Array<{ value: string; label: string }>;
};
type StringSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "string";
  maximum: number;
};
type StringListSettingDefinition = {
  key: string;
  category: string;
  label: string;
  description: string;
  type: "string-list";
  maximumItems: number;
  maximumItemLength: number;
};
type SettingDefinition =
  | IntegerSettingDefinition
  | BooleanSettingDefinition
  | EnumSettingDefinition
  | StringSettingDefinition
  | StringListSettingDefinition;

export const PREFLIGHT_COMMIT_ORDER_VALUES = ["branch-then-commit", "commit-then-branch"] as const;

export const PROJECT_SETTING_DEFINITIONS: SettingDefinition[] = [
  {
    key: "workflow.maxGrillQuestionsPerEpisode",
    category: "Context & cost",
    label: "Grill questions per episode",
    description:
      "Reuse one provider session for this many Q→A turns before starting a fresh grill context.",
    type: "integer",
    minimum: 1,
    maximum: 50,
  },
  {
    key: "workflow.staleAnswerMinutes",
    category: "Context & cost",
    label: "Stale answer threshold (minutes)",
    description:
      "If a human answer arrives after this many minutes, continue with a fresh agent using only the question and answer.",
    type: "integer",
    minimum: 1,
    maximum: 1440,
  },
  {
    key: "workflow.grillQuestionsPerBatch",
    category: "Context & cost",
    label: "Grill questions per batch",
    description:
      "Ceiling on how many mutually independent questions the griller may ask in one turn. A ceiling, not a target.",
    type: "integer",
    minimum: 1,
    maximum: 6,
  },
  {
    key: "workflow.testPathPatterns",
    category: "Testing",
    label: "Test file path patterns",
    description:
      "One repository-relative glob per line. The test writer may only edit files matching these patterns.",
    type: "string-list",
    maximumItems: 500,
    maximumItemLength: 1_000,
  },
  {
    key: "commands.test",
    category: "Testing",
    label: "Default test command",
    description:
      "Repository-owned command used when a task has no narrower test command. Configure this for your test runner.",
    type: "string",
    maximum: 10_000,
  },
  {
    key: "git.autoCommitPreflight",
    category: "Git",
    label: "Auto-commit a dirty tree before a run",
    description:
      "When on, start() commits a dirty working tree itself instead of blocking. Off by default; the blocked-run card always offers this as an explicit action either way.",
    type: "boolean",
  },
  {
    key: "git.preflightCommitOrder",
    category: "Git",
    label: "Preflight commit order",
    description:
      "Whether a preflight commit lands on the run branch (cut from current HEAD, not baseBranch) or on the current branch before the run branch is created normally.",
    type: "enum",
    options: [
      { value: "branch-then-commit", label: "Commit onto the run branch" },
      { value: "commit-then-branch", label: "Commit onto the current branch" },
    ],
  },
];

export function projectSettings(config: HarnessConfig, configPath?: string): Record<string, unknown> {
  return {
    editable: configPath != null,
    appliesTo: "new_runs",
    definitions: PROJECT_SETTING_DEFINITIONS,
    values: {
      "workflow.maxGrillQuestionsPerEpisode": config.workflow.maxGrillQuestionsPerEpisode,
      "workflow.staleAnswerMinutes": config.workflow.staleAnswerMinutes,
      "workflow.grillQuestionsPerBatch": config.workflow.grillQuestionsPerBatch,
      "workflow.testPathPatterns": config.workflow.testPathPatterns,
      "commands.test": config.commands.test,
      "git.autoCommitPreflight": config.git.autoCommitPreflight,
      "git.preflightCommitOrder": config.git.preflightCommitOrder,
      "git.ignoredArtifactPatterns": config.git.ignoredArtifactPatterns,
    },
  };
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Path escapes the repository");
  }
}

/**
 * Lists direct, non-symlinked repository folders for configuration pickers.
 * The dashboard must never turn a path picker into a general filesystem browser.
 */
export async function listRepositoryFolders(
  repositoryRoot: string,
  requestedPath: string,
): Promise<{ path: string; parent?: string; folders: string[] }> {
  if (requestedPath.length > 2_000) throw new HttpError(400, "Folder path is too long");
  const target = path.resolve(repositoryRoot, requestedPath);
  assertInside(repositoryRoot, target);

  let rootReal: string;
  let targetReal: string;
  try {
    [rootReal, targetReal] = await Promise.all([realpath(repositoryRoot), realpath(target)]);
  } catch {
    throw new HttpError(404, "Repository folder was not found");
  }
  assertInside(rootReal, targetReal);

  let entries;
  try {
    entries = await readdir(targetReal, { withFileTypes: true });
  } catch {
    throw new HttpError(400, "Path is not a readable folder");
  }
  const relative = path.relative(rootReal, targetReal).replaceAll("\\", "/");
  const folders = entries
    .filter((entry) => entry.isDirectory() && ![".git", ".agent-harness", "node_modules"].includes(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const parent = relative ? path.dirname(relative).replaceAll("\\", "/") : undefined;
  return {
    path: relative === "." ? "" : relative,
    ...(parent != null ? { parent: parent === "." ? "" : parent } : {}),
    folders,
  };
}

/** @returns true when the request was handled. */
export async function handleSettingsRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: UiAppContext,
): Promise<boolean> {
  const projectConfig = ctx.getProjectConfig();

  if (request.method === "GET" && url.pathname === "/api/settings") {
    json(response, 200, { settings: projectSettings(projectConfig, ctx.configPath) });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/repository/folders") {
    const requestedPath = url.searchParams.get("path") ?? "";
    const folders = await listRepositoryFolders(projectConfig.repositoryRoot, requestedPath);
    json(response, 200, folders);
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings") {
    if (!ctx.configPath) {
      throw new HttpError(409, "This dashboard was started without a writable config path");
    }
    const body = await readJsonBody(request);
    const values = requiredRecord(body.values, "values");
    const known = new Set<string>([
      ...PROJECT_SETTING_DEFINITIONS.map((setting) => setting.key),
      "git.ignoredArtifactPatterns",
    ]);
    const unknown = Object.keys(values).filter((key) => !known.has(key));
    if (unknown.length) throw new HttpError(400, `Unknown setting: ${unknown.join(", ")}`);
    const maxGrillQuestionsPerEpisode = optionalInteger(
      values["workflow.maxGrillQuestionsPerEpisode"],
      "workflow.maxGrillQuestionsPerEpisode",
      1,
      50,
    );
    const staleAnswerMinutes = optionalInteger(
      values["workflow.staleAnswerMinutes"],
      "workflow.staleAnswerMinutes",
      1,
      1440,
    );
    const grillQuestionsPerBatch = optionalInteger(
      values["workflow.grillQuestionsPerBatch"],
      "workflow.grillQuestionsPerBatch",
      1,
      6,
    );
    const autoCommitPreflight = optionalBoolean(
      values["git.autoCommitPreflight"],
      "git.autoCommitPreflight",
    );
    const preflightCommitOrder = optionalEnum(
      values["git.preflightCommitOrder"],
      "git.preflightCommitOrder",
      PREFLIGHT_COMMIT_ORDER_VALUES,
    );
    const ignoredArtifactPatterns = optionalStringArray(
      values["git.ignoredArtifactPatterns"],
      "git.ignoredArtifactPatterns",
      500,
    );
    const testPathPatterns = optionalStringArray(
      values["workflow.testPathPatterns"],
      "workflow.testPathPatterns",
      500,
    );
    const testCommand = optionalString(values["commands.test"], "commands.test", 10_000);
    if (maxGrillQuestionsPerEpisode == null) {
      throw new HttpError(400, "workflow.maxGrillQuestionsPerEpisode is required");
    }
    if (staleAnswerMinutes == null) {
      throw new HttpError(400, "workflow.staleAnswerMinutes is required");
    }
    const updated = await writeProjectSettings(ctx.configPath, {
      workflow: {
        maxGrillQuestionsPerEpisode,
        staleAnswerMinutes,
        ...(grillQuestionsPerBatch != null ? { grillQuestionsPerBatch } : {}),
        ...(testPathPatterns != null ? { testPathPatterns } : {}),
      },
      ...(testCommand != null ? { commands: { test: testCommand } } : {}),
      ...(autoCommitPreflight != null ||
      preflightCommitOrder != null ||
      ignoredArtifactPatterns != null
        ? {
            git: {
              ...(autoCommitPreflight != null ? { autoCommitPreflight } : {}),
              ...(preflightCommitOrder != null ? { preflightCommitOrder } : {}),
              ...(ignoredArtifactPatterns != null ? { ignoredArtifactPatterns } : {}),
            },
          }
        : {}),
    });
    ctx.setProjectConfig(updated.config);
    json(response, 200, {
      settings: projectSettings(updated.config, ctx.configPath),
      appliesTo: "new_runs",
    });
    return true;
  }

  return false;
}

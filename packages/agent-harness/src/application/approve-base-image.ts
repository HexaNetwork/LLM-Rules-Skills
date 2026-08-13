import path from "node:path";
import type { DockerClient } from "../infrastructure/container/types.js";
import { assertDockerReadiness } from "../infrastructure/container/docker-readiness.js";
import { writeProjectSettings } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";
import { HarnessFailure } from "../errors.js";
import { resolveHarnessHome, type HarnessHomePaths } from "./harness-home.js";
import {
  collectExecutionImageEvidence,
  type ExecutionImageStackId,
} from "./execution-image-evidence.js";
import {
  isDigestPinnedImageRef,
  KNOWN_STACK_BASE_FAMILIES,
  resolveApprovedBaseImage,
} from "./execution-image-generator.js";
import { digestPinnedFromInspect } from "./prepare-worker-image.js";

export type ApproveStackBaseImageOptions = {
  docker: DockerClient;
  /** Optional; used only to auto-detect stack when `stack` is omitted. */
  repositoryRoot?: string;
  /** Existing allowlist to merge into (duplicates by family are replaced). */
  existingApprovedBaseImages?: readonly string[];
  /** Override pull/ref; default is the known family for the stack. */
  image?: string;
  /** Stack to approve. Required when repositoryRoot is omitted or ambiguous. */
  stack?: ExecutionImageStackId;
  /** Skip pull when the image is already local (still inspect + pin). Default true. */
  reuseLocal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ApprovedStackBase = {
  stack: ExecutionImageStackId;
  family: string;
  baseImageDigest: string;
  source: "pulled" | "reused";
};

export type ApproveStackBaseImageResult = ApprovedStackBase & {
  approvedBaseImages: string[];
};

export type ApproveKnownStackBaseImagesOptions = {
  docker: DockerClient;
  existingApprovedBaseImages?: readonly string[];
  /** Subset of stacks; default is every entry in KNOWN_STACK_BASE_FAMILIES. */
  stacks?: readonly ExecutionImageStackId[];
  reuseLocal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ApproveKnownStackBaseImagesResult = {
  bases: ApprovedStackBase[];
  approvedBaseImages: string[];
};

/**
 * Pull (or reuse) one known toolchain base and return a digest-pinned ref for
 * the shared `execution.docker.approvedBaseImages` catalog.
 */
export async function approveStackBaseImage(
  options: ApproveStackBaseImageOptions,
): Promise<ApproveStackBaseImageResult> {
  await assertDockerReadiness(options.docker);

  const stack = await resolveStack(options);
  const family = KNOWN_STACK_BASE_FAMILIES[stack];
  const approved = await pinFamilyBaseImage({
    docker: options.docker,
    family,
    stack,
    image: options.image,
    reuseLocal: options.reuseLocal,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  return {
    ...approved,
    approvedBaseImages: mergeApprovedBaseImages(
      options.existingApprovedBaseImages ?? [],
      family,
      approved.baseImageDigest,
    ),
  };
}

/**
 * Pin every known stack family into one project-agnostic allowlist.
 * Intended for harness-home defaults so any registered project can generate images.
 */
export async function approveKnownStackBaseImages(
  options: ApproveKnownStackBaseImagesOptions,
): Promise<ApproveKnownStackBaseImagesResult> {
  await assertDockerReadiness(options.docker);

  const stacks =
    options.stacks && options.stacks.length > 0
      ? options.stacks
      : (Object.keys(KNOWN_STACK_BASE_FAMILIES) as ExecutionImageStackId[]);

  let approvedBaseImages = [...(options.existingApprovedBaseImages ?? [])];
  const bases: ApprovedStackBase[] = [];

  for (const stack of stacks) {
    const family = KNOWN_STACK_BASE_FAMILIES[stack];
    const approved = await pinFamilyBaseImage({
      docker: options.docker,
      family,
      stack,
      reuseLocal: options.reuseLocal,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    bases.push(approved);
    approvedBaseImages = mergeApprovedBaseImages(
      approvedBaseImages,
      family,
      approved.baseImageDigest,
    );
  }

  return { bases, approvedBaseImages };
}

async function resolveStack(
  options: ApproveStackBaseImageOptions,
): Promise<ExecutionImageStackId> {
  if (options.stack) {
    if (!(options.stack in KNOWN_STACK_BASE_FAMILIES)) {
      throw new HarnessFailure(
        `Stack ${options.stack} has no known base image family.`,
        "execution",
        false,
      );
    }
    return options.stack;
  }

  if (!options.repositoryRoot?.trim()) {
    throw new HarnessFailure(
      "Pass --stack <id>, or --all for the shared catalog, or --repository to detect a single project stack.",
      "execution",
      false,
    );
  }

  const evidence = await collectExecutionImageEvidence(options.repositoryRoot);
  const stack = evidence.stacks.length === 1 ? evidence.stacks[0] : undefined;
  if (!stack) {
    throw new HarnessFailure(
      `Cannot approve a base image: project stack is ambiguous (${evidence.stacks.join(", ") || "none"}). Pass --stack, or use --all for the shared catalog.`,
      "execution",
      false,
    );
  }
  return stack;
}

async function pinFamilyBaseImage(input: {
  docker: DockerClient;
  family: string;
  stack: ExecutionImageStackId;
  image?: string;
  reuseLocal?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ApprovedStackBase> {
  const pullRef = (input.image?.trim() || input.family).trim();
  if (!pullRef) {
    throw new HarnessFailure("Base image reference is empty.", "execution", false);
  }

  let source: "pulled" | "reused" = "reused";
  const exists = await input.docker.imageExists(pullRef);
  if (!exists || input.reuseLocal === false) {
    const pulled = await input.docker.exec(["pull", pullRef], {
      timeoutMs: input.timeoutMs ?? 1_200_000,
      signal: input.signal,
    });
    if (pulled.exitCode !== 0) {
      throw new HarnessFailure(
        `Failed to pull base image ${pullRef}: ${pulled.stderr || pulled.stdout}`,
        "execution",
        true,
      );
    }
    source = "pulled";
  }

  const inspected = await input.docker.inspectImage(pullRef);
  if (!inspected) {
    throw new HarnessFailure(
      `Base image ${pullRef} could not be inspected after pull/reuse.`,
      "execution",
      true,
    );
  }

  const nameTag = isDigestPinnedImageRef(pullRef)
    ? pullRef.slice(0, pullRef.indexOf("@"))
    : pullRef;
  const baseImageDigest = isDigestPinnedImageRef(pullRef)
    ? pullRef
    : digestPinnedFromInspect(nameTag, inspected);

  if (!isDigestPinnedImageRef(baseImageDigest)) {
    throw new HarnessFailure(
      `Constructed base image ref is not digest-pinned: ${baseImageDigest}`,
      "execution",
      false,
    );
  }

  return {
    stack: input.stack,
    family: input.family,
    baseImageDigest,
    source,
  };
}

/** Replace any prior allowlist entry for the same family; append otherwise. */
export function mergeApprovedBaseImages(
  existing: readonly string[],
  family: string,
  pinned: string,
): string[] {
  const withoutFamily = existing.filter(
    (image) => resolveApprovedBaseImage(family, [image]) === undefined,
  );
  return [...withoutFamily, pinned];
}

/**
 * Union home + project allowlists. Project entries win when they cover the same family.
 * Used so a shared harness-home catalog stays project-agnostic while projects can add overrides.
 */
export function mergeApprovedBaseImageLists(
  homeImages: readonly string[],
  projectImages: readonly string[] | undefined,
): string[] {
  if (projectImages === undefined) return [...homeImages];
  let merged = [...homeImages];
  for (const image of projectImages) {
    const family =
      Object.values(KNOWN_STACK_BASE_FAMILIES).find(
        (candidate) => resolveApprovedBaseImage(candidate, [image]) !== undefined,
      ) ?? image.split("@")[0] ?? image;
    merged = mergeApprovedBaseImages(merged, family, image);
  }
  return merged;
}

export type WriteApprovedBaseImagesSettingsOptions = {
  configPath: string;
  approvedBaseImages: readonly string[];
};

/** Persist the full approvedBaseImages list via the settings write path (home or project). */
export async function writeApprovedBaseImagesSettings(
  options: WriteApprovedBaseImagesSettingsOptions,
): Promise<{ config: HarnessConfig; path: string }> {
  for (const image of options.approvedBaseImages) {
    if (!isDigestPinnedImageRef(image)) {
      throw new HarnessFailure(
        `Refusing to write non-digest-pinned base image: ${image}`,
        "execution",
        false,
      );
    }
  }
  return writeProjectSettings(options.configPath, {
    execution: {
      docker: {
        approvedBaseImages: [...options.approvedBaseImages],
      },
    },
  });
}

/** @deprecated Prefer writeApprovedBaseImagesSettings — writes are usually harness-home scoped. */
export const writeApprovedBaseImagesProjectSettings = writeApprovedBaseImagesSettings;

export function harnessHomeConfigPath(home?: HarnessHomePaths): string {
  const resolved = home ?? resolveHarnessHome();
  return path.join(resolved.homeRoot, "config.yaml");
}

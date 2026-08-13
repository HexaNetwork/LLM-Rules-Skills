import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessFailure } from "../errors.js";
import {
  assertDockerReadiness,
  createDockerClient,
  type DockerClient,
  type DockerImageInspect,
  type DockerReadinessReport,
} from "../infrastructure/container/index.js";
import { isDigestPinnedImageRef } from "./execution-image-generator.js";
import { writeProjectSettings } from "../config/io.js";
import type { HarnessConfig } from "../config/schema.js";

/** Default local tag for a freshly built maintained worker image. */
export const DEFAULT_WORKER_IMAGE_TAG = "agent-harness-worker:local";

export type PrepareMaintainedWorkerImageResult = {
  workerImageDigest: string;
  source: "pulled" | "built" | "reused";
  tag: string;
  readiness: DockerReadinessReport;
  imageId?: string;
};

export type PrepareMaintainedWorkerImageOptions = {
  docker?: DockerClient;
  /**
   * Package root containing `docker/worker/Dockerfile`, `dist/`, and `node_modules/`.
   * Defaults to the installed `@hexanetwork/agent-harness` package root.
   */
  packageRoot?: string;
  /**
   * When set, pull/reuse this image instead of building from the package Dockerfile.
   * Prefer a digest-pinned ref (`name@sha256:…`).
   */
  pullImage?: string;
  /** Local tag for builds (also used as the left-hand side of the digest pin). */
  tag?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When true, skip docker build if the tag already exists locally. */
  reuseLocalTag?: boolean;
};

/**
 * Probe Docker readiness, then pull or build the maintained worker image.
 * Returns a digest-pinned reference suitable for `execution.docker.workerImageDigest`.
 * Fail-closed: unhealthy Docker or missing digests throw HarnessFailure(kind=execution).
 */
export async function prepareMaintainedWorkerImage(
  options: PrepareMaintainedWorkerImageOptions = {},
): Promise<PrepareMaintainedWorkerImageResult> {
  const docker = options.docker ?? createDockerClient();
  const tag = (options.tag?.trim() || DEFAULT_WORKER_IMAGE_TAG).toLowerCase();
  const readiness = await assertDockerReadiness(docker);

  const pullImage = options.pullImage?.trim();
  if (pullImage) {
    const exists = await docker.imageExists(pullImage);
    if (!exists) {
      const pulled = await docker.exec(["pull", pullImage], {
        timeoutMs: options.timeoutMs ?? 1_200_000,
        signal: options.signal,
      });
      if (pulled.exitCode !== 0) {
        throw new HarnessFailure(
          `Failed to pull worker image ${pullImage}: ${pulled.stderr || pulled.stdout}`,
          "execution",
          true,
        );
      }
    }
    const pinned = await resolveDigestPinnedRef(docker, pullImage, tag);
    return {
      workerImageDigest: pinned.ref,
      source: exists ? "reused" : "pulled",
      tag: pinned.nameTag,
      readiness,
      imageId: pinned.id,
    };
  }

  if (options.reuseLocalTag !== false) {
    const existing = await docker.inspectImage(tag);
    if (existing) {
      const pinned = digestPinnedFromInspect(tag, existing);
      return {
        workerImageDigest: pinned,
        source: "reused",
        tag,
        readiness,
        imageId: existing.id,
      };
    }
  }

  const packageRoot = path.resolve(options.packageRoot ?? defaultPackageRoot());
  const dockerfilePath = path.join(packageRoot, "docker", "worker", "Dockerfile");
  const distCli = path.join(packageRoot, "dist", "cli.js");
  await assertReadable(dockerfilePath, "Worker Dockerfile");
  await assertReadable(distCli, "Built CLI (run npm run build in packages/agent-harness)");

  const built = await docker.build({
    contextDir: packageRoot,
    dockerfilePath,
    tag,
    timeoutMs: options.timeoutMs ?? 1_200_000,
    signal: options.signal,
  });
  if (built.exitCode !== 0) {
    throw new HarnessFailure(
      `Worker image build failed (exit ${built.exitCode}): ${built.stderr || built.stdout}`,
      "execution",
      true,
    );
  }

  const pinned = await resolveDigestPinnedRef(docker, tag, tag);
  return {
    workerImageDigest: pinned.ref,
    source: "built",
    tag: pinned.nameTag,
    readiness,
    imageId: pinned.id,
  };
}

export type WriteWorkerImageSettingsOptions = {
  configPath: string;
  workerImageDigest: string;
  /** When true, also set execution.runtime to docker. Default false (local stays default). */
  enableDockerRuntime?: boolean;
};

/** Persist worker digest (and optionally docker runtime) via the project settings write path. */
export async function writeWorkerImageProjectSettings(
  options: WriteWorkerImageSettingsOptions,
): Promise<{ config: HarnessConfig; path: string }> {
  if (!isDigestPinnedImageRef(options.workerImageDigest)) {
    throw new HarnessFailure(
      `Refusing to write non-digest-pinned worker image: ${options.workerImageDigest}`,
      "execution",
      false,
    );
  }
  return writeProjectSettings(options.configPath, {
    execution: {
      ...(options.enableDockerRuntime ? { runtime: "docker" as const } : {}),
      docker: {
        workerImageDigest: options.workerImageDigest,
      },
    },
  });
}

export function defaultPackageRoot(): string {
  // dist/application/prepare-worker-image.js → package root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function digestPinnedFromInspect(
  nameTag: string,
  inspected: DockerImageInspect,
): string {
  const left = nameTag.includes("@") ? nameTag.slice(0, nameTag.indexOf("@")) : nameTag;
  const raw =
    inspected.digest?.trim() ||
    (inspected.id.startsWith("sha256:") ? inspected.id : undefined) ||
    (inspected.id.match(/^[a-f0-9]{64}$/i) ? `sha256:${inspected.id}` : undefined);
  if (!raw) {
    throw new HarnessFailure(
      `Could not resolve a content digest for image ${nameTag}.`,
      "execution",
      true,
    );
  }
  const digest = raw.startsWith("sha256:") ? raw : `sha256:${raw}`;
  if (!/^sha256:[a-f0-9]{64}$/i.test(digest)) {
    throw new HarnessFailure(
      `Image ${nameTag} digest is not sha256:… (${digest}).`,
      "execution",
      true,
    );
  }
  // Prefer name without tag when the left side already looks like a digest-pinned pull ref name.
  const ref = `${left}@${digest}`;
  if (!isDigestPinnedImageRef(ref)) {
    throw new HarnessFailure(
      `Constructed worker ref is not digest-pinned: ${ref}`,
      "execution",
      false,
    );
  }
  return ref;
}

async function resolveDigestPinnedRef(
  docker: DockerClient,
  reference: string,
  fallbackNameTag: string,
): Promise<{ ref: string; nameTag: string; id?: string }> {
  if (isDigestPinnedImageRef(reference)) {
    const inspected = await docker.inspectImage(reference);
    if (!inspected) {
      throw new HarnessFailure(
        `Worker image ${reference} is not present after pull/reuse.`,
        "execution",
        true,
      );
    }
    return { ref: reference, nameTag: reference.slice(0, reference.indexOf("@")), id: inspected.id };
  }
  const inspected = await docker.inspectImage(reference);
  if (!inspected) {
    throw new HarnessFailure(
      `Worker image ${reference} could not be inspected after prepare.`,
      "execution",
      true,
    );
  }
  const nameTag = reference.includes(":") ? reference : fallbackNameTag;
  return {
    ref: digestPinnedFromInspect(nameTag, inspected),
    nameTag,
    id: inspected.id,
  };
}

async function assertReadable(filePath: string, label: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new HarnessFailure(
      `${label} missing at ${filePath}.`,
      "execution",
      false,
    );
  }
}

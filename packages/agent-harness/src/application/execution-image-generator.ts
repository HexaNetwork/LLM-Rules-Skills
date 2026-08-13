import { createHash } from "node:crypto";
import type { ExecutionImageEvidence, ExecutionImageStackId } from "./execution-image-evidence.js";
import { canonicalProfileInputs, hashExecutionImageProfile } from "./execution-image-evidence.js";

/** Bump when Dockerfile generation rules change (invalidates caches). */
export const EXECUTION_IMAGE_GENERATOR_VERSION = 1 as const;

/**
 * Allowlist catalog version. Cache keys include this so policy updates
 * invalidate previously built project images.
 */
export const BASE_IMAGE_ALLOWLIST_VERSION = 1 as const;

/** Worker binary path inside the maintained worker image / final image. */
export const WORKER_IMAGE_BINARY_PATH = "/opt/agent-harness/worker" as const;

/**
 * Known stack → digest-pinned-friendly base image family.
 * Exact `name@sha256:…` references must appear in `approvedBaseImages`.
 */
export const KNOWN_STACK_BASE_FAMILIES: Record<ExecutionImageStackId, string> = {
  node: "node:22-bookworm",
  python: "python:3.12-bookworm",
  go: "golang:1.23-bookworm",
  rust: "rust:1.83-bookworm",
  jvm: "eclipse-temurin:21-jdk-jammy",
};

export type GeneratedExecutionImage = {
  stack: ExecutionImageStackId;
  baseImage: string;
  workerImage: string;
  dockerfile: string;
  dockerignore: string;
  dockerfileHash: string;
  profileHash: string;
  generatorVersion: typeof EXECUTION_IMAGE_GENERATOR_VERSION;
  allowlistVersion: typeof BASE_IMAGE_ALLOWLIST_VERSION;
  platform: string;
};

export type ExecutionImageGenerationFailure =
  | { kind: "ambiguous"; stacks: ExecutionImageStackId[]; message: string }
  | { kind: "unsupported"; stacks: ExecutionImageStackId[]; message: string }
  | { kind: "missing-worker"; message: string }
  | { kind: "missing-base"; stack: ExecutionImageStackId; family: string; message: string };

const DIGEST_PINNED =
  /^(?<name>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)(?::(?<tag>[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?@sha256:[a-f0-9]{64}$/i;

/**
 * Resolve an allowlisted base image for a stack family.
 * Prefer exact digest-pinned references whose name:tag (or name) matches the family.
 */
export function resolveApprovedBaseImage(
  family: string,
  approvedBaseImages: readonly string[],
): string | undefined {
  const exact = approvedBaseImages.find((image) => image === family || image.startsWith(`${family}@`));
  if (exact) return exact;
  // Also allow family without tag when allowlist uses name@sha256
  const nameOnly = family.split(":")[0]!;
  return approvedBaseImages.find((image) => {
    const at = image.indexOf("@");
    const left = at >= 0 ? image.slice(0, at) : image;
    return left === family || left === nameOnly || left.startsWith(`${nameOnly}:`);
  });
}

export function isDigestPinnedImageRef(reference: string): boolean {
  return DIGEST_PINNED.test(reference.trim());
}

/**
 * Generate a deterministic multi-stage Dockerfile:
 * copy harness worker from a digest-pinned worker image into an allowlisted
 * digest-pinned project toolchain image. Never copies project source.
 */
export function generateExecutionDockerfile(input: {
  evidence: ExecutionImageEvidence;
  approvedBaseImages: readonly string[];
  workerImage: string;
  platform?: string;
}):
  | { ok: true; image: GeneratedExecutionImage }
  | { ok: false; failure: ExecutionImageGenerationFailure } {
  if (input.evidence.ambiguous || input.evidence.stacks.length !== 1) {
    return {
      ok: false,
      failure: {
        kind: "ambiguous",
        stacks: input.evidence.stacks,
        message:
          input.evidence.stacks.length === 0
            ? "No known project stack manifests found. Add an allowlisted manifest or keep execution.runtime=local."
            : `Ambiguous project stack (${input.evidence.stacks.join(", ")}). Resolve to a single known stack before generating an execution image; MVP never falls back to a host agent.`,
      },
    };
  }

  const stack = input.evidence.stacks[0]!;
  if (!(stack in KNOWN_STACK_BASE_FAMILIES)) {
    return {
      ok: false,
      failure: {
        kind: "unsupported",
        stacks: [stack],
        message: `Stack ${stack} has no deterministic image profile yet.`,
      },
    };
  }

  const workerImage = input.workerImage.trim();
  if (!workerImage) {
    return {
      ok: false,
      failure: {
        kind: "missing-worker",
        message:
          "execution.docker.workerImageDigest is required for Docker mode. Set a digest-pinned worker image reference.",
      },
    };
  }
  if (!isDigestPinnedImageRef(workerImage)) {
    return {
      ok: false,
      failure: {
        kind: "missing-worker",
        message: `Worker image must be digest-pinned (name@sha256:…); got: ${workerImage}`,
      },
    };
  }

  const family = KNOWN_STACK_BASE_FAMILIES[stack];
  const baseImage = resolveApprovedBaseImage(family, input.approvedBaseImages);
  if (!baseImage) {
    return {
      ok: false,
      failure: {
        kind: "missing-base",
        stack,
        family,
        message:
          `No approved base image for stack ${stack} (family ${family}). ` +
          `Add a digest-pinned reference to execution.docker.approvedBaseImages.`,
      },
    };
  }
  if (!isDigestPinnedImageRef(baseImage)) {
    return {
      ok: false,
      failure: {
        kind: "missing-base",
        stack,
        family,
        message: `Approved base image for ${stack} must be digest-pinned; got: ${baseImage}`,
      },
    };
  }

  const platform = input.platform ?? defaultPlatform();
  const dockerfile = renderDockerfile({
    workerImage,
    baseImage,
    stack,
    generatorVersion: EXECUTION_IMAGE_GENERATOR_VERSION,
  });
  const dockerignore = "# Minimal context — project source is never copied into the image.\n*\n";
  const profileHash = hashExecutionImageProfile(input.evidence);
  const dockerfileHash = createHash("sha256").update(dockerfile).digest("hex");

  return {
    ok: true,
    image: {
      stack,
      baseImage,
      workerImage,
      dockerfile,
      dockerignore,
      dockerfileHash,
      profileHash,
      generatorVersion: EXECUTION_IMAGE_GENERATOR_VERSION,
      allowlistVersion: BASE_IMAGE_ALLOWLIST_VERSION,
      platform,
    },
  };
}

export function computeExecutionImageCacheKey(input: {
  evidence: ExecutionImageEvidence;
  dockerfile: string;
  workerImage: string;
  platform: string;
  generatorVersion?: number;
  allowlistVersion?: number;
}): string {
  const payload = {
    manifests: canonicalProfileInputs(input.evidence),
    generatorVersion: input.generatorVersion ?? EXECUTION_IMAGE_GENERATOR_VERSION,
    workerDigest: input.workerImage,
    allowlistVersion: input.allowlistVersion ?? BASE_IMAGE_ALLOWLIST_VERSION,
    platform: input.platform,
    dockerfileHash: createHash("sha256").update(input.dockerfile).digest("hex"),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function renderDockerfile(input: {
  workerImage: string;
  baseImage: string;
  stack: ExecutionImageStackId;
  generatorVersion: number;
}): string {
  const lines = [
    `# Generated by agent-harness execution-image generator v${input.generatorVersion}`,
    `# Stack: ${input.stack}`,
    `# Do not commit this file into the control checkout.`,
    `FROM ${input.workerImage} AS harness-worker`,
    `FROM ${input.baseImage}`,
    `# Copy only the maintained harness worker binary — never project source.`,
    `COPY --from=harness-worker ${WORKER_IMAGE_BINARY_PATH} ${WORKER_IMAGE_BINARY_PATH}`,
    `RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin harness || true`,
    `USER 10001:10001`,
    `WORKDIR /workspace`,
    `# Entrypoint is the maintained worker binary; docker run supplies:`,
    `#   --run-id <id> --listen 0.0.0.0:8787 --secret-file /run-state/execution-secrets/rpc.token`,
    `# (equivalent to: agent-harness worker …).`,
    `ENTRYPOINT ["${WORKER_IMAGE_BINARY_PATH}"]`,
    "",
  ];
  return lines.join("\n");
}

function defaultPlatform(): string {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `linux/${arch}`;
}

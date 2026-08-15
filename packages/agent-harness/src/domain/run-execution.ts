import { z } from "zod";
import {
  HARNESS_PACKAGE_VERSION,
  WORKER_RPC_PROTOCOL_VERSION,
  WORKER_RPC_CONTAINER_PORT,
} from "../worker/protocol.js";

export const RUN_EXECUTION_SCHEMA_VERSION = 1 as const;

/**
 * Restartable Docker execution lifecycle metadata for a single run.
 * Durable under `<runDir>/execution.json`. Ephemeral container IDs and host ports
 * are discovered here and must not be treated as sole workspace identity
 * Disposable sandbox identity is not retained for reattachment.
 *
 * Secrets: store only non-reversible fingerprints — never paths or raw tokens.
 */
export const RunExecutionStateSchema = z
  .object({
    version: z.literal(RUN_EXECUTION_SCHEMA_VERSION),
    lifecycle: z
      .enum([
        "pending",
        "image-building",
        "provisioning",
        "running",
        "stopped",
        "exporting",
        "imported",
        "failed",
      ])
      .default("pending"),
    /** Stable container name used for rediscovery after host/UI restart. */
    containerName: z.string().min(1).optional(),
    /** Stable identity of this worker incarnation for lease fencing. */
    workerInstanceId: z.string().min(1).optional(),
    /** Ephemeral — rediscovered via docker inspect / labels. */
    containerId: z.string().min(1).optional(),
    /** Published loopback host port (ephemeral; rediscover when missing). */
    hostPort: z.number().int().positive().optional(),
    /** Container-side RPC listen port (default 8787). */
    containerPort: z.number().int().positive().default(WORKER_RPC_CONTAINER_PORT),
    imageId: z.string().min(1).optional(),
    discoveredImageDigest: z.string().min(1).optional(),
    /** Non-reversible token fingerprint for diagnostics (not the secret). */
    rpcTokenFingerprint: z.string().min(1).optional(),
    rpcProtocolVersion: z.number().int().positive().default(WORKER_RPC_PROTOCOL_VERSION),
    workerHarnessVersion: z.string().min(1).default(HARNESS_PACKAGE_VERSION),
    lastHealthAt: z.string().min(1).optional(),
    lastError: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type RunExecutionState = z.infer<typeof RunExecutionStateSchema>;

/**
 * Bundle transport / import journal under `<runDir>/transport/import.json`.
 * Seed and result artifacts stay under the same run `transport/` directory.
 */
export const BUNDLE_IMPORT_SCHEMA_VERSION = 1 as const;

export const BundleImportStateSchema = z
  .object({
    version: z.literal(BUNDLE_IMPORT_SCHEMA_VERSION),
    status: z
      .enum([
        "none",
        "seed-ready",
        "seed-imported",
        "export-ready",
        "quarantined",
        "validated",
        "promoted",
        "rejected",
      ])
      .default("none"),
    seedBundleHash: z.string().min(1).optional(),
    resultBundleHash: z.string().min(1).optional(),
    /** Relative transport filename (usually result.bundle); absent for no-change exports. */
    resultBundleRelativePath: z.string().min(1).optional(),
    manifestRelativePath: z.string().min(1).optional(),
    quarantineRef: z.string().min(1).optional(),
    exportRef: z.string().min(1).optional(),
    tipSha: z.string().min(1).optional(),
    baseSha: z.string().min(1).optional(),
    treeSha: z.string().min(1).optional(),
    deliveryBranch: z.string().min(1).optional(),
    deliveryRef: z.string().min(1).optional(),
    commitCount: z.number().int().nonnegative().optional(),
    objectCount: z.number().int().nonnegative().optional(),
    changedBytes: z.number().int().nonnegative().optional(),
    bundleBytes: z.number().int().nonnegative().optional(),
    /** True when tip === base (no result.bundle created). */
    noChange: z.boolean().optional(),
    rejectionReason: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .strict();
export type BundleImportState = z.infer<typeof BundleImportStateSchema>;

import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { HarnessConfig } from "../config/schema.js";
import { loadRunWorkspace, writeRunWorkspace } from "../config/io.js";
import {
  MessageOutputSchema,
  proposeDeliveryBranchName,
  slugifyFeatureTitle,
  type MessageOutput,
  type RunState,
} from "../domain.js";
import {
  BundleImportStateSchema,
  type BundleImportState,
} from "../domain/run-execution.js";
import { HarnessFailure } from "../errors.js";
import {
  createHostPullRequest,
  pushDeliveryBranch,
  resumeOrImportResult,
} from "../git/quarantine-import.js";
import {
  RESULT_BUNDLE_FILENAME,
  RESULT_MANIFEST_FILENAME,
  prepareResultExport,
  readResultManifest,
  type ResultBundleManifest,
} from "../git/result-export.js";
import type { RunRepository as RunStore } from "./run-repository.js";
import { WORKER_WORKSPACE_PATH } from "./paths.js";
import {
  hostTransportDirectory,
  loadBundleImportState,
  writeBundleImportState,
} from "./bundle-import-io.js";
const RESULT_BUNDLE_CHUNK_BYTES = 512 * 1024;
import { writeRunExecutionState, loadRunExecutionState } from "./execution-state-io.js";
import type { RunWorkspace } from "../domain/workspace.js";

export type WorkerPrepareExportResult = {
  ok: true;
  noChange: boolean;
  tipSha: string;
  baseSha: string;
  treeSha: string;
  bundleHash: string;
  commitCount: number;
  manifestRelativePath: string;
  resultBundleRelativePath?: string;
};

/**
 * Worker-side prepare-export: write result.bundle + manifest through the
 * selected transport and persist `transport/import.json` as export-ready.
 */
export async function prepareDockerResultExport(input: {
  config: HarnessConfig;
  store: RunStore;
  runId: string;
  workspace: RunWorkspace;
  workspacePath?: string;
  transport?: "rpc" | "filesystem";
}): Promise<WorkerPrepareExportResult> {
  const state = await input.store.load(input.runId);
  const baseSha = input.workspace.baseSha;
  if (!baseSha) {
    throw new HarnessFailure("Docker export requires a frozen workspace baseSha", "execution", false);
  }

  const remoteExport = input.transport === "rpc";
  const transportDirectory = remoteExport
    ? path.join("/tmp", `agent-harness-export-${input.runId}`)
    : path.join(input.store.runDirectory(input.runId), "transport");
  if (remoteExport) {
    await rm(transportDirectory, { recursive: true, force: true });
  }

  const expectedCommitShas = state.tasks
    .map((task) => task.commitSha)
    .filter((sha): sha is string => typeof sha === "string" && sha.length > 0);

  const exported = await prepareResultExport({
    workspacePath: input.workspacePath ?? WORKER_WORKSPACE_PATH,
    transportDirectory,
    runId: input.runId,
    baseSha,
    expectedCommitShas,
  });

  const importState = BundleImportStateSchema.parse({
    version: 1,
    status: "export-ready",
    resultBundleHash: exported.manifest.bundleHash,
    resultBundleRelativePath: exported.manifest.noChange ? undefined : RESULT_BUNDLE_FILENAME,
    manifestRelativePath: RESULT_MANIFEST_FILENAME,
    quarantineRef: exported.quarantineRef,
    exportRef: exported.exportRef,
    tipSha: exported.manifest.tipSha,
    baseSha: exported.manifest.baseSha,
    treeSha: exported.manifest.treeSha,
    commitCount: exported.manifest.commitCount,
    objectCount: exported.manifest.objectCount,
    changedBytes: exported.manifest.changedBytes,
    bundleBytes: exported.manifest.bundleBytes,
    noChange: exported.manifest.noChange,
    updatedAt: new Date().toISOString(),
  });
  if (remoteExport) {
    const manifestContents = await readFile(
      path.join(transportDirectory, RESULT_MANIFEST_FILENAME),
      "utf8",
    );
    await input.store.writeText(
      input.runId,
      `transport/${RESULT_MANIFEST_FILENAME}`,
      manifestContents,
    );
    if (!exported.manifest.noChange) {
      const bundle = await readFile(path.join(transportDirectory, RESULT_BUNDLE_FILENAME));
      for (let offset = 0, index = 0; offset < bundle.length; offset += RESULT_BUNDLE_CHUNK_BYTES) {
        const chunk = bundle.subarray(offset, offset + RESULT_BUNDLE_CHUNK_BYTES);
        await input.store.writeText(
          input.runId,
          `transport/result-bundle-chunks/${chunkId(index)}.base64`,
          chunk.toString("base64"),
        );
        index += 1;
      }
    }
    await rm(transportDirectory, { recursive: true, force: true });
  }
  await input.store.writeJson(input.runId, "transport/import.json", importState);

  await input.store.record(state, "run.bundle_exported", {
    tipSha: importState.tipSha,
    baseSha: importState.baseSha,
    treeSha: importState.treeSha,
    bundleHash: importState.resultBundleHash,
    noChange: importState.noChange === true,
    commitCount: importState.commitCount,
  });

  // Best-effort execution lifecycle stamp (host path helpers may not apply in worker).
  try {
    const execution = await loadRunExecutionState(input.config, input.runId);
    if (execution) {
      await writeRunExecutionState(input.config, input.runId, {
        ...execution,
        lifecycle: "exporting",
        updatedAt: new Date().toISOString(),
      });
    }
  } catch {
    // Worker may not resolve host state paths; import.json is authoritative.
  }

  return {
    ok: true,
    noChange: exported.manifest.noChange,
    tipSha: exported.manifest.tipSha,
    baseSha: exported.manifest.baseSha,
    treeSha: exported.manifest.treeSha,
    bundleHash: exported.manifest.bundleHash,
    commitCount: exported.manifest.commitCount,
    manifestRelativePath: RESULT_MANIFEST_FILENAME,
    resultBundleRelativePath: exported.manifest.noChange ? undefined : RESULT_BUNDLE_FILENAME,
  };
}

export function isDockerBundleExportReady(
  importState: BundleImportState | undefined,
): boolean {
  if (!importState) return false;
  return (
    importState.status === "export-ready" ||
    importState.status === "quarantined" ||
    importState.status === "validated" ||
    importState.status === "promoted"
  );
}

/**
 * Host control-plane completion for Docker publishing:
 * prepare-export (RPC) → quarantine validate → atomic delivery-ref promotion →
 * host-only push/PR. Never injects GitHub credentials into the container.
 */
export async function completeDockerHostPublish(input: {
  projectConfig: HarnessConfig;
  runConfig: HarnessConfig;
  runId: string;
  store: RunStore;
  /** Optional PR message; defaults to a deterministic fallback from run state. */
  message?: MessageOutput;
}): Promise<RunState> {
  const { projectConfig, runConfig, runId, store } = input;

  const existing = await loadBundleImportState(projectConfig, runId).catch(() => undefined);
  if (!isDockerBundleExportReady(existing)) {
    const workspace = await loadRunWorkspace(projectConfig, runId, {
      runDirectory: store.runDirectory(runId),
    });
    await prepareDockerResultExport({
      config: runConfig,
      store,
      runId,
      workspace,
      workspacePath:
        workspace.kind === "host-worktree" ? workspace.worktreePath : WORKER_WORKSPACE_PATH,
    });
  }

  let state = await store.load(runId);
  const workspace = await loadRunWorkspace(projectConfig, runId, {
    runDirectory: store.runDirectory(runId),
  });
  const baseSha = workspace.baseSha;
  if (!baseSha) {
    throw new HarnessFailure("Docker publish requires frozen baseSha", "execution", false);
  }

  let importState =
    (await loadBundleImportState(projectConfig, runId)) ??
    BundleImportStateSchema.parse({
      version: 1,
      status: "export-ready",
      updatedAt: new Date().toISOString(),
    });
  const transportDirectory = hostTransportDirectory(projectConfig, runId);
  await materializeResultTransport(store, runId, transportDirectory, importState);
  const manifest = await readResultManifest(path.join(transportDirectory, RESULT_MANIFEST_FILENAME));

  const title =
    state.reflectBrief?.confirmedStructured?.proposedTitle ??
    state.reflectBrief?.structured?.proposedTitle ??
    state.idea;
  const titleSlug = slugifyFeatureTitle(title);
  const existingBranch = workspace.branchName ?? state.branchName;
  const branchName =
    existingBranch ??
    proposeDeliveryBranchName({
      branchPrefix: runConfig.git.branchPrefix,
      title,
      runId,
    });

  try {
    if (importState.status !== "promoted") {
      importState = await writeBundleImportState(projectConfig, runId, {
        ...importState,
        status: "quarantined",
        quarantineRef: `refs/harness/quarantine/${runId}`,
        tipSha: manifest.tipSha,
        baseSha: manifest.baseSha,
        treeSha: manifest.treeSha,
        resultBundleHash: manifest.bundleHash,
        noChange: manifest.noChange,
        updatedAt: new Date().toISOString(),
      });

      const imported = await resumeOrImportResult({
        controlRoot: path.resolve(projectConfig.repositoryRoot),
        runId,
        transportDirectory,
        baseSha,
        limits: runConfig.execution.docker.bundleLimits,
        submoduleLfs: runConfig.execution.docker.submoduleLfs,
        ignoredArtifactPatterns: runConfig.git.ignoredArtifactPatterns,
        deliveryBranchName: branchName,
      });

      state = await store.record(state, "run.bundle_validated", {
        tipSha: imported.tipSha,
        treeSha: imported.treeSha,
        baseSha: imported.baseSha,
        noChange: imported.noChange,
      });

      importState = await writeBundleImportState(projectConfig, runId, {
        ...importState,
        status: "validated",
        tipSha: imported.tipSha,
        treeSha: imported.treeSha,
        baseSha: imported.baseSha,
        resultBundleHash: imported.resultBundleHash,
        deliveryBranch: imported.deliveryBranch,
        deliveryRef: imported.deliveryRef,
        noChange: imported.noChange,
        rejectionReason: undefined,
        updatedAt: new Date().toISOString(),
      });

      importState = await writeBundleImportState(projectConfig, runId, {
        ...importState,
        status: "promoted",
        updatedAt: new Date().toISOString(),
      });

      state = await store.record(
        { ...state, branchName: imported.deliveryBranch },
        "run.bundle_imported",
        {
          tipSha: imported.tipSha,
          deliveryBranch: imported.deliveryBranch,
          deliveryRef: imported.deliveryRef,
          noChange: imported.noChange,
        },
      );

      if (!existingBranch) {
        state = await store.record(state, "run.branch_created", {
          titleSlug,
          branchName: imported.deliveryBranch,
          headSha: imported.tipSha,
          created: true,
          retainedExisting: false,
        });
      }

      await writeRunWorkspace(
        projectConfig,
        runId,
        {
          ...workspace,
          branchName: imported.deliveryBranch,
        },
        { runDirectory: store.runDirectory(runId) },
      );
    } else if (!state.branchName && importState.deliveryBranch) {
      state = { ...state, branchName: importState.deliveryBranch };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeBundleImportState(projectConfig, runId, {
      ...importState,
      status: "rejected",
      rejectionReason: reason,
      updatedAt: new Date().toISOString(),
    }).catch(() => undefined);
    state = await store.record(state, "run.import_rejected", { reason });
    throw error instanceof HarnessFailure
      ? error
      : new HarnessFailure(reason, "execution", true, {
          cause: error instanceof Error ? error : undefined,
        });
  }

  const message =
    input.message ??
    MessageOutputSchema.parse({
      subject: `feat: ${state.idea}`.slice(0, 100),
      body: state.tasks.map((task) => `- ${task.title}`).join("\n"),
    });

  let pullRequestUrl: string | undefined = state.pullRequestUrl;
  const deliveryBranch = state.branchName ?? branchName;
  if (runConfig.git.enabled && runConfig.git.push && deliveryBranch) {
    const controlRoot = path.resolve(projectConfig.repositoryRoot);
    await pushDeliveryBranch({
      controlRoot,
      remote: runConfig.git.remote,
      branchName: deliveryBranch,
    });
    state = await store.record(state, "run.delivery_pushed", {
      branchName: deliveryBranch,
      remote: runConfig.git.remote,
    });
    if (runConfig.git.openPullRequest) {
      pullRequestUrl = await createHostPullRequest({
        controlRoot,
        baseBranch: runConfig.git.baseBranch,
        headBranch: deliveryBranch,
        title: message.subject,
        body: message.body,
      });
      state = await store.record(state, "run.delivery_pr_created", {
        pullRequestUrl,
        branchName: deliveryBranch,
      });
    }
  }

  const execution = await loadRunExecutionState(projectConfig, runId);
  if (execution) {
    await writeRunExecutionState(projectConfig, runId, {
      ...execution,
      lifecycle: "imported",
      updatedAt: new Date().toISOString(),
    });
  }

  return store.record(
    { ...state, phase: "completed", pullRequestUrl, branchName: deliveryBranch },
    "run.completed",
    { pullRequestUrl, dockerHostPublish: true },
  );
}

async function materializeResultTransport(
  store: RunStore,
  runId: string,
  transportDirectory: string,
  importState: BundleImportState,
): Promise<void> {
  await mkdir(transportDirectory, { recursive: true });
  const manifestPath = path.join(transportDirectory, RESULT_MANIFEST_FILENAME);
  const bundlePath = path.join(transportDirectory, RESULT_BUNDLE_FILENAME);

  // Host-owned filesystem export already lands the manifest/bundle in place.
  // Reconstruct from RPC chunks only when those files are absent.
  try {
    await readFile(manifestPath);
    if (importState.noChange === true || (await pathExists(bundlePath))) {
      return;
    }
  } catch {
    // Fall through to chunk reconstruction for remote/RPC exports.
  }

  const manifest = await store.readText(runId, `transport/${RESULT_MANIFEST_FILENAME}`);
  await writeFile(manifestPath, manifest, "utf8");
  if (importState.noChange === true) return;

  const bundleBytes = importState.bundleBytes;
  if (typeof bundleBytes !== "number" || bundleBytes <= 0) {
    throw new HarnessFailure("Export-ready result is missing bundle byte length", "execution", false);
  }
  const chunkCount = Math.ceil(bundleBytes / RESULT_BUNDLE_CHUNK_BYTES);
  const chunks: Buffer[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const encoded = await store.readText(
      runId,
      `transport/result-bundle-chunks/${chunkId(index)}.base64`,
    );
    chunks.push(Buffer.from(encoded, "base64"));
  }
  const bundle = Buffer.concat(chunks);
  if (bundle.length !== bundleBytes) {
    throw new HarnessFailure(
      `Result bundle transport length mismatch: expected ${bundleBytes}, received ${bundle.length}`,
      "execution",
      true,
    );
  }
  await writeFile(bundlePath, bundle);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function chunkId(index: number): string {
  return index.toString().padStart(6, "0");
}

export type { ResultBundleManifest };

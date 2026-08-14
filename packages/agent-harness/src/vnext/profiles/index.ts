import type { Context, Plugin } from "@deepseek-ai/cordis";
import type { RunPhase } from "../../domain.js";
import { securityPolicyPlugin } from "../plugins/security-policy.js";
import {
  definePhasePlugin,
  defineRolePlugin,
  roleRegistryPlugin,
  workflowRegistryPlugin,
} from "../plugins/registries.js";
import { securedContainerRuntimePlugin } from "../plugins/secured-container-runtime.js";
import {
  controlServerPlugin,
  type ControlServerConfig,
} from "../plugins/control-server.js";
import type { ProfileDefinition, ProfileRow } from "../boot/boot-profile.js";
import type { VNextServiceName } from "../services/contracts.js";
import {
  workerRuntimePlugin,
  type WorkerRuntimeConfig,
} from "../plugins/worker-runtime.js";
import {
  hostRunLifecyclePlugin,
  type HostRunLifecyclePluginConfig,
} from "../plugins/host-run-lifecycle.js";

export type VNextServiceValues = Partial<Record<VNextServiceName, unknown>>;

const HOST_SERVICES: readonly VNextServiceName[] = [
  "runState",
  "runArtifacts",
  "runLifecycle",
  "containerRuntime",
  "workspaceSource",
  "environment",
  "workerControl",
  "credentials",
  "publisher",
  "webServer",
];

const WORKER_SERVICES: readonly VNextServiceName[] = [
  "runState",
  "runArtifacts",
  "workerControl",
  "credentials",
  "agents",
  "knowledge",
  "repositoryIntelligence",
  "verification",
  "resultExport",
  "commands",
];

export const NONTERMINAL_WORKFLOW_PHASES: readonly RunPhase[] = [
  "new",
  "reflecting",
  "awaiting_input",
  "grilling",
  "planning",
  "executing",
  "scenario_testing",
  "crystallizing",
  "final_review",
  "publishing",
  "blocked",
];

const BUILTIN_ROLES = [
  "reflector",
  "griller",
  "docs-writer",
  "project-profiler",
  "planner",
  "scenario-planner",
  "issue-slicer",
  "prompt-builder",
  "implementer",
  "scenario-writer",
  "unit-test-writer",
  "reviewer",
  "task-reviewer",
  "message-writer",
  "fixer",
  "config-fixer",
] as const;

function servicePlugin(ctx: Context, config: { name: VNextServiceName; value: unknown }): void {
  if (config.value !== undefined) ctx.provide(config.name, config.value);
}

function serviceRow(
  id: string,
  name: VNextServiceName,
  values: VNextServiceValues,
  production: boolean,
): ProfileRow {
  return {
    id,
    plugin: servicePlugin,
    config: { name, value: values[name] },
    provides: [name],
    trusted: production ? true : undefined,
  };
}

export function createHostProfile(
  values: VNextServiceValues = {},
  controlServer?: ControlServerConfig,
  lifecycle?: HostRunLifecyclePluginConfig,
): ProfileDefinition {
  const rows = HOST_SERVICES.filter(
    (name) =>
      name !== "containerRuntime" &&
      (!lifecycle || name !== "runLifecycle") &&
      (!controlServer || (name !== "credentials" && name !== "webServer")),
  ).map((name) => serviceRow(`host.${name}`, name, values, true));
  if (lifecycle) {
    rows.push({
      id: "host.run-lifecycle",
      plugin: hostRunLifecyclePlugin,
      config: lifecycle,
      provides: ["runLifecycle"],
      trusted: true,
    });
  }
  rows.splice(3, 0, {
    id: "host.security-policy",
    plugin: securityPolicyPlugin,
    provides: ["securityPolicy"],
    trusted: true,
  });
  rows.splice(4, 0, {
    id: "host.container-runtime",
    plugin: securedContainerRuntimePlugin,
    config: { runtime: values.containerRuntime },
    provides: ["containerRuntime"],
    trusted: true,
  });
  if (controlServer) {
    rows.push({
      id: "host.control-server",
      plugin: controlServerPlugin,
      config: controlServer,
      provides: ["credentials", "webServer"],
      trusted: true,
    });
  }
  return {
    name: "host",
    production: true,
    hmr: false,
    requiredServices: [...HOST_SERVICES, "securityPolicy"],
    rows,
  };
}

export function createWorkerProfile(
  values: VNextServiceValues = {},
  runtime?: WorkerRuntimeConfig,
): ProfileDefinition {
  const runtimeServices = new Set<VNextServiceName>([
    "workerControl",
    "agents",
    "knowledge",
    "repositoryIntelligence",
    "verification",
    "resultExport",
    "commands",
  ]);
  const rows: ProfileRow[] = [
    ...(runtime
      ? [
          {
            id: "worker.runtime",
            plugin: workerRuntimePlugin,
            config: runtime,
            provides: [...runtimeServices],
            trusted: true,
          } satisfies ProfileRow,
        ]
      : []),
    ...WORKER_SERVICES.filter((name) => !runtime || !runtimeServices.has(name)).map((name) =>
      serviceRow(`worker.${name}`, name, values, true),
    ),
    {
      id: "worker.security-policy",
      plugin: securityPolicyPlugin,
      provides: ["securityPolicy"],
      trusted: true,
    },
    {
      id: "worker.role-registry",
      plugin: roleRegistryPlugin,
      provides: ["roles"],
      trusted: true,
    },
    {
      id: "worker.phase-registry",
      plugin: workflowRegistryPlugin,
      provides: ["workflow"],
      trusted: true,
    },
  ];
  for (const role of BUILTIN_ROLES) {
    rows.push({
      id: `worker.role.${role}`,
      plugin: defineRolePlugin({
        id: role,
        allowTools: !["reflector", "griller", "docs-writer"].includes(role),
        description: `Built-in ${role} role`,
      }),
      trusted: true,
    });
  }
  for (const phase of NONTERMINAL_WORKFLOW_PHASES) {
    rows.push({
      id: `worker.phase.${phase}`,
      plugin: definePhasePlugin({
        phase,
        advance: async (runId) => {
          const control = values.workerControl as { advance(runId: string): Promise<void> } | undefined;
          if (!control) throw new Error("workerControl is unavailable");
          await control.advance(runId);
        },
      }),
      trusted: true,
    });
  }
  rows.push({
    id: "worker.phase-contract",
    plugin: Object.assign(
      (ctx: Context) => ctx.workflow.validate(NONTERMINAL_WORKFLOW_PHASES),
      { inject: ["workflow"] },
    ) as Plugin,
    trusted: true,
  });
  return {
    name: "worker",
    production: true,
    hmr: false,
    requiredServices: [...WORKER_SERVICES, "securityPolicy", "roles", "workflow"],
    rows,
  };
}

export function createDeterministicTestProfile(
  values: VNextServiceValues = {},
): ProfileDefinition {
  const profile = createWorkerProfile(values);
  return {
    ...profile,
    name: "deterministic-test",
    production: false,
    rows: profile.rows.map((row) => ({ ...row, trusted: undefined })),
  };
}

export function profileForDump(name: string): ProfileDefinition {
  switch (name) {
    case "host":
      return createHostProfile();
    case "worker":
      return createWorkerProfile();
    case "deterministic-test":
    case "test":
      return createDeterministicTestProfile();
    default:
      throw new Error(`Unknown vNext profile "${name}" (expected host, worker, or deterministic-test)`);
  }
}

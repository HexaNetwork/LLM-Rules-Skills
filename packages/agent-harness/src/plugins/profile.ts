import type { Context } from "@deepseek-ai/cordis";
import type { ProfileRow } from "../boot.js";
import { createReflectPhase } from "../phases/reflect.js";
import { createGrillPhase } from "../phases/grill.js";
import { createGlossaryPhase } from "../phases/glossary.js";
import { createVerificationSettingsPhase } from "../phases/verification-settings.js";
import { createPlanPhase } from "../phases/plan.js";
import { createPrdPhase } from "../phases/prd.js";
import { createScenariosPhase } from "../phases/scenarios.js";
import { createOperatorGatePhase } from "../phases/operator-gate.js";
import { createSlicePhase } from "../phases/slice.js";
import { createImplementPhase } from "../phases/implement.js";
import { createScenarioTestPhase } from "../phases/scenario-test.js";
import { createCrystallizePhase } from "../phases/crystallize.js";
import { createFinalReviewPhase } from "../phases/final-review.js";
import { createPublishPhase } from "../phases/publish.js";
import { projectsPlugin } from "./projects.js";
import { workflowPlugin } from "./workflow.js";
import { phasesPlugin } from "./phases.js";
import { packetsPlugin } from "./packets.js";
import { agentsPlugin, type AgentsConfig } from "./agents.js";
import { gitPlugin } from "./git.js";
import { sandboxPlugin, type SandboxConfig } from "./sandbox.js";
import { knowledgePlugin } from "./knowledge.js";
import { commandsPlugin } from "./commands.js";
import { runLifecyclePlugin } from "./run-lifecycle.js";
import type { WorkflowBundle } from "../domain/types.js";

export type RuntimeOptions = {
  agents?: AgentsConfig;
  sandbox?: SandboxConfig;
  bundles?: WorkflowBundle[];
};

export function hostRuntimeRows(options: RuntimeOptions = {}): ProfileRow[] {
  return [
    { id: "host.projects", plugin: projectsPlugin, provides: ["projects"], trusted: true },
    {
      id: "host.workflow",
      plugin: workflowPlugin,
      config: options.bundles ? { bundles: options.bundles } : {},
      provides: ["workflow"],
      trusted: true,
    },
    { id: "host.phases", plugin: phasesPlugin, provides: ["phases"], trusted: true },
    { id: "host.packets", plugin: packetsPlugin, provides: ["packets"], trusted: true },
    {
      id: "host.agents",
      plugin: agentsPlugin,
      config: options.agents ?? {},
      provides: ["agents"],
      trusted: true,
    },
    { id: "host.git", plugin: gitPlugin, provides: ["git"], trusted: true },
    {
      id: "host.sandbox",
      plugin: sandboxPlugin,
      config: options.sandbox ?? {},
      provides: ["sandbox"],
      trusted: true,
    },
    { id: "host.knowledge", plugin: knowledgePlugin, provides: ["knowledge"], trusted: true },
    { id: "host.commands", plugin: commandsPlugin, provides: ["commands"], trusted: true },
    phaseRow("reflect", createReflectPhase),
    phaseRow("grill", createGrillPhase),
    phaseRow("glossary", createGlossaryPhase),
    {
      id: "host.phase.verification-settings",
      plugin: Object.assign((ctx: Context) => ctx.phases.register(createVerificationSettingsPhase()), {
        inject: PHASE_INJECT,
      }),
      trusted: true,
    },
    phaseRow("plan", createPlanPhase),
    phaseRow("prd", createPrdPhase),
    phaseRow("scenarios", createScenariosPhase),
    {
      id: "host.phase.operator-gate",
      plugin: Object.assign((ctx: Context) => ctx.phases.register(createOperatorGatePhase()), {
        inject: PHASE_INJECT,
      }),
      trusted: true,
    },
    phaseRow("slice", createSlicePhase),
    phaseRow("implement", createImplementPhase),
    phaseRow("scenario-test", createScenarioTestPhase),
    phaseRow("crystallize", createCrystallizePhase),
    phaseRow("final-review", createFinalReviewPhase),
    phaseRow("publish", createPublishPhase),
    { id: "host.runLifecycle", plugin: runLifecyclePlugin, provides: ["runLifecycle"], trusted: true },
  ];
}

const PHASE_INJECT = [
  "phases",
  "knowledge",
  "packets",
  "agents",
  "git",
  "commands",
  "sandbox",
  "store",
  "settings",
];

function phaseRow(id: string, factory: (ctx: Context) => ReturnType<typeof createReflectPhase>): ProfileRow {
  return {
    id: `host.phase.${id}`,
    plugin: Object.assign((ctx: Context) => ctx.phases.register(factory(ctx)), {
      inject: PHASE_INJECT,
    }),
    trusted: true,
  };
}

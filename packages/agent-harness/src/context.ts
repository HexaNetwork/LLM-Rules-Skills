import type { ProjectService } from "./plugins/projects.js";
import type { SettingsService } from "./plugins/settings.js";
import type { StoreService } from "./plugins/store.js";
import type { WorkflowService } from "./plugins/workflow.js";
import type { PhaseRegistry } from "./plugins/phases.js";
import type { PacketService } from "./plugins/packets.js";
import type { AgentsService } from "./plugins/agents.js";
import type { GitService } from "./plugins/git.js";
import type { SandboxService } from "./plugins/sandbox.js";
import type { RoleGuidanceService } from "./plugins/role-guidance.js";
import type { CommandService } from "./plugins/commands.js";
import type { RunLifecycleService } from "./plugins/run-lifecycle.js";
import type { DashboardService } from "./plugins/dashboard.js";
import type { ImageRepairService } from "./plugins/image-repair.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    store: StoreService;
    settings: SettingsService;
    projects: ProjectService;
    workflow: WorkflowService;
    phases: PhaseRegistry;
    packets: PacketService;
    agents: AgentsService;
    git: GitService;
    sandbox: SandboxService;
    roleGuidance: RoleGuidanceService;
    commands: CommandService;
    runLifecycle: RunLifecycleService;
    imageRepair: ImageRepairService;
    dashboard?: DashboardService;
  }
}

export {};

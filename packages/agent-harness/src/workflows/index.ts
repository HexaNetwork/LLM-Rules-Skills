import type { WorkflowDefinition } from "../types.js";
import { ClarifyStep } from "./clarify.js";
import { SpecifyStep } from "./specify.js";
import { ProvisionEnvironmentStep } from "./provision.js";
import { ImplementStep } from "./implement.js";
import { ValidateStep } from "./validate.js";
import { PublishStep } from "./publish.js";

const steps = [new ClarifyStep(), new SpecifyStep(), new ProvisionEnvironmentStep(), new ImplementStep(), new ValidateStep(), new PublishStep()] as const;
export const completeWorkflow: WorkflowDefinition = { id: "complete", steps };
export const ticketWorkflow: WorkflowDefinition = { id: "ticket", steps };
export const WORKFLOWS = new Map<string, WorkflowDefinition>([[completeWorkflow.id, completeWorkflow], [ticketWorkflow.id, ticketWorkflow]]);

export { ClarifyStep, SpecifyStep, ProvisionEnvironmentStep, ImplementStep, ValidateStep, PublishStep };

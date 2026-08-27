import type { CommandResult, EnvironmentSpec } from "./types.js";
import { parseEnvironmentSpec } from "./schemas.js";
import type { ContainerRuntime } from "./container-runtime.js";
import type { Store } from "./store.js";

export class EnvironmentManager {
  constructor(private readonly containers: ContainerRuntime, private readonly store: Store) {}

  async execute(runId: string, workspace: string, actionId: string, command: string): Promise<CommandResult> {
    const cached = this.store.recordAction(runId, actionId, "environment", { command });
    if (cached && (cached as CommandResult).exitCode === 0) return cached as CommandResult;
    let result: CommandResult;
    if (actionId.endsWith("/environment/build/0")) {
      const spec = parseEnvironmentSpec(JSON.parse(command));
      const built = await this.containers.buildEnvironment(runId, spec);
      await this.containers.createRunContainer(runId, built.image, workspace, spec.caches);
      await this.store.writeArtifact(runId, "provision-environment", "environment-spec.json", JSON.stringify(spec, null, 2), "application/json");
      await this.store.writeArtifact(runId, "provision-environment", "build.log", built.log);
      result = { actionId, exitCode: 0, stdout: JSON.stringify({ spec, image: built.image, digest: built.digest, containerName: this.containers.containerName(runId) }), stderr: "" };
    } else {
      result = await this.containers.exec(this.containers.containerName(runId), command);
      result.actionId = actionId;
    }
    this.store.finishAction(actionId, result);
    return result;
  }

  async ensureContainer(runId: string, workspace: string): Promise<string | undefined> {
    const name = this.containers.containerName(runId);
    if (await this.containers.inspect(name)) return name;
    const record = this.store.stepRecord(runId, "provision-environment");
    const output = record?.output as { environmentSpec?: EnvironmentSpec; image?: string } | undefined;
    if (!output?.environmentSpec || !output.image) return undefined;
    await this.containers.createRunContainer(runId, output.image, workspace, output.environmentSpec.caches);
    return name;
  }
}

export type { DockerClient, DockerExecResult, DockerExecOptions, DockerImageInspect, DockerVolumeInspect, DockerContainerInspect } from "./types.js";
export { createDockerClient } from "./docker-client.js";
export { createFakeDockerClient, type FakeDockerCall, type FakeDockerClientOptions } from "./fake-docker-client.js";
export {
  probeDockerReadiness,
  assertDockerReadiness,
  compareApiVersion,
  realDockerSkipReason,
  MIN_DOCKER_API_VERSION,
  type DockerReadinessCheck,
  type DockerReadinessCheckId,
  type DockerReadinessReport,
  type ProbeDockerReadinessOptions,
} from "./docker-readiness.js";
export {
  buildHardenedContainerSpec,
  denyMountOrFlag,
  denyInsecureContainerArgv,
  argvLeaksProviderCredential,
  harnessContainerLabels,
  hardenedSpecToRunArgv,
  networkPolicyDocumentation,
  HARNESS_CONTAINER_LABEL_PREFIX,
  type ContainerMount,
  type ContainerResourceLimits,
  type HardenedContainerSpec,
  type HardenedWorkspace,
  type MountDenyReason,
  type NetworkMode,
} from "./container-spec.js";

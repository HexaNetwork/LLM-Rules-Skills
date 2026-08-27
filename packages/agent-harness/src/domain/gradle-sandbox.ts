/** Gradle I/O inside Docker sandboxes: named volumes + init script for fast build dirs. */

export const GRADLE_INIT_MARKER = "agent-harness-fast-build";

export function gradleCacheVolumeName(projectKey: string): string {
  return `agent-harness-gradle-${projectKey}`;
}

export function gradleBuildVolumeName(projectKey: string): string {
  return `agent-harness-build-${projectKey}`;
}

export function gradleInitScript(): string {
  return `// ${GRADLE_INIT_MARKER}
allprojects {
    buildDir = file("/gradle-build/\${project.name}/build")
}
`;
}

/** docker volume create args (idempotent). */
export function buildVolumeCreateArgs(volumeName: string): string[] {
  return ["volume", "create", volumeName];
}

/**
 * One-off container that writes the Gradle init script into the cache volume when missing.
 * Reuses the worker image so no extra pull is required.
 */
export function buildGradleInitEnsureArgs(volumeName: string, image: string): string[] {
  const script = gradleInitScript().replace(/'/g, "'\\''");
  const shell = [
    "mkdir -p /gradle-cache/init.d",
    `test -f /gradle-cache/init.d/fast-build.gradle && grep -q '${GRADLE_INIT_MARKER}' /gradle-cache/init.d/fast-build.gradle`,
    `|| printf '%s' '${script}' > /gradle-cache/init.d/fast-build.gradle`,
  ].join(" && ");
  return ["run", "--rm", "-v", `${volumeName}:/gradle-cache`, image, "sh", "-c", shell];
}

export const GRADLE_SANDBOX_ENV: Record<string, string> = {
  GRADLE_USER_HOME: "/gradle-cache",
  "ORG_GRADLE_PROJECT_org.gradle.vfs.watch": "false",
  "ORG_GRADLE_PROJECT_org.gradle.parallel": "true",
};

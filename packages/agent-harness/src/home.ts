import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export function defaultHarnessHome(): string {
  return process.env.AGENT_HARNESS_HOME || path.join(os.homedir(), ".agent-harness");
}

export function projectKeyFor(repositoryPath: string): string {
  return createHash("sha256").update(path.resolve(repositoryPath)).digest("hex").slice(0, 16);
}

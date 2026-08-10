import path from "node:path";
import { createHash } from "node:crypto";

export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Knowledge source escapes repository: ${target}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Packaged General/ rules and skills (seeded into harness home, not target repos). */
export function resolveGuidanceTemplateDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/guidance/General");
}

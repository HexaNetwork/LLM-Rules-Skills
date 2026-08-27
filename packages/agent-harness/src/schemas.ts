import type { EnvironmentSpec, JsonSchema } from "./types.js";

export function assertObject(value: unknown, label = "value"): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
}

export function parseEnvironmentSpec(value: unknown): EnvironmentSpec {
  assertObject(value, "EnvironmentSpec");
  assertString(value.containerfile, "containerfile");
  for (const field of ["setupCommands", "healthcheckCommands", "caches"] as const) {
    if (!Array.isArray(value[field])) throw new Error(`${field} must be an array`);
  }
  const setupCommands = value.setupCommands as unknown[];
  const healthcheckCommands = value.healthcheckCommands as unknown[];
  const cacheValues = value.caches as unknown[];
  const commands = [...setupCommands, ...healthcheckCommands];
  if (!commands.every((item) => typeof item === "string" && item.trim())) throw new Error("commands must be non-empty strings");
  const caches = cacheValues.map((cache, index) => {
    assertObject(cache, `caches[${index}]`);
    assertString(cache.name, `caches[${index}].name`);
    assertString(cache.containerPath, `caches[${index}].containerPath`);
    return { name: cache.name, containerPath: cache.containerPath };
  });
  return { containerfile: value.containerfile, setupCommands: setupCommands as string[], healthcheckCommands: healthcheckCommands as string[], caches };
}

export function validateJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return ["output must be an object"];
    const record = value as Record<string, unknown>;
    for (const name of (schema.required as string[] | undefined) ?? []) if (!(name in record)) errors.push(`missing required property: ${name}`);
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    if (schema.additionalProperties === false) for (const name of Object.keys(record)) if (!(name in properties)) errors.push(`unknown property: ${name}`);
    for (const [name, child] of Object.entries(properties)) {
      if (!(name in record)) continue;
      if (child.type === "string" && typeof record[name] !== "string") errors.push(`${name} must be a string`);
      if (child.type === "array" && !Array.isArray(record[name])) errors.push(`${name} must be an array`);
      if (child.type === "boolean" && typeof record[name] !== "boolean") errors.push(`${name} must be a boolean`);
      if (child.type === "object" && (!record[name] || typeof record[name] !== "object" || Array.isArray(record[name]))) errors.push(`${name} must be an object`);
    }
  }
  return errors;
}

/**
 * Prefer the latest parseable candidate among assistant result text and
 * CreatePlan bodies (oldest first). Empty result strings are skipped.
 */
export function resolveAgentOutput(
  resultOutput: unknown,
  createPlanBodies: string[] = [],
): { raw: unknown; parsed: unknown } {
  const candidates: unknown[] = [];
  for (const body of createPlanBodies) {
    if (typeof body === "string" && body.trim()) candidates.push(body);
  }
  if (typeof resultOutput === "string") {
    if (resultOutput.trim()) candidates.push(resultOutput);
  } else if (resultOutput != null) {
    candidates.push(resultOutput);
  }

  let lastError: unknown = new Error("Agent response contains no JSON object");
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    try {
      return { raw: candidate, parsed: parseOutput(candidate) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Best-effort raw payload for failed sessions that may lack parseable JSON. */
export function tryResolveAgentOutput(
  resultOutput: unknown,
  createPlanBodies: string[] = [],
): unknown {
  try {
    return resolveAgentOutput(resultOutput, createPlanBodies).raw;
  } catch {
    const lastPlan = [...createPlanBodies].reverse().find((body) => body.trim());
    return lastPlan ?? resultOutput ?? "";
  }
}

export function parseOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  // Greedy fence capture: JSON string values may themselves contain code
  // fences (```java, ```mermaid), so a lazy match would truncate mid-object.
  const fenced = output.match(/```json\s*([\s\S]*)```/i)?.[1];
  const candidate = fenced ?? output;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("Agent response contains no JSON object");
  const balancedEnd = jsonObjectEnd(candidate, start);
  if (balancedEnd > start) {
    return JSON.parse(candidate.slice(start, balancedEnd + 1));
  }
  const end = candidate.lastIndexOf("}");
  if (end <= start) throw new Error("Agent response contains no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * End index of the JSON object opening at `start`, ignoring braces inside
 * string literals. Returns -1 when the object never closes.
 */
function jsonObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

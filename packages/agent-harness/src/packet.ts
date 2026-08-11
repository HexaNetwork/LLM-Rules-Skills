import type { AgentRole, WorkPacket } from "./domain.js";

export type BudgetTruncation = {
  path: string;
  reason: string;
  before: number;
  after: number;
};

export type BudgetAudit = {
  truncations: BudgetTruncation[];
  guidanceCharacters: number;
  contextCharacters: number;
  inputCharacters: number;
  limits: {
    contextCharacters: number;
    inputCharacters: number;
    graphifyCharacters: number;
  };
};

export type BuildWorkPacketInput = {
  invocationId: string;
  runId: string;
  role: AgentRole;
  objective: string;
  constraints: string[];
  input: unknown;
  guidance: WorkPacket["guidance"];
  guidancePack?: string;
  retrievalResults: Array<{ source: string; title: string; excerpt: string }>;
  priorArtifacts: string[];
  expectedOutput: string;
  createdAt: string;
  budgets: {
    contextCharacters: number;
    inputCharacters: number;
    graphifyCharacters: number;
  };
  domainArtifacts?: WorkPacket["domainArtifacts"];
};

/** Single authority for every byte that enters a work packet prompt. */
export function buildWorkPacket(input: BuildWorkPacketInput): {
  packet: WorkPacket;
  budgetAudit: BudgetAudit;
} {
  const truncations: BudgetTruncation[] = [];
  const rawPack = input.guidancePack ?? "";
  const guidancePack = rawPack.slice(0, Math.max(0, input.budgets.contextCharacters));
  if (guidancePack.length < rawPack.length) {
    truncations.push({
      path: "guidancePack",
      reason: "context-budget",
      before: rawPack.length,
      after: guidancePack.length,
    });
  }
  const guidanceCharacters = guidancePack.length;
  let remaining = Math.max(0, input.budgets.contextCharacters - guidanceCharacters);

  const context: WorkPacket["context"] = [];
  for (const result of input.retrievalResults) {
    if (remaining <= 0) break;
    const isGraphify = result.source.startsWith("graphify:");
    const sectionCap = isGraphify
      ? Math.min(remaining, input.budgets.graphifyCharacters)
      : remaining;
    const excerpt = result.excerpt.slice(0, sectionCap);
    if (isGraphify && result.excerpt.length > excerpt.length) {
      truncations.push({
        path: "context.graphify.excerpt",
        reason: "graphify-budget",
        before: result.excerpt.length,
        after: excerpt.length,
      });
    } else if (result.excerpt.length > excerpt.length) {
      truncations.push({
        path: `context[${context.length}].excerpt`,
        reason: "context-budget",
        before: result.excerpt.length,
        after: excerpt.length,
      });
    }
    context.push({ source: result.source, title: result.title, excerpt });
    remaining -= excerpt.length;
  }

  const { value: budgetedInput, truncations: inputTruncations } = budgetInput(
    input.input,
    input.budgets.inputCharacters,
  );
  truncations.push(...inputTruncations);

  const packet: WorkPacket = {
    contractVersion: "2",
    invocationId: input.invocationId,
    runId: input.runId,
    role: input.role,
    objective: input.objective,
    constraints: input.constraints,
    input: budgetedInput,
    guidance: input.guidance,
    guidancePack,
    context,
    priorArtifacts: input.priorArtifacts,
    expectedOutput: input.expectedOutput,
    createdAt: input.createdAt,
    ...(input.domainArtifacts ? { domainArtifacts: input.domainArtifacts } : {}),
  };

  return {
    packet,
    budgetAudit: {
      truncations,
      guidanceCharacters,
      contextCharacters: context.reduce((total, item) => total + item.excerpt.length, 0),
      inputCharacters: JSON.stringify(budgetedInput).length,
      limits: { ...input.budgets },
    },
  };
}

/** Iteratively truncate the longest string leaf until serialized input fits. */
export function budgetInput(
  input: unknown,
  maxCharacters: number,
): { value: unknown; truncations: BudgetTruncation[] } {
  const truncations: BudgetTruncation[] = [];
  let value = structuredClone(input) as unknown;
  let serialized = JSON.stringify(value);
  if (serialized.length <= maxCharacters) {
    return { value, truncations };
  }

  while (serialized.length > maxCharacters) {
    const leaf = longestStringLeaf(value);
    if (!leaf || leaf.value.length <= 1) break;
    const overflow = serialized.length - maxCharacters;
    const nextLength = Math.max(1, leaf.value.length - Math.max(1, overflow));
    if (nextLength >= leaf.value.length) break;
    truncations.push({
      path: leaf.path,
      reason: "input-budget",
      before: leaf.value.length,
      after: nextLength,
    });
    setAtPath(value, leaf.path, leaf.value.slice(0, nextLength));
    serialized = JSON.stringify(value);
  }

  return { value, truncations };
}

function longestStringLeaf(
  value: unknown,
  path = "$",
): { path: string; value: string } | undefined {
  if (typeof value === "string") return { path, value };
  if (Array.isArray(value)) {
    let best: { path: string; value: string } | undefined;
    for (const [index, item] of value.entries()) {
      const candidate = longestStringLeaf(item, `${path}[${index}]`);
      if (!candidate) continue;
      if (!best || candidate.value.length > best.value.length) best = candidate;
    }
    return best;
  }
  if (value && typeof value === "object") {
    let best: { path: string; value: string } | undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const candidate = longestStringLeaf(item, `${path}.${key}`);
      if (!candidate) continue;
      if (!best || candidate.value.length > best.value.length) best = candidate;
    }
    return best;
  }
  return undefined;
}

function setAtPath(root: unknown, path: string, value: string): void {
  const tokens = tokenizePath(path);
  let cursor: unknown = root;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]!;
    cursor = typeof token === "number"
      ? (cursor as unknown[])[token]
      : (cursor as Record<string, unknown>)[token];
  }
  const last = tokens[tokens.length - 1]!;
  if (typeof last === "number") (cursor as unknown[])[last] = value;
  else (cursor as Record<string, unknown>)[last] = value;
}

function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const pattern = /\$|\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
  for (const match of path.matchAll(pattern)) {
    if (match[0] === "$") continue;
    if (match[1] != null) tokens.push(match[1]);
    else if (match[2] != null) tokens.push(Number(match[2]));
  }
  return tokens;
}

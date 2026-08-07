import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export type EmbeddingSettings = {
  enabled: boolean;
  provider: "openai-compatible" | "ollama";
  endpoint: string;
  model: string;
  apiKeyEnv: string;
  batchSize: number;
  timeoutMs: number;
  minSimilarity: number;
  lexicalWeight: number;
  semanticWeight: number;
};

export type VectorEntry = { id: string; textHash: string; vector: number[] };
export type EmbeddingProgress = { completed: number; total: number };

const EmbeddingIndexSchema = z.object({
  version: z.literal(1),
  provider: z.enum(["openai-compatible", "ollama"]),
  endpoint: z.string(),
  model: z.string(),
  entries: z.array(z.object({
    id: z.string(),
    textHash: z.string(),
    vector: z.array(z.number()),
  })),
});

type EmbeddingIndex = z.infer<typeof EmbeddingIndexSchema>;

/**
 * A small, portable vector index. It deliberately keeps vector storage local so
 * access control remains in LocalKnowledgeBase before any result is exposed.
 */
const queryVectorCache = new Map<string, number[]>();

export class LocalEmbeddingIndex {
  private readonly indexPath: string;

  constructor(
    directory: string,
    private readonly settings: EmbeddingSettings,
  ) {
    this.indexPath = path.join(directory, "embeddings.json");
  }

  async sync(
    chunks: Array<{ id: string; text: string; textHash: string }>,
    onProgress?: (progress: EmbeddingProgress) => void,
  ): Promise<void> {
    if (!this.settings.enabled) return;
    const current = await this.loadCompatible();
    const existing = new Map(current?.entries.map((entry) => [entry.id, entry]));
    const missing = chunks.filter((chunk) => existing.get(chunk.id)?.textHash !== chunk.textHash);
    if (missing.length === 0 && current?.entries.length === chunks.length) {
      onProgress?.({ completed: 0, total: 0 });
      return;
    }

    onProgress?.({ completed: 0, total: missing.length });
    const generated = await this.embedMany(missing.map((chunk) => chunk.text), onProgress);
    if (generated.length !== missing.length) {
      throw new Error("Embedding endpoint returned an unexpected number of vectors");
    }
    const next = new Map<string, VectorEntry>();
    for (const chunk of chunks) {
      const prior = existing.get(chunk.id);
      if (prior?.textHash === chunk.textHash) next.set(chunk.id, prior);
    }
    for (const [index, chunk] of missing.entries()) {
      const vector = generated[index];
      if (!vector || vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
        throw new Error("Embedding endpoint returned an invalid vector");
      }
      next.set(chunk.id, { id: chunk.id, textHash: chunk.textHash, vector });
    }
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    const index: EmbeddingIndex = {
      version: 1,
      provider: this.settings.provider,
      endpoint: this.settings.endpoint,
      model: this.settings.model,
      entries: [...next.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    await writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  async search(query: string, allowedIds: Set<string>): Promise<Map<string, number>> {
    if (!this.settings.enabled || allowedIds.size === 0) return new Map();
    try {
      const index = await this.loadCompatible();
      if (!index || index.entries.length === 0) return new Map();
      const cacheKey = [
        query,
        this.settings.provider,
        this.settings.endpoint,
        this.settings.model,
      ].join("\0");
      let queryVector = queryVectorCache.get(cacheKey);
      if (!queryVector) {
        const [embedded] = await this.embedMany([query]);
        if (!embedded) return new Map();
        queryVector = embedded;
        queryVectorCache.set(cacheKey, embedded);
      }
      return new Map(
        index.entries
          .filter((entry) => allowedIds.has(entry.id))
          .map((entry) => [entry.id, cosineSimilarity(queryVector!, entry.vector)] as const)
          .filter(([, score]) => Number.isFinite(score) && score >= this.settings.minSimilarity),
      );
    } catch {
      // Semantic retrieval is an enhancement. An unavailable provider must not
      // prevent the durable lexical baseline from serving a work packet.
      return new Map();
    }
  }

  private async loadCompatible(): Promise<EmbeddingIndex | undefined> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.indexPath, "utf8"));
      const index = EmbeddingIndexSchema.parse(raw);
      return index.provider === this.settings.provider &&
        index.endpoint === this.settings.endpoint &&
        index.model === this.settings.model
        ? index
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async embedMany(
    inputs: string[],
    onProgress?: (progress: EmbeddingProgress) => void,
  ): Promise<number[][]> {
    const apiKey = process.env[this.settings.apiKeyEnv];
    if (this.settings.provider === "openai-compatible" && !apiKey) {
      throw new Error(`Embedding is enabled but ${this.settings.apiKeyEnv} is not set`);
    }
    const vectors: number[][] = [];
    for (let start = 0; start < inputs.length; start += this.settings.batchSize) {
      const input = inputs.slice(start, start + this.settings.batchSize);
      const response = await fetch(this.settings.endpoint, {
        method: "POST",
        headers: this.settings.provider === "openai-compatible"
          ? { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
          : { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.settings.model, input }),
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`Embedding endpoint failed (${response.status})`);
      }
      const body: unknown = await response.json();
      const ordered = this.settings.provider === "openai-compatible"
        ? [...z.object({
            data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number()) })),
          }).parse(body).data]
            .sort((a, b) => a.index - b.index)
            .map((item) => item.embedding)
        : z.object({ embeddings: z.array(z.array(z.number())) }).parse(body).embeddings;
      if (ordered.length !== input.length) {
        throw new Error("Embedding endpoint returned incomplete batch data");
      }
      vectors.push(...ordered);
      onProgress?.({ completed: vectors.length, total: inputs.length });
    }
    return vectors;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude === 0 || rightMagnitude === 0
    ? Number.NaN
    : dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

import path from "node:path";
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";
import {
  ManifestTaskSchema,
  type ManifestTask,
  type SourceDocument,
} from "../schemas/manifest.js";
import { TaskModeSchema } from "../schemas/common.js";
import { sha256Text } from "../util/hash.js";

const LocalTaskBundleSchema = z.object({
  title: z.string().optional(),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      mode: TaskModeSchema.default("AFK"),
      body: z.string().default(""),
      acceptanceCriteria: z
        .array(
          z.object({
            id: z.string().min(1),
            text: z.string().min(1),
          }),
        )
        .min(1),
      blockedBy: z.array(z.string()).default([]),
      allowedGlobs: z.array(z.string()).default(["**/*"]),
      testSeams: z.array(z.string()).default([]),
      browserProbes: z
        .array(
          z.object({
            id: z.string(),
            description: z.string(),
            urlPath: z.string().optional(),
            steps: z.array(z.string()).min(1),
          }),
        )
        .default([]),
      implementationNotes: z.string().optional(),
      sourceRef: z.string().optional(),
    }),
  ),
});

export type NormalizedSource = {
  source: SourceDocument;
  tasks: ManifestTask[];
};

export async function loadLocalSource(
  filePath: string,
): Promise<NormalizedSource> {
  const absolute = path.resolve(filePath);
  const raw = await readFile(absolute, "utf8");
  const parsed =
    absolute.endsWith(".yaml") || absolute.endsWith(".yml")
      ? yaml.load(raw)
      : JSON.parse(raw);
  const bundle = LocalTaskBundleSchema.parse(parsed);
  const tasks = bundle.tasks.map((task) =>
    ManifestTaskSchema.parse({
      ...task,
      sourceRef: task.sourceRef ?? `local:${task.id}`,
    }),
  );
  return {
    source: {
      kind: "local",
      location: absolute,
      contentHash: sha256Text(raw),
      fetchedAt: new Date().toISOString(),
    },
    tasks,
  };
}

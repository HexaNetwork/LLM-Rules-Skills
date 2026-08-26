import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { outputContractFor, invokeModeFor } from "../../src/domain/agent-roles.js";
import {
  buildDocsWriterInput,
  extractGlossaryPreamble,
  formatGlossaryMarkdown,
  loadGlossaryContext,
  mergeGlossaryDelta,
  parseGlossaryMarkdown,
  slugFromTitle,
  writeDocsWriterArtifacts,
} from "../../src/domain/docs-writer.js";
import { maxAgentTokensFor } from "../../src/domain/settings.js";
import { DEFAULT_SETTINGS } from "../../src/domain/settings.js";
import { createPacketService } from "../../src/plugins/packets.js";
import { checkTokenCap } from "../../src/worker/invoke.js";

describe("buildDocsWriterInput", () => {
  it("slims the brief and omits the fog register", () => {
    const packet = buildDocsWriterInput({
      brief: {
        confirmed: "## Goal\n\nShip faster",
        structured: {
          restatement: "ignored when confirmed is set",
          goal: "ignored",
          unknowns: ["should not appear"],
        },
      },
      resolutions: { users: "end-users" },
      fogResolutions: [{ id: "fog-1", source: "user", reason: "decided" }],
      plan: "1. Build\n2. Verify",
      existingGlossary: [{ term: "Run", definition: "A harness execution." }],
    });
    expect(packet.brief).toBe("## Goal\n\nShip faster");
    expect(packet).not.toHaveProperty("fog");
    expect(packet.resolutions).toEqual({ users: "end-users" });
    expect(packet.plan).toBe("1. Build\n2. Verify");
    expect(packet.existingGlossary).toEqual([{ term: "Run", definition: "A harness execution." }]);
    expect(packet.instruction).toContain("delta glossary");
  });

  it("falls back to structured brief fields when confirmed text is absent", () => {
    const packet = buildDocsWriterInput({
      brief: {
        structured: {
          restatement: "Add status endpoint",
          goal: "Expose health",
          inScope: ["GET /status"],
          outOfScope: ["auth"],
          assumptions: ["single process"],
          unknowns: ["should not leak"],
        },
      },
    });
    expect(packet.brief).toEqual({
      restatement: "Add status endpoint",
      goal: "Expose health",
      inScope: ["GET /status"],
      outOfScope: ["auth"],
      assumptions: ["single process"],
    });
  });
});

describe("glossary helpers", () => {
  it("parses, merges, and writes glossary and PRD artifacts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docs-writer-"));
    const existing = `# CivCraft Emperor

Shared language for gameplay.

## Language

**Run**:
An existing execution.
`;
    await writeFile(path.join(dir, "GLOSSARY.md"), existing, "utf8");

    const merged = mergeGlossaryDelta(parseGlossaryMarkdown(existing), [
      { term: "Run", definition: "Updated execution definition." },
      { term: "Status", definition: "Health signal for the service." },
    ]);
    expect(merged.map((entry) => entry.term)).toEqual(["Run", "Status"]);
    expect(merged.find((entry) => entry.term === "Run")?.definition).toContain("Updated");

    const paths = await writeDocsWriterArtifacts(dir, {
      glossary: [
        { term: "Run", definition: "Updated execution definition." },
        { term: "Status", definition: "Health signal for the service." },
      ],
      title: "Add Status Endpoint",
      body: "Acceptance: GET /status returns 200.",
    });
    expect(paths.prdPath).toContain(path.join("docs", "prd", `${slugFromTitle("Add Status Endpoint")}.md`));
    const glossary = await readFile(paths.glossaryPath, "utf8");
    expect(glossary).toContain("# CivCraft Emperor");
    expect(glossary).toContain("Shared language for gameplay.");
    expect(glossary).toContain("**Status**:");
    expect(glossary).toContain("Updated execution definition.");
    const prd = await readFile(paths.prdPath, "utf8");
    expect(prd).toContain("# Add Status Endpoint");
    expect(prd).toContain("GET /status returns 200");
  });

  it("formats glossary markdown consistently", () => {
    const markdown = formatGlossaryMarkdown([
      { term: "Order", definition: "A customer request.", avoid: ["Purchase"] },
    ]);
    expect(markdown).toContain("**Order**:");
    expect(markdown).toContain("_Avoid_: Purchase");
  });

  it("preserves an existing glossary preamble when rewriting entries", () => {
    const preamble = extractGlossaryPreamble(`# CivCraft Emperor

Shared language.

## Language

**Run**:
Existing.
`);
    const markdown = formatGlossaryMarkdown(
      [{ term: "Status", definition: "Health signal." }],
      preamble,
    );
    expect(markdown).toContain("# CivCraft Emperor");
    expect(markdown).toContain("Shared language.");
    expect(markdown).toContain("**Status**:");
    expect(markdown).not.toContain("**Run**:");
  });

  it("passes only referenced or capped existing glossary context", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docs-writer-context-"));
    const terms = Array.from({ length: 30 }, (_, index) => ({
      term: `Term${index}`,
      definition: `Definition ${index}.`,
    }));
    await writeFile(path.join(dir, "GLOSSARY.md"), formatGlossaryMarkdown(terms), "utf8");

    const referenced = await loadGlossaryContext(dir, {
      confirmed: "We need Term5 and Term7 aligned.",
    });
    expect(referenced.map((entry) => entry.term)).toEqual(["Term5", "Term7"]);

    const capped = await loadGlossaryContext(dir, { confirmed: "No overlap with glossary terms." });
    expect(capped).toHaveLength(24);
  });
});

describe("invoke mode and token caps", () => {
  it("uses a combined glossary and PRD output contract", () => {
    expect(outputContractFor("docs-writer")).toContain("glossary");
    expect(outputContractFor("docs-writer")).toContain("title:string,body:string");
  });

  it("routes docs-writer through completion mode", () => {
    expect(invokeModeFor("docs-writer")).toBe("completion");
    expect(invokeModeFor("implementer")).toBe("agent");
  });

  it("resolves per-role agent token caps from settings", () => {
    expect(maxAgentTokensFor("docs-writer", DEFAULT_SETTINGS)).toBe(50_000);
    expect(
      maxAgentTokensFor(
        "implementer",
        {
          ...DEFAULT_SETTINGS,
          budgets: { ...DEFAULT_SETTINGS.budgets, maxAgentTokens: 250_000 },
        },
      ),
    ).toBe(250_000);
  });

  it("warns when usage exceeds the configured cap", () => {
    const warned = checkTokenCap("docs-writer", {
      inputTokens: 40_000,
      outputTokens: 20_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 60_000,
    }, 50_000);
    expect(warned).toBe(true);
    expect(checkTokenCap("docs-writer", undefined, 50_000)).toBe(false);
  });
});

describe("packet routing", () => {
  it("routes docs-writer to the configured small model with a token cap", () => {
    const packet = createPacketService().build({
      role: "docs-writer",
      runId: "run-docs",
      phase: "prd",
      input: buildDocsWriterInput({ brief: "Ship it" }),
      settings: {
        ...DEFAULT_SETTINGS,
        models: { default: "large-model", small: "small-model" },
      },
    });
    expect(packet.model).toBe("small-model");
    expect(packet.maxAgentTokens).toBe(50_000);
  });
});

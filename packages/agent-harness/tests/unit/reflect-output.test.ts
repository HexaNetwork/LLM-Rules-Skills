import { describe, expect, it } from "vitest";
import {
  REFLECT_EXPECTED_OUTPUT,
  REFLECT_ROLE_RULES,
  ReflectOutputSchema,
  formatReflectRestatement,
} from "../../src/domain/reflect.js";
import { renderDashboardPage } from "../../src/ui/page.js";
import { buildCursorInvokePrompt } from "../../src/worker/invoke.js";

const sample = {
  proposedTitle: "Add editable reflect",
  summary: "Restated",
  restatement: "Add editable reflect before grill.",
  goal: "Confirm shared understanding",
  users: ["operators"],
  inScope: ["editable brief"],
  outOfScope: ["wayfinding"],
  assumptions: ["HITL continues in the dashboard"],
  unknowns: ["PRD generation later"],
};

describe("ReflectOutputSchema", () => {
  it("accepts a reflector restatement payload", () => {
    const parsed = ReflectOutputSchema.parse(sample);
    expect(parsed.proposedTitle).toBe("Add editable reflect");
    expect(parsed.restatement).toContain("editable reflect");
    expect(parsed.users).toEqual(["operators"]);
    expect(parsed.inScope).toEqual(["editable brief"]);
    expect(parsed.outOfScope).toEqual(["wayfinding"]);
    expect(parsed.assumptions).toEqual(["HITL continues in the dashboard"]);
    expect(parsed.unknowns).toEqual(["PRD generation later"]);
  });

  it("accepts reflector output without proposedTitle for older on-disk runs", () => {
    const parsed = ReflectOutputSchema.parse({
      summary: "Restated",
      restatement: "Legacy brief without a title field.",
      goal: "Stay loadable",
      users: [],
      inScope: [],
      outOfScope: [],
      assumptions: [],
      unknowns: [],
    });
    expect(parsed.proposedTitle).toBeUndefined();
  });

  it("rejects a missing restatement", () => {
    expect(() =>
      ReflectOutputSchema.parse({
        summary: "Restated",
        goal: "Confirm shared understanding",
        users: [],
        inScope: [],
        outOfScope: [],
        assumptions: [],
        unknowns: [],
      }),
    ).toThrow();
  });
});

describe("formatReflectRestatement", () => {
  it("builds a markdown brief with Goal, Users, In scope, Out of scope, Assumptions, and Unknowns", () => {
    expect(formatReflectRestatement(sample)).toBe(
      [
        "Add editable reflect before grill.",
        "",
        "## Goal",
        "",
        "Confirm shared understanding",
        "",
        "## Users",
        "",
        "- operators",
        "",
        "## In scope",
        "",
        "- editable brief",
        "",
        "## Out of scope",
        "",
        "- wayfinding",
        "",
        "## Assumptions",
        "",
        "- HITL continues in the dashboard",
        "",
        "## Unknowns",
        "",
        "- PRD generation later",
      ].join("\n"),
    );
  });

  it("renders empty list sections as None", () => {
    const formatted = formatReflectRestatement({
      summary: "Restated",
      restatement: "Legacy brief without a title field.",
      goal: "Stay loadable",
      users: [],
      inScope: [],
      outOfScope: [],
      assumptions: [],
      unknowns: [],
    });
    expect(formatted).toContain("## Users\n\n_None._");
    expect(formatted).toContain("## In scope\n\n_None._");
    expect(formatted).toContain("## Out of scope\n\n_None._");
    expect(formatted).toContain("## Assumptions\n\n_None._");
    expect(formatted).toContain("## Unknowns\n\n_None._");
  });
});

describe("live reflector prompt contract", () => {
  it("keeps the structured expected-output contract in the live prompt", () => {
    expect(REFLECT_EXPECTED_OUTPUT).toContain("proposedTitle:string");
    expect(REFLECT_EXPECTED_OUTPUT).toContain("restatement:string");
    expect(REFLECT_EXPECTED_OUTPUT).toContain("users:[string]");
    expect(REFLECT_ROLE_RULES.some((rule) => rule.includes("concise imperative feature title"))).toBe(true);
    const prompt = buildCursorInvokePrompt({
      role: "reflector",
      packet: {
        role: "reflector",
        input: { idea: "Add a health check" },
        guidance: "lexical guidance",
      },
    });
    expect(prompt).toContain("Role: reflector");
    expect(prompt).toContain("lexical guidance");
    expect(prompt).toContain("concise imperative feature title");
    expect(prompt).toContain("Do not ask grilling questions");
    expect(prompt).toContain(REFLECT_EXPECTED_OUTPUT);
    expect(prompt).toMatch(/Return (exactly )?one raw JSON object/i);
    expect(prompt).not.toContain("Markdown deliverable");
  });
});

describe("dashboard reflector editor", () => {
  it("uses proposedTitle for the run label and edits reflect sections by field", () => {
    const html = renderDashboardPage();
    expect(html).toContain("reflect.proposedTitle");
    expect(html).toContain("data-reflect-field");
  });

  it("embeds a parseable script (no template-literal newline escapes)", () => {
    const html = renderDashboardPage();
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
    expect(script).toContain('raw.join("\\n")');
  });
});

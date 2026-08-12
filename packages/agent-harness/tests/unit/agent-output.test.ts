import { describe, expect, it } from "vitest";
import { parseOutput, resolveAgentOutput } from "../../src/agent.js";

describe("resolveAgentOutput", () => {
  it("prefers the latest parseable candidate among CreatePlan bodies and result text", () => {
    const older = '{"summary":"from older plan","value":1}';
    const newer = '{"summary":"from newer plan","value":2}';
    const result = '{"summary":"from result","value":3}';

    expect(resolveAgentOutput(result, [older, newer])).toEqual({
      raw: result,
      parsed: { summary: "from result", value: 3 }});
    expect(resolveAgentOutput("", [older, newer])).toEqual({
      raw: newer,
      parsed: { summary: "from newer plan", value: 2 }});
    expect(resolveAgentOutput("not json", [older])).toEqual({
      raw: older,
      parsed: { summary: "from older plan", value: 1 }});
  });

  it("parses fenced CreatePlan bodies the same way as assistant results", () => {
    const fenced = '```json\n{"summary":"planned","readyToPlan":false}\n```';
    expect(resolveAgentOutput("", [fenced]).parsed).toEqual({
      summary: "planned",
      readyToPlan: false});
    expect(parseOutput(fenced)).toEqual({ summary: "planned", readyToPlan: false });
  });

  it("fails when no candidate contains a JSON object", () => {
    expect(() => resolveAgentOutput("", ["not useful"])).toThrow(/no JSON object/);
    expect(() => resolveAgentOutput("")).toThrow(/no JSON object/);
  });

  it("parses fenced JSON whose string values contain nested code fences", () => {
    const body = {
      status: "resolved",
      summary: "done",
      resolution: "Add to Town.java:\n\n```java\nint x = 1;\n```\n\nVerified.",
      routeClear: true};
    const fenced = `\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
    expect(parseOutput(fenced)).toEqual(body);
    expect(resolveAgentOutput(fenced).parsed).toEqual(body);
  });

  it("parses fenced JSON surrounded by prose and later non-json fences", () => {
    const body = { status: "resolved", summary: "done", routeClear: true };
    const output = [
      "# Report heading",
      "",
      `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``,
      "",
      "## Key files",
      "",
      "```mermaid",
      "flowchart TD",
      '  a{"decision?"} --> b["step"]',
      "```"].join("\n");
    expect(parseOutput(output)).toEqual(body);
  });

  it("ignores braces and quotes inside JSON string values when finding the object end", () => {
    const body = { summary: "use {curly} and \"quoted\" } text", value: 7 };
    expect(parseOutput(JSON.stringify(body))).toEqual(body);
    expect(parseOutput(`prefix prose ${JSON.stringify(body)} trailing prose`)).toEqual(body);
  });

  it("parses an unclosed json fence by scanning from the first brace", () => {
    const body = { summary: "unclosed fence", readyToPlan: false };
    expect(parseOutput(`\`\`\`json\n${JSON.stringify(body)}`)).toEqual(body);
  });
});

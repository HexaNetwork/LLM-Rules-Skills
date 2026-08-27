import { describe, expect, it } from "vitest";
import { ClarifyStep } from "../../src/workflows/clarify.js";
import { SpecifyStep } from "../../src/workflows/specify.js";
import { ProvisionEnvironmentStep } from "../../src/workflows/provision.js";

const input = { previous: {}, runInput: { idea: "Build a thing" }, effectiveConfig: { runnerImage: "runner:test" }, outputs: {} };

const reflectOutput = {
  proposedTitle: "Build a thing",
  summary: "Build a thing",
  restatement: "Build a thing for operators.",
  goal: "Deliver the capability",
  users: ["operators"],
  inScope: ["core flow"],
  outOfScope: ["nice-to-haves"],
  assumptions: ["Existing repo"],
  unknowns: ["Exact UI"],
};

describe("pure workflow steps", () => {
  it("clarifies through an editable gate and resumed question session", () => {
    const step = new ClarifyStep(); const started = step.start(input); expect(started.type).toBe("invoke-agent");
    if (started.type !== "invoke-agent") return;
    const brief = step.onAgent(started.state, { turnId: "t", sessionId: "reflect", output: reflectOutput }); expect(brief.type).toBe("await-user");
    if (brief.type !== "await-user") return;
    expect(brief.gate.reflect?.goal).toBe("Deliver the capability");
    const grill = step.onUser(brief.state, { gateId: brief.gate.id, answers: { goal: "Edited goal", restatement: reflectOutput.restatement, users: "operators", inScope: "core flow", outOfScope: "nice-to-haves", assumptions: "Existing repo", unknowns: "Exact UI" } }); expect(grill.type).toBe("invoke-agent");
    if (grill.type !== "invoke-agent") return;
    const questions = step.onAgent(grill.state, { turnId: "g", sessionId: "grill-session", output: { resolved: false, questions: [{ id: "q", prompt: "Question?" }], clarifiedBrief: {} } });
    expect(questions.type).toBe("await-user"); if (questions.type !== "await-user") return;
    const resumed = step.onUser(questions.state, { gateId: questions.gate.id, answers: { q: "answer" } }); expect(resumed.type).toBe("invoke-agent");
    if (resumed.type === "invoke-agent") expect(resumed.request.sessionId).toBe("grill-session");
  });

  it("specify requires an exact approve decision", () => {
    const step = new SpecifyStep(); const started = step.start(input); if (started.type !== "invoke-agent") throw new Error();
    const gate = step.onAgent(started.state, { turnId: "t", sessionId: "s", output: { glossary: "g", plan: "p", requirements: "r", scenarios: "s", approvedSpecification: {} } });
    expect(gate.type).toBe("await-user"); if (gate.type !== "await-user") return;
    expect(step.onUser(gate.state, { gateId: gate.gate.id, answers: { decision: "approve" } }).type).toBe("complete");
  });

  it("uses an explicit environment spec without an agent turn", () => {
    const spec = { containerfile: "FROM runner:test\n", setupCommands: [], healthcheckCommands: [], caches: [] };
    const transition = new ProvisionEnvironmentStep().start({ ...input, effectiveConfig: { runnerImage: "runner:test", environmentSpec: spec } });
    expect(transition.type).toBe("run-command");
  });
});

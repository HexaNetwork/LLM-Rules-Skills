import { describe, expect, it } from "vitest";

import { renderDashboard } from "../../src/ui/app.js";

describe("dashboard document", () => {
  it("emits valid browser JavaScript", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("contains the centralized workflow surfaces", () => {
    const html = renderDashboard();

    expect(html).toContain("New run");
    expect(html).toContain("Knowledge base");
    expect(html).toContain("RAG inspector");
    expect(html).toContain("Manual RAG query");
    expect(html).toContain("newRunFeedback");
    expect(html).toContain("Charting route");
    expect(html).toContain("Resume run");
    expect(html).toContain("Use Graphify");
    expect(html).toContain("graphify:$(\"graphify\").checked");
    expect(html).toContain("Dashboard work does not continue automatically after a restart");
    expect(html).toContain("Human decision needed");
    expect(html).toContain("Our recommendation:");
    expect(html).toContain("data-question-choice");
    expect(html).toContain("Inspect session");
    expect(html).toContain("Actual submitted input");
    expect(html).toContain("Work packet");
    expect(html).toContain("Raw session record");
    expect(html).toContain("data-session");
    expect(html).toContain("session-dialog");
    expect(html).toContain("wayfinding episode");
    expect(html).toContain("Context mode");
    expect(html).toContain("Project settings");
    expect(html).toContain("settingsBtn");
    expect(html).toContain("data-setting-key");
    expect(html).toContain("Active runs keep their frozen configuration");
    expect(html).toContain("Thinking…");
  });

  it("preserves HITL editing state across background polling", () => {
    const html = renderDashboard();

    expect(html).toContain("answerDrafts");
    expect(html).toContain("preserveEditor && editorIsActive()");
    expect(html).toContain("loadRun(state.selected,false,true,true)");
  });

  it("preserves the expanded fog disclosure across polling renders", () => {
    const html = renderDashboard();

    expect(html).toContain("fogOpen: {}");
    expect(html).toContain("resolutionOpen: {}");
    expect(html).toContain("data-fog-disclosure");
    expect(html).toContain("data-resolution-disclosure");
    expect(html).toContain("state.fogOpen[state.selected] = event.target.open");
    expect(html).toContain("state.fogOpen[s.runId] ? ' open' : ''");
  });

  it("shows human answers before a collapsible resolution", () => {
    const html = renderDashboard();

    expect(html).toContain('turn.speaker === "human"');
    expect(html).toContain("<b>Answer:</b>");
    expect(html).toContain('details class="resolution"');
    expect(html).toContain("+ conversation + resolution + '</article>'");
  });


  it("submits an answer with Shift+Enter", () => {
    const html = renderDashboard();

    expect(html).toContain("event.key === 'Enter' && event.shiftKey");
    expect(html).toContain("answerForm.requestSubmit()");
  });
});

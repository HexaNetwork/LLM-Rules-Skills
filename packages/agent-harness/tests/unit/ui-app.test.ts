import { describe, expect, it } from "vitest";

import { renderDashboard } from "../../src/ui/app.js";

describe("dashboard document", () => {
  it("emits valid browser JavaScript", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("keeps the access token across address-bar cleanup for refresh", () => {
    const html = renderDashboard();

    expect(html).toContain('sessionStorage.getItem("harnessToken")');
    expect(html).toContain('sessionStorage.setItem("harnessToken", token)');
    expect(html).toContain('history.replaceState(null, "", location.pathname)');
    expect(html).toContain('"X-Harness-Token":token');
  });

  it("contains the centralized workflow surfaces", () => {
    const html = renderDashboard();

    expect(html).toContain("New run");
    expect(html).toContain("Starting reflect");
    expect(html).toContain("Knowledge base");
    expect(html).toContain("RAG inspector");
    expect(html).toContain("Manual RAG query");
    expect(html).toContain("newRunFeedback");
    expect(html).toContain("Confirm & continue to grill");
    expect(html).toContain("Resume run");
    expect(html).toContain("Use Graphify");
    expect(html).toContain("graphify:$(\"graphify\").checked");
    expect(html).toContain("Dashboard work does not continue automatically after a restart");
    expect(html).toContain("Confirm feature understanding");
    expect(html).toContain("Our recommendation:");
    expect(html).toContain("data-question-choice");
    expect(html).toContain("Inspect session");
    expect(html).toContain("Actual submitted input");
    expect(html).toContain("Work packet");
    expect(html).toContain("Retrieval audit");
    expect(html).toContain("Raw session record");
    expect(html).toContain("data-session");
    expect(html).toContain("session-dialog");
    expect(html).toContain("grill episode");
    expect(html).toContain("Context mode");
    expect(html).toContain("Project settings");
    expect(html).toContain("settingsBtn");
    expect(html).toContain("data-setting-key");
    expect(html).toContain("Active runs keep their frozen configuration");
    expect(html).toContain("Thinking…");
    expect(html).toContain("draftAnswer");
  });

  it("preserves HITL editing state across background polling", () => {
    const html = renderDashboard();

    expect(html).toContain("answerDrafts");
    expect(html).toContain("preserveEditor && editorIsActive()");
    expect(html).toContain("loadRun(state.selected,false,true,true)");
  });

  it("preserves answer draft editing across polling renders", () => {
    const html = renderDashboard();

    expect(html).toContain("answerDrafts");
    expect(html).toContain("draftAnswer");
    expect(html).toContain("preserveEditor && editorIsActive()");
  });

  it("shows grill resolutions in the decisions tab", () => {
    const html = renderDashboard();

    expect(html).toContain("grillResolutions");
    expect(html).toContain("No grill resolutions yet");
  });


  it("submits an answer with Shift+Enter", () => {
    const html = renderDashboard();

    expect(html).toContain("event.key === 'Enter' && event.shiftKey");
    expect(html).toContain("answerForm.requestSubmit()");
  });
});

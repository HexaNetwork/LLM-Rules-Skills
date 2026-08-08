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
    expect(html).toContain("Cancelling…");
    expect(html).toContain("state.cancelling");
    expect(html).toContain("draftAnswer");
  });

  it("preserves HITL editing state across background polling", () => {
    const html = renderDashboard();

    expect(html).toContain("answerDrafts");
    expect(html).toContain("preserveEditor && (editorIsActive() || batchIsActive())");
    expect(html).toContain("loadRun(state.selected,false,true,true)");
  });

  it("preserves answer draft editing across polling renders", () => {
    const html = renderDashboard();

    expect(html).toContain("answerDrafts");
    expect(html).toContain("draftAnswer");
    expect(html).toContain("preserveEditor && (editorIsActive() || batchIsActive())");
  });

  it("follows the ui-polling contract for silent refresh", () => {
    const html = renderDashboard();

    // Invariant 1: unchanged silent polls skip run re-render entirely.
    expect(html).toContain("detail.unchanged");
    expect(html).toContain("state.signature");
    expect(html).not.toContain("detailFingerprint");
    expect(html).not.toContain("JSON.stringify(detail)");

    // Invariant 2: signature advances only after a successful render.
    expect(html).toMatch(/renderRun\(\);\s*state\.signature = detail\.signature/);

    // Invariant 3: focused HITL editors block silent rewrite.
    expect(html).toContain("if (preserveEditor && (editorIsActive() || batchIsActive())) return;");
    expect(html).toContain("function batchIsActive()");

    // Invariant 4: silent rewrites capture/restore scroll + details chrome.
    expect(html).toContain("captureScrolls");
    expect(html).toContain("restoreScrolls");
    expect(html).toContain('data-scroll-key="brief"');
    expect(html).toContain("data-details-key");
    expect(html).toContain("data-scroll-key=\"' + attr(taskKey + \"-evidence-\" + evidenceIndex)");

    // Invariant 5: sidebar list scroll survives poll-driven rewrites.
    expect(html).toContain("runList.scrollTop = scrollTop");

    // Invariant 6: knowledge view is not replaced by run polling.
    expect(html).toContain("if (state.view === 'runs' && state.selected) loadRun(state.selected,false,true,true)");

    // Poll only while the tab is visible.
    expect(html).toContain("document.visibilityState !== 'visible'");
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

  it("never wires a Ctrl+Enter submit shortcut", () => {
    const html = renderDashboard();

    expect(html).not.toContain("ctrlKey");
    expect(html).not.toContain("metaKey && event.key === 'Enter'");
  });

  it("renders every open question in a batch, not just the active one", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderQuestionBatch(s, activeQuestion)");
    expect(html).toContain('item.status === "open" && item.batchId === batchId');
    expect(html).toContain("renderBatchQuestion(q, i, batch.length)");
    expect(html).toContain('data-batch-question="');
  });

  it("gives each batch question a skip/park control and a submit footer", () => {
    const html = renderDashboard();

    expect(html).toContain("data-batch-skip=");
    expect(html).toContain("Skip for now");
    expect(html).toContain('id="batchCount"');
    expect(html).toContain('id="submitBatchBtn"');
    expect(html).toContain("answered");
  });

  it("blocks submit on an unanswered, unparked question with an inline hint instead of silently auto-parking", () => {
    const html = renderDashboard();

    expect(html).toContain("function submitBatch()");
    expect(html).toContain("missing.push(qid)");
    expect(html).toContain("still need an answer or a Skip");
    // The block path must actually return without submitting.
    expect(html).toMatch(/missing\.push\(qid\)[\s\S]*?if \(missing\.length\) \{[\s\S]*?return;\s*\}/);
  });

  it("offers accept-all-recommendations without auto-submitting", () => {
    const html = renderDashboard();

    expect(html).toContain('id="acceptAllBtn"');
    expect(html).toContain("function acceptAllRecommendations()");
    // Accept-all must only fill state, never submit.
    const fnBody = html.match(/function acceptAllRecommendations\(\) \{[\s\S]*?\n {6}\}/)?.[0] ?? "";
    expect(fnBody).not.toContain("submitBatch(");
    expect(fnBody).not.toContain("runAction(");
  });

  it("tracks a structured optionId selection per question instead of overwriting the textarea", () => {
    const html = renderDashboard();

    expect(html).toContain("data-batch-choice=");
    expect(html).toContain("data-option-id=");
    expect(html).toContain("function selectBatchOption(qid, optionId)");
    expect(html).toContain("state.selectedOptions[qid] = optionId");
    expect(html).toContain("question-option.selected");
    expect(html).toContain("optionId: optionId || undefined");
  });

  it("wires rapid-fire keyboard shortcuts scoped to the focused question container", () => {
    const html = renderDashboard();

    expect(html).toContain("event.target !== container) return;");
    expect(html).toContain("event.key >= '1' && event.key <= '4'");
    expect(html).toContain("focusNextUnanswered(qid)");
    expect(html).toContain("focusAdjacentQuestion(container, 1)");
    expect(html).toContain("focusAdjacentQuestion(container, -1)");
    expect(html).toContain("event.key === 'Escape'");
    expect(html).toContain("toggleParked(container.getAttribute('data-batch-question'), true)");
    expect(html).toContain("keyboard-hint");
  });

  it("renders the open-unknowns fog register with a resolved/open/parked/dropped headline", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderFogCard(s)");
    expect(html).toContain("function fogSummaryLine(unknowns)");
    expect(html).toContain('" resolved · "');
    expect(html).toContain('" open · "');
    expect(html).toContain('" parked · "');
    expect(html).toContain('" dropped"');
    expect(html).toContain('data-details-key="fog-resolved"');
    expect(html).toContain("fog-entry impact-");
  });

  it("folds the open-unknown count into the grill resolutions metric card", () => {
    const html = renderDashboard();

    expect(html).toContain("open unknown(s) remain");
  });

  it("renders a structured section-wise reflect editor when reflectBrief.structured is present, and falls back to raw markdown otherwise", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderReflectEditor(q, s)");
    expect(html).toContain("s.reflectBrief && s.reflectBrief.structured");
    expect(html).toContain('data-reflect-field="restatement"');
    expect(html).toContain('data-reflect-field="goal"');
    expect(html).toContain("reflectListSection(\"users\"");
    expect(html).toContain("reflectListSection(\"inScope\"");
    expect(html).toContain("reflectListSection(\"outOfScope\"");
    expect(html).toContain("reflectListSection(\"assumptions\"");
    expect(html).toContain("reflectListSection(\"unknowns\"");
    expect(html).toContain("Runs created before the structured reflector output existed");
    expect(html).toContain('id="answerForm"');
  });

  it("submits the edited structured reflect payload via the batched answers[] shape", () => {
    const html = renderDashboard();

    expect(html).toContain("event.target.id === 'reflectForm'");
    expect(html).toContain("structured: cleaned");
    expect(html).toContain("answers: [{ questionId: reflectQid, answer: cleaned.restatement, structured: cleaned }]");
  });

  it("shows an operator note box during grilling/awaiting_input with an ask-me-about-this toggle", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderNoteBox(s)");
    expect(html).toContain('id="noteAsUnknown"');
    expect(html).toContain("Ask me about this");
    expect(html).toContain("will be sent with your next answer");
    expect(html).toContain("action: 'note'");
  });

  it("shows pattern-matched remediation copy for common blocked-run causes, with the raw failure kept in a collapsed details", () => {
    const html = renderDashboard();

    expect(html).toContain("function blockedRemediation(stateOrFailure)");
    expect(html).toContain("blockedKind");
    expect(html).toContain("dirty working tree|uncommitted changes");
    expect(html).toContain("CURSOR_API_KEY");
    expect(html).toContain("graphify-out");
    expect(html).toContain("run configuration changed");
    expect(html).toContain("<summary>Raw failure detail</summary>");
    expect(html).toContain('data-force="true"');
    expect(html).toContain("Retry anyway");
    expect(html).toContain("force: true");
  });

  it("shows budget-exhaustion copy for a yielded run instead of the generic paused copy", () => {
    const html = renderDashboard();

    expect(html).toContain("s.yieldedAt");
    expect(html).toContain("Run yielded to its step budget");
    expect(html).toContain("maxStepsPerRun");
    expect(html).not.toMatch(/s\.yieldedAt[\s\S]{0,400}Dashboard work does not continue automatically/);
  });

  it("shows a usage row, ceiling progress bar, and raise-and-retry controls for budget blocks", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderUsageRow(s)");
    expect(html).toContain("function renderUsageBudgetCard(s)");
    expect(html).toContain("total tokens");
    expect(html).toContain("maxRunTokens");
    expect(html).toContain("Raise ceiling and retry");
    expect(html).toContain("raise_budget_retry");
    expect(html).toContain("costIsLowerBound");
  });

  it("names the actual checked-out branch on the commit-then-branch preflight button, with a generic fallback", () => {
    const html = renderDashboard();

    expect(html).toContain("var gitInfo = state.detail.git;");
    expect(html).toContain('currentBranch ? "Commit onto " + currentBranch : "Commit onto the current branch"');
    expect(html).toContain('return "Commit onto the run branch";');
  });

  it("offers Accept current tree and continue for working-tree divergence blocks", () => {
    const html = renderDashboard();

    expect(html).toContain("isTreeDivergence");
    expect(html).toContain('data-action="accept_tree"');
    expect(html).toContain("Accept current tree and continue");
    expect(html).toContain("Working tree diverged|Diverging paths");
  });

  it("shows a base-branch caution, using the existing warning visual vocabulary, only when current === base", () => {
    const html = renderDashboard();

    expect(html).toContain("var onBaseBranch = !!(currentBranch && baseBranch && currentBranch === baseBranch);");
    expect(html).toContain('"btn danger" : "btn primary"');
    expect(html).toContain('"btn danger" : "btn"');
    expect(html).toContain('class="alert warning"');
    expect(html).toContain("is your base branch. Committing onto the current branch lands these changes directly on it.");
    // No caution note at all when onBaseBranch is false.
    expect(html).toMatch(/var cautionNote = onBaseBranch\s*\n\s*\?[\s\S]*?:\s*"";/);
  });

  it("drives the thinking strip's elapsed timer from job.startedAt/queuedAt without a full re-render", () => {
    const html = renderDashboard();

    expect(html).toContain("function startElapsedTimer(sinceValue)");
    expect(html).toContain('state.detail.job.startedAt || state.detail.job.queuedAt');
    expect(html).toContain('id="thinkingElapsed"');
    expect(html).toContain("setInterval(function () {");
  });

  it("surfaces live activity in the thinking strip while a step is in flight", () => {
    const html = renderDashboard();

    expect(html).toContain("state.detail.activity");
    expect(html).toContain("function activityLine(activity)");
    expect(html).toContain("lastStepSummary");
    expect(html).toContain(' · ');
  });

  it("tails steps.jsonl in the session inspector with scroll/details restoration keys", () => {
    const html = renderDashboard();

    expect(html).toContain("data.steps");
    expect(html).toContain("Live steps");
    expect(html).toContain('data-details-key="session-steps"');
    expect(html).toContain('data-scroll-key="session-steps"');
  });
});

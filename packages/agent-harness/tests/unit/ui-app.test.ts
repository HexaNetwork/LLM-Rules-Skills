import { describe, expect, it } from "vitest";

import { renderDashboard } from "../../src/ui/app.js";

describe("dashboard document", () => {
  it("emits valid browser JavaScript", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();
  });

  it("exposes stable data-testid locators for workflow-critical controls", () => {
    const html = renderDashboard();

    expect(html).toContain('data-testid="start-run"');
    expect(html).toContain('data-testid="reflect-form"');
    expect(html).toContain('data-testid="question-batch"');
    expect(html).toContain('data-testid="submit-answers"');
    expect(html).toContain('data-testid="run-status"');
    expect(html).toContain('data-testid="cancel-run"');
    expect(html).toMatch(/Start reflect/);
    expect(html).toMatch(/Submit answers/);
    expect(html).toMatch(/data-action="cancel"[^>]*data-testid="cancel-run"|data-testid="cancel-run"[^>]*data-action="cancel"/);
  });

  it("keeps Cancel available while a mutation job is queued or running", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toMatch(/phase === "queued" \|\| phase === "running"/);
    expect(script).toMatch(
      /phase === "queued" \|\| phase === "running"[\s\S]{0,800}data-action="stop"/,
    );
    expect(script).toMatch(
      /phase === "queued" \|\| phase === "running"[\s\S]{0,800}data-testid="cancel-run"/,
    );
  });

  it("splits and joins string-list settings on real newlines", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(script).toContain(".join('\\n')");
    expect(script).toContain(".split(/\\r?\\n/)");
    expect(script).not.toContain(".join('\\\\n')");
    expect(script).not.toContain(".split(/\\\\r?\\\\n/)");
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
    expect(html).toContain("indexOf('graphify:') === 0 ? 'structural'");
    expect(html).toContain("Start from branch");
    expect(html).toContain('id="baseBranch"');
    expect(html).toContain("Creates the run worktree from this local branch tip");
    expect(html).toContain("Does not switch or clean the project folder");
    expect(html).toContain("fillBaseBranchSelect");
    expect(html).toContain("body.baseBranch = baseBranchSelect.value");
    expect(html).not.toContain("Control checkout is dirty");
    expect(html).not.toContain("run.control_checkout_notice");
    expect(html).toContain("Dashboard work does not continue automatically after a restart");
    expect(html).toContain("Confirm feature understanding");
    expect(html).toContain("Our recommendation:");
    expect(html).toContain("data-question-choice");
    expect(html).toContain("Inspect invocation");
    expect(html).toContain("Actual submitted input");
    expect(html).toContain("Work packet");
    expect(html).toContain("Retrieval audit");
    expect(html).toContain("Raw session record");
    expect(html).toContain("data-session");
    expect(html).toContain("session-dialog");
    expect(html).toContain("provider contexts · invocations");
    expect(html).toContain("Agent activity");
    expect(html).toContain("activity-timeline");
    expect(html).toContain("function renderRunVitals(s)");
    expect(html).toContain("run-vitals");
    expect(html).toContain("Build progress");
    expect(html).toContain("Grill resolutions");
    expect(html).not.toMatch(/model sessions/);
    expect(html).toContain("NEW CONTEXT");
    expect(html).toContain("REUSED CONTEXT");
    expect(html).toContain("context-badge");
    expect(html).toContain("Project settings");
    expect(html).toContain("settingsBtn");
    expect(html).toContain('projectName").title = data.project.root');
    expect(html).toMatch(/Delivery[\s\S]*?Repository[\s\S]*?Branch/);
    expect(html).toContain("data-copy-path");
    expect(html).toContain("copy-path-btn");
    expect(html).toContain("Copy repository path");
    expect(html).toContain("Copy branch name");
    expect(html).toContain("Copy base branch");
    expect(html).toContain("Copy base SHA");
    expect(html).toContain("Copy worktree path");
    expect(html).toContain("bootstrap.project.root");
    expect(html).toContain("data-setting-key");
    expect(html).toContain("Settings apply to new runs. Blocked runs use a reviewed recommended repair");
    expect(html).toContain("Settings freeze into new runs; blocked runs can use an explicit reviewed repair");
    expect(html).not.toContain("Amend this run");
    expect(html).not.toContain("Settings patch (JSON)");
    expect(html).toContain("Recommended configuration repair");
    // Overview grid children without .card span 1/12 columns — amend must be a full-width card.
    expect(html).toContain("Applies to new runs; blocked runs use a reviewed recommended repair");
    expect(html).toContain("Settings saved");
    expect(html).not.toContain("Settings saved for new runs");
    expect(html).toContain('id="settingsScope"');
    expect(html).toContain('settingsScope").textContent = persistence');
    expect(html).toContain("Thinking…");
    expect(html).toContain("Cancelling…");
    expect(html).toContain("state.cancelling = !!(response && response.pending)");
    expect(html).toContain("draftAnswer");
    expect(html).toContain("Stop after task");
    expect(html).toContain("Approve dependency installs");
    expect(html).toContain("Installs observed");
    expect(html).toContain("harnessSoundsMuted");
    expect(html).toContain("set_tdd");
    expect(html).toContain("resolve_installs");
    expect(html).toContain("Grilling complete");
    expect(html).toContain("Send feedback to griller");
    expect(html).toContain("Continue to planning");
    expect(html).toContain("confirm_grill");
    expect(html).toContain("Grilling complete — review before planning");
    expect(html).toContain("!s.grillReady");
    expect(html).toContain("Review high-level plan");
    expect(html).toContain("Approve plan");
    expect(html).toContain("confirm_plan");
    expect(html).toContain("planReady");
    expect(html).toContain("Confirm verification settings");
    expect(html).toContain("confirm_verification");
    expect(html).toContain("confirmVerificationBtn");
    expect(html).toContain("Keep current");
    expect(html).toContain("Verification baseline failed");
    expect(html).toContain("retry_verification_baseline");
    expect(html).toContain("retryVerificationBaselineBtn");
    expect(html).toContain("verificationBaselineReady");
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
    expect(html).toContain("if (state.sidebarHtml === html) return;");
    expect(html).toContain("overflow-anchor:none");
    expect(html).toContain("[data-scroll-key] { overflow-anchor: none; }");

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
    expect(html).toContain("still need an answer, Skip, or Wait what?");
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

  it("exposes a client-only grill options layout preference (columns/rows)", () => {
    const html = renderDashboard();

    expect(html).toContain("harnessGrillOptionsLayout");
    expect(html).toContain("layout-rows");
    expect(html).toContain("function getGrillOptionsLayout()");
    expect(html).toContain("function setGrillOptionsLayout(value)");
    expect(html).toContain("function applyGrillOptionsLayout()");
    expect(html).toContain(">Display</h3>");
    expect(html).toContain("Grill options layout");
    expect(html).toContain("Arrange recommended options as columns or stacked rows");
    expect(html).toContain('id="grill-options-layout"');
    // Client-only: must not use data-setting-key (Save would PUT it to the API).
    expect(html).not.toContain('data-setting-key="grill');
    expect(html).toContain('localStorage.getItem("harnessGrillOptionsLayout")');
    expect(html).toContain('localStorage.setItem("harnessGrillOptionsLayout", layout)');
  });

  it("toggles off a selected grill option when the same option is clicked again", () => {
    const html = renderDashboard();

    expect(html).toContain("if (state.selectedOptions[qid] === optionId)");
    expect(html).toContain("delete state.selectedOptions[qid]");
  });

  it("offers Wait what? clarification that parks via clarifications in the batch submit", () => {
    const html = renderDashboard();

    expect(html).toContain("Wait what?");
    expect(html).toContain("function toggleClarify(qid)");
    expect(html).toContain("data-batch-clarify=");
    expect(html).toContain("data-batch-clarify-text=");
    expect(html).toContain("clarifications: clarifications");
    expect(html).toContain("state.clarifications");
  });

  it("polls the run job to completion after actions and scrolls to top after answers", () => {
    const html = renderDashboard();

    expect(html).toContain("function waitForJob(runId)");
    expect(html).toContain("job.status === 'failed'");
    expect(html).toContain("function scrollMainToTop()");
    expect(html).toContain("if (action === 'answer') scrollMainToTop()");
    expect(html).toContain("pinScrollTop");
    expect(html).toContain("function releaseScrollTopPin()");
    expect(html).toContain("if (state.pinScrollTop && window.scrollY > 0) releaseScrollTopPin()");
    // Reflect confirm / grill batch can queue a long job — scroll must not wait for it.
    const earlyScroll = html.indexOf("if (action === 'answer') scrollMainToTop()");
    const waitForJobCall = html.indexOf("result = await waitForJob(state.selected)");
    expect(earlyScroll).toBeGreaterThan(-1);
    expect(waitForJobCall).toBeGreaterThan(-1);
    expect(earlyScroll).toBeLessThan(waitForJobCall);
    // Grill batch footer is at the bottom of a tall card — scroll before the POST.
    const batchScroll = html.indexOf("scrollMainToTop();\n      runAction('answer'");
    expect(batchScroll).toBeGreaterThan(-1);
    expect(html).toContain("state.scrolls.windowY = 0");
    expect(html).toContain("Action completed");
  });

  it("labels both dirty-tree preflight buttons with and retry for legacy-shared only", () => {
    const html = renderDashboard();

    expect(html).toContain('workspaceKind === "legacy-shared"');
    expect(html).toContain("' and retry</button>'");
    expect(html).toContain("Committed-base worktree");
    expect(html).not.toContain("' instead</button>'");
  });

  it("uses multi-line textareas and auto-grow for the structured reflect editor", () => {
    const html = renderDashboard();

    expect(html).toContain("function autoGrowTextarea(node)");
    expect(html).toContain("function autoGrowReflectFields()");
    expect(html).toContain('min-height:220px');
    expect(html).toContain("reflect-goal");
    expect(html).toContain("<textarea data-reflect-list=");
    expect(html).toContain('data-reflect-index="\' + index + \'" rows="1"');
    expect(html).toContain(".reflect-list-row textarea { flex:1; min-height:42px;");
    expect(html).not.toContain('<input type="text" value="\' + attr(value)');
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
    expect(html).toContain('data-details-key="fog-dropped"');
    expect(html).toContain("fog-entry impact-");
  });

  it("shows grill resolutions as a count with open-unknowns as a separate muted line", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderRunVitals(s)");
    expect(html).toContain(" open · ");
    expect(html).toContain(" in register");
    expect(html).toContain("decisions locked in");
    expect(html).not.toContain("grillTotal + (unknowns.length ? '<span class=\"faint\"> / ' + unknowns.length");
  });

  it("renders a structured section-wise reflect editor when reflectBrief.structured is present, and falls back to raw markdown otherwise", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderReflectEditor(q, s)");
    expect(html).toContain("s.reflectBrief && s.reflectBrief.structured");
    expect(html).toContain('data-reflect-field="restatement"');
    expect(html).toContain('data-reflect-field="goal"');
    expect(html).toContain("reflectListSection(\"users\"");
    expect(html).toContain("Feature title");
    expect(html).toContain('id="reflectProposedTitle"');
    expect(html).toContain("proposedTitle: structured.proposedTitle");
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
    expect(html).toContain("proposedTitle: trim(d.proposedTitle)");
    expect(html).toContain("Feature title, restatement, and goal cannot be empty");
    expect(html).toContain("structured: cleaned");
    expect(html).toContain("answers: [{ questionId: reflectQid, answer: cleaned.restatement, structured: cleaned }]");
  });

  it("prefers proposedTitle for sidebar and run heading labels", () => {
    const html = renderDashboard();

    expect(html).toContain("shortTitle(run.title || run.idea || run.destination || run.runId, 62)");
    expect(html).toContain("shortTitle(proposedTitle || s.idea, 96)");
    expect(html).toContain("(run.title || \"\") + \" \" + run.idea");
  });

  it("shows worktree, base SHA, and branch pending in delivery status", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(script).toContain("branch pending");
    expect(script).toContain("Base SHA");
    expect(script).toContain("Worktree");
    expect(script).toContain("state.detail.workspace");
    expect(script).not.toContain("Not created yet");
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
    expect(html).toContain("not a git repository");
    expect(html).toContain("CURSOR_API_KEY");
    expect(html).toContain("graphify-out");
    expect(html).toContain("run configuration changed");
    expect(html).toContain("draft a configuration repair");
    expect(html).toContain("<summary>Raw failure detail</summary>");
    // Silent polls rewrite #content; without a stable key, open chrome snaps shut.
    expect(html).toContain('data-details-key="raw-failure"');
    expect(html).toContain('data-force="true"');
    expect(html).toContain("Retry anyway");
    expect(html).toContain("force: true");
    // Expanding Raw failure detail must not reflow the side "Not retriable" actions.
    expect(html).toContain(".alert > :first-child { flex:1 1 auto; min-width:0;");
    expect(html).toContain('class="alert-actions"');
  });

  it("shows paused-run resume copy without step-budget yield messaging", () => {
    const html = renderDashboard();

    expect(html).toContain("This run is paused");
    expect(html).toContain("Dashboard work does not continue automatically");
    expect(html).not.toContain("Run yielded to its step budget");
    expect(html).not.toContain("maxStepsPerRun");
    expect(html).not.toContain("s.yieldedAt");
  });

  it("shows a usage row, ceiling progress bar, and raise-and-retry controls for budget blocks", () => {
    const html = renderDashboard();

    expect(html).toContain("function renderUsageRow(s)");
    expect(html).toContain("function renderUsageBudgetCard(s)");
    expect(html).toContain("function renderBudgetMeter(label, usedLabel, limitLabel, pct)");
    expect(html).toContain("function renderUsageBreakdown(sessions, runTotal)");
    expect(html).toContain("function aggregateSessionUsage(sessions, key)");
    expect(html).toContain("total tokens");
    expect(html).toContain("Token budget");
    expect(html).toContain("Cost budget");
    expect(html).toContain("budget-meter");
    expect(html).toContain("By model");
    expect(html).toContain("By agent type");
    expect(html).toContain(">Thinking</th>");
    expect(html).toContain("reasoningTokens");
    expect(html).toContain("data-usage-tab");
    expect(html).toContain("usageTab");
    expect(html).toContain("maxRunTokens");
    expect(html).toContain("Raise ceiling and retry");
    expect(html).toContain("raise_budget_retry");
    expect(html).toContain("costIsLowerBound");
  });

  it("wires usage breakdown mini-tabs so By agent type switches aggregation", () => {
    const html = renderDashboard();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    // Buttons alone are not enough — clicks must set state.usageTab and re-render.
    expect(script).toMatch(/target\.dataset\.usageTab/);
    expect(script).toMatch(/state\.usageTab\s*=\s*target\.dataset\.usageTab/);
    // Preserve the enclosing <details open> across remount (capture → render → restore).
    expect(script).toMatch(
      /state\.usageTab\s*=\s*target\.dataset\.usageTab[\s\S]{0,120}captureScrolls\(\)[\s\S]{0,40}renderRun\(\)[\s\S]{0,40}restoreScrolls\(\)/,
    );
  });

  it("labels preflight commit orders as Branch then commit / Commit then branch", () => {
    const html = renderDashboard();

    expect(html).toContain('order === "commit-then-branch" ? "Commit then branch" : "Branch then commit"');
    expect(html).toContain('data-action="cleanup"');
    expect(html).toContain('data-action="migrate_workspace"');
  });

  it("offers Accept current tree and continue for working-tree divergence blocks", () => {
    const html = renderDashboard();

    expect(html).toContain("isTreeDivergence");
    expect(html).toContain('data-action="accept_tree"');
    expect(html).toContain("Accept current tree and continue");
    expect(html).toContain("Working tree diverged|Workspace diverged|Diverging paths");
  });

  it("hides the blocked error card while a recovery job is in flight", () => {
    const html = renderDashboard();

    expect(html).toContain('if (s.phase === "blocked" && !state.detail.job)');
    expect(html).toContain('jobAction === "commit_preflight"');
    expect(html).toContain("Committing the working tree and retrying");
    expect(html).toContain("state.detail.job = response.job");
  });

  it("offers Ignore buttons for diverging/unreported paths and lists ignored artifacts in settings", () => {
    const html = renderDashboard();

    expect(html).toContain("function parseBlockedPaths(failureText)");
    expect(html).toContain("Ignore these paths");
    expect(html).toContain('data-action="ignore_artifacts"');
    expect(html).toContain("data-ignore-path=");
    expect(html).toContain("Ignore all listed paths");
    expect(html).toContain("Ignored build artifacts");
    expect(html).toContain("data-remove-artifact-index=");
    expect(html).toContain("function removeIgnoredArtifact(index)");
    expect(html).toContain('git.ignoredArtifactPatterns');
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

  it("shows the base branch on a line above the preflight commit buttons", () => {
    const html = renderDashboard();

    expect(html).toContain('Base branch: <code>\' + esc(baseBranch) + \'</code>');
    expect(html).toContain("var baseBranchLine = baseBranch");
    expect(html).toContain("baseBranchLine +");
    expect(html).toContain('class="preflight-commit-actions"');
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

  it("pins error alerts at the top until dismissed", () => {
    const html = renderDashboard();

    expect(html).toContain('id="toastDismiss"');
    expect(html).toMatch(/\.toast\s*\{[^}]*top:\s*\d+px/);
    expect(html).toContain("function hideToast()");
    expect(html).toContain("if (!error)");
    expect(html).toContain('toastDismiss").hidden = !error');
  });

  it("renders run-view errors inline under the vitals row instead of the top toast", () => {
    const html = renderDashboard();

    // Slot is mounted between the vitals and the tabs.
    expect(html).toContain('html += renderRunVitals(s);');
    expect(html).toMatch(/renderRunVitals\(s\);\s*html \+= '<div id="runErrorSlot">'/);
    expect(html).toContain("function renderInlineError()");
    expect(html).toContain("state.inlineError");
    expect(html).toContain('id="runErrorDismiss"');
    expect(html).toContain('role="alert"');
    // toast() routes errors to the inline slot when the run view is rendered.
    expect(html).toContain("if (error && showRunError(message))");
    // Switching runs or leaving the run view clears the sticky error.
    expect(html).toContain('if (!sameRun) state.inlineError = "";');
    expect(html).toContain("state.detail = null; state.inlineError = \"\";");
  });

  it("marks blocked or failed runs with a red warning indicator in the sidebar", () => {
    const html = renderDashboard();

    expect(html).toContain('class="run-warn"');
    expect(html).toContain('phase === "blocked" || phase === "failed"');
    expect(html).toMatch(/\.run-warn\s*\{[^}]*color:var\(--red\)/);
    expect(html).toMatch(/\.run-title > span\s*\{[^}]*text-overflow:ellipsis/);
  });

  it("keeps long unbroken tokens inside activity context rows (no horizontal spill)", () => {
    const html = renderDashboard();
    const contextRule = html.match(/\.activity-context\s*\{([^}]*)\}/)?.[1] ?? "";

    // Flex/grid children default to min-width:auto, so unbroken package/path
    // tokens can force the row wider than its track and paint outside the border.
    expect(contextRule).toMatch(/min-width:\s*0/);
  });
});

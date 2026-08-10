/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderRunScript = `    function renderSidebar() {
      var runList = $("runList");
      var scrollTop = runList ? runList.scrollTop : 0;
      var needle = state.filter.toLowerCase();
      var runs = state.runs.filter(function (run) { return !needle || ((run.title || "") + " " + run.idea + " " + (run.destination || "") + " " + run.runId).toLowerCase().includes(needle); });
      runList.innerHTML = runs.length ? runs.map(function (run) {
        var phase = effectivePhase(run);
        var title = shortTitle(run.title || run.idea || run.destination || run.runId, 62);
        var progress = run.taskProgress && run.taskProgress.total ? run.taskProgress.completed + "/" + run.taskProgress.total : phaseLabel(phase);
        return '<button class="run-item ' + (run.runId === state.selected && state.view === "runs" ? "active" : "") + '" data-run="' + attr(run.runId) + '"><div class="run-title"><i class="dot ' + attr(phase) + '"></i><span>' + esc(title) + '</span></div><div class="run-meta"><span>' + esc(progress) + '</span><span>' + esc(ago(run.updatedAt)) + '</span></div></button>';
      }).join("") : '<div class="empty" style="padding:25px 10px">No matching runs</div>';
      // Unreadable runs are listed, not hidden: a run silently missing from this
      // list is indistinguishable from a run the harness lost.
      (state.unreadableRuns || []).forEach(function (failure) {
        runList.innerHTML += '<div class="run-item" style="cursor:default" title="' + attr(failure.error) + '"><div class="run-title"><i class="dot blocked"></i><span>' + esc(shortTitle(failure.runId, 62)) + '</span></div><div class="run-meta"><span>unreadable state.json</span></div></div>';
      });
      runList.scrollTop = scrollTop;
    }

    function renderHome() {
      $("crumbTitle").textContent = "Overview"; $("topActions").innerHTML = "";
      $("content").innerHTML = '<div class="hero"><div><div class="eyebrow">Durable delivery control plane</div><h1>One idea.<br>Every decision.<br>A finished feature.</h1><p class="hero-copy">Reflect the idea, grill until shared understanding, hand clean context between agents, and watch deterministic tests turn red into green—all without losing the thread.</p><p><button class="btn primary" data-open-new>Start your first run →</button></p></div><div class="hero-card"><div class="card-label">The route</div><h2>Clarity before code</h2><div class="route"><div class="route-step"><b>01</b><span>Reflect and confirm the brief</span></div><div class="route-step"><b>02</b><span>Grill the open decisions</span></div><div class="route-step"><b>03</b><span>Plan tracer-bullet tasks</span></div><div class="route-step"><b>04</b><span>Test, implement, review</span></div><div class="route-step"><b>05</b><span>Commit and publish</span></div></div></div></div>';
    }

    function renderRun() {
      if (!state.detail) return;
      var s = state.detail.state;
      var summary = state.runs.find(function (run) { return run.runId === s.runId; }) || {};
      var phase = state.detail.job ? state.detail.job.status : s.phase;
      var brief = s.reflectBrief;
      var proposedTitle = brief && ((brief.confirmedStructured && brief.confirmedStructured.proposedTitle) || (brief.structured && brief.structured.proposedTitle)) || "";
      var title = shortTitle(proposedTitle || s.idea, 96);
      $("crumbTitle").textContent = title;
      $("topActions").innerHTML = actionButtons(s, phase);
      var tabs = ["overview","decisions","tasks","sessions","artifacts"];
      var fullIdea = String(s.idea || "");
      var subtitle = title !== fullIdea ? '<div class="subtitle">' + esc(fullIdea) + '</div>' : '';
      var html = '<div class="title-row"><div><div class="eyebrow">Run ' + esc(s.runId.slice(0,8)) + '</div><h1>' + esc(title) + '</h1>' + subtitle + '</div><span class="badge ' + attr(phase) + '" data-testid="run-status"><i class="dot ' + attr(phase) + '"></i>' + esc(phaseLabel(phase)) + '</span></div>';
      html += renderUsageRow(s);
      html += '<nav class="tabs">' + tabs.map(function (tab) { return '<button class="tab ' + (state.tab === tab ? "active" : "") + '" data-tab="' + tab + '">' + tab[0].toUpperCase() + tab.slice(1) + '</button>'; }).join("") + '</nav><div id="tabBody"></div>';
      $("content").innerHTML = html;
      if (state.tab === "overview") renderOverview(s, summary, phase);
      else if (state.tab === "decisions") renderDecisions(s);
      else if (state.tab === "tasks") renderTasks(s);
      else if (state.tab === "sessions") renderSessions();
      else renderArtifacts();
    }

    function actionButtons(s, phase) {
      if (state.cancelling && s.phase !== "cancelled") {
        return '<span class="badge running"><i class="dot running"></i>Cancelling…</span>';
      }
      // Keep Cancel available while a mutation job is queued/running — cancel is
      // out-of-band and must not wait for the job badge to clear.
      if (phase === "queued" || phase === "running") {
        var busy = '<span class="badge ' + phase + '"><i class="dot ' + phase + '"></i>' + phase + '</span>';
        // Stop is also out-of-band: allow requesting a graceful halt while a job
        // is in flight (mid-task), not only when the header is idle.
        if (s.phase === "executing" && !s.stoppedAfterTaskAt) {
          busy += s.stopAfterTask
            ? '<span class="badge running"><i class="dot running"></i>Stopping after task…</span>'
            : '<button class="btn small" data-action="stop" title="Finish the current task, then halt">Stop after task</button>';
        }
        if (!["completed","cancelled"].includes(s.phase)) {
          busy += '<button class="btn small danger" data-action="cancel" data-testid="cancel-run">Cancel</button>';
        }
        return busy;
      }
      var out = "";
      if (s.stoppedAfterTaskAt || (!["completed","cancelled","awaiting_input","blocked"].includes(s.phase))) {
        out += '<button class="btn small primary" data-action="resume">Resume run</button>';
      }
      if (s.phase === "executing" && !s.stoppedAfterTaskAt) {
        out += s.stopAfterTask
          ? '<span class="badge running"><i class="dot running"></i>Stopping after task…</span>'
          : '<button class="btn small" data-action="stop" title="Finish the current task, then halt">Stop after task</button>';
      }
      if (s.phase === "blocked" && !state.detail.job) {
        out += s.blockedRetriable === false
          ? '<button class="btn small primary" data-action="retry" data-force="true">Retry anyway</button>'
          : '<button class="btn small primary" data-action="retry">Retry</button>';
      }
      if (!["completed","cancelled"].includes(s.phase)) out += '<button class="btn small danger" data-action="cancel" data-testid="cancel-run">Cancel</button>';
      if (s.pullRequestUrl) out += '<a class="btn small primary" target="_blank" rel="noreferrer" href="' + attr(safeUrl(s.pullRequestUrl)) + '">Open PR ↗</a>';
      return out;
    }

    function parseBlockedPaths(failureText) {
      var text = String(failureText || "");
      var match = /(?:Diverging paths|changed unreported paths):\\s*(.+)$/im.exec(text);
      if (!match) return [];
      var raw = String(match[1] || "").trim();
      if (!raw || raw.indexOf("(HEAD") === 0) return [];
      return raw.split(/,\\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
    }

    // Prefer blockedKind; fall back to message patterns for runs blocked before classification.
    function blockedRemediation(stateOrFailure) {
      var kind = stateOrFailure && typeof stateOrFailure === "object" ? stateOrFailure.blockedKind : undefined;
      var text = String((stateOrFailure && typeof stateOrFailure === "object" ? stateOrFailure.failure : stateOrFailure) || "");
      var byKind = {
        workspace: { title: "A workspace problem is blocking this run",
          hint: "Fix the working tree, missing graph, or unreported paths, then retry the transition." },
        provider: { title: "The agent backend failed transiently",
          hint: "Check credentials and provider health, then retry. Automatic provider retries were already exhausted for this step." },
        config: { title: "The run configuration cannot be resumed as-is",
          hint: "Review the recommended repair below, restore the original configuration, or start a new run. Use Retry anyway only if you accept the drift." },
        budget: { title: "A run budget ceiling was reached",
          hint: "Raise the frozen run ceiling below, then retry. Retrying without raising the limit will hit the same block." },
        contract: { title: "The model could not satisfy the required contract",
          hint: "Inspect the failure detail, adjust the task or prompts if needed, then retry." },
        internal: { title: "The harness hit an internal error",
          hint: "This is unlikely to clear on retry. Capture the failure detail and file a bug, or Retry anyway only to unblock." }
      };
      if (/Working tree diverged|Diverging paths/i.test(text)) {
        return {
          id: "tree-divergence",
          title: "The working tree diverged from the harness's last known state",
          hint: "Inspect the unexpected changes. Accept the current tree to continue from here, or restore the tree and retry.",
        };
      }
      if (/not a git repository/i.test(text)) {
        return {
          id: "not-a-git-repo",
          title: "This project is not a git repository",
          hint: "Run git init and make an initial commit in the project folder, or set git.enabled: false in agent-harness.config.yaml, then retry.",
        };
      }
      if (kind && byKind[kind]) return byKind[kind];
      var patterns = [
        { id: "dirty-tree",
          test: /dirty working tree|uncommitted changes|working tree is not clean/i,
          title: "The working tree has uncommitted changes",
          hint: "Commit or stash local changes in the repository, then retry the transition." },
        { test: /CURSOR_API_KEY|agent backend (is )?unavailable|missing.*api.?key/i,
          title: "The agent backend is unavailable",
          hint: "Set the required credential (e.g. CURSOR_API_KEY) in the terminal running the harness, then restart the dashboard and retry." },
        { test: /graphify-out[\\\\/]graph\\.json|graphify graph|missing graph/i,
          title: "The Graphify repository graph is missing",
          hint: "Run Graphify's setup for this repository so graphify-out/graph.json exists, then retry." },
        { test: /run configuration changed|configurationHash|resume with the persisted run config/i,
          title: "The run configuration changed since this run started",
          hint: "A hashed run setting drifted from this run's frozen snapshot. Restore that frozen policy, draft a configuration repair, or start a new run." }
      ];
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test.test(text)) return patterns[i];
      }
      return { title: "The current transition could not complete", hint: "Review the failure detail below, resolve the underlying issue, then retry." };
    }

    function formatConfigRepair(patch) {
      var rows = [];
      var workflow = patch && patch.workflow || {};
      var commands = patch && patch.commands || {};
      var git = patch && patch.git || {};
      if (workflow.testPathPatterns) rows.push('<li>Recognize <code>' + esc(workflow.testPathPatterns.length) + ' test path pattern' + (workflow.testPathPatterns.length === 1 ? '' : 's') + '</code></li>');
      if (commands.test) rows.push('<li>Use <code>' + esc(commands.test) + '</code> as the test command</li>');
      if (workflow.maxGrillQuestionsPerEpisode != null) rows.push('<li>Set the grill-question limit to <code>' + esc(workflow.maxGrillQuestionsPerEpisode) + '</code></li>');
      if (workflow.staleAnswerMinutes != null) rows.push('<li>Set stale-answer timeout to <code>' + esc(workflow.staleAnswerMinutes) + ' minutes</code></li>');
      if (workflow.grillQuestionsPerBatch != null) rows.push('<li>Set grill questions per batch to <code>' + esc(workflow.grillQuestionsPerBatch) + '</code></li>');
      if (git.autoCommitPreflight != null) rows.push('<li>' + (git.autoCommitPreflight ? 'Enable' : 'Disable') + ' automatic preflight commits</li>');
      if (git.preflightCommitOrder) rows.push('<li>Use <code>' + esc(git.preflightCommitOrder) + '</code> for preflight commits</li>');
      if (git.ignoredArtifactPatterns) rows.push('<li>Update ignored generated-artifact paths</li>');
      return rows.length
        ? '<ul class="faint" style="margin:10px 0 0;padding-left:20px">' + rows.join('') + '</ul>'
        : '<div class="faint" style="margin-top:10px">The repair contains no user-visible setting changes.</div>';
    }

    function fogSummaryLine(unknowns) {
      var resolved = unknowns.filter(function (u) { return u.status === "resolved"; }).length;
      var open = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
      var parked = unknowns.filter(function (u) { return u.status === "parked"; }).length;
      var dropped = unknowns.filter(function (u) { return u.status === "dropped"; }).length;
      return resolved + " resolved · " + open + " open · " + parked + " parked · " + dropped + " dropped";
    }

    function formatCostUsd(usage) {
      if (!usage) return "$0";
      var amount = Number(usage.costUsd || 0);
      var formatted = amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2);
      return (usage.costIsLowerBound ? "≥$" : "$") + formatted;
    }

    function renderUsageRow(s) {
      var usage = s.usage || {};
      var tokens = Number(usage.totalTokens || 0);
      var cached = Number(usage.cacheReadTokens || 0);
      if (!tokens && !(state.detail && state.detail.sessions && state.detail.sessions.length)) {
        return '<div class="usage-row muted">No recorded usage yet</div>';
      }
      var parts = [number(tokens) + " total tokens"];
      if (cached) parts.push(number(cached) + " cached");
      parts.push(formatCostUsd(usage) + (usage.costIsLowerBound ? " (lower bound)" : ""));
      return '<div class="usage-row muted">' + esc(parts.join(" · ")) + '</div>';
    }

    function renderBudgetMeter(label, usedLabel, limitLabel, pct) {
      var clamped = Math.max(0, Math.min(100, Number(pct) || 0));
      return '<div class="budget-meter">' +
        '<div class="budget-meter-head"><span>' + esc(label) + '</span><strong>' + clamped + '%</strong></div>' +
        '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + clamped + '" aria-label="' + attr(label) + '"><i style="width:' + clamped + '%"></i></div>' +
        '<div class="budget-meter-foot">' + esc(usedLabel) + ' / ' + esc(limitLabel) + '</div>' +
        '</div>';
    }

    function sessionTotalTokens(usage) {
      if (!usage) return 0;
      if (usage.totalTokens != null) return Number(usage.totalTokens || 0);
      return Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0);
    }

    function aggregateSessionUsage(sessions, key) {
      var map = {};
      (sessions || []).forEach(function (session) {
        var label = String(session[key] || "unknown");
        var usage = session.usage || {};
        if (!map[label]) {
          map[label] = { label: label, sessions: 0, input: 0, output: 0, thinking: 0, cached: 0, total: 0 };
        }
        var row = map[label];
        row.sessions += 1;
        row.input += Number(usage.inputTokens || 0);
        row.output += Number(usage.outputTokens || 0);
        row.thinking += Number(usage.reasoningTokens || 0);
        row.cached += Number(usage.cacheReadTokens || 0);
        row.total += sessionTotalTokens(usage);
      });
      return Object.keys(map).map(function (name) { return map[name]; }).sort(function (a, b) {
        return b.total - a.total || a.label.localeCompare(b.label);
      });
    }

    function renderUsageBreakdownTable(rows, labelHeader, runTotal) {
      if (!rows.length) {
        return '<div class="muted" style="margin-top:4px">No session usage recorded yet.</div>';
      }
      var body = rows.map(function (row) {
        var share = runTotal > 0 ? Math.round((row.total / runTotal) * 1000) / 10 : 0;
        return '<tr>' +
          '<td><code>' + esc(row.label) + '</code></td>' +
          '<td class="num">' + number(row.sessions) + '</td>' +
          '<td class="num">' + number(row.input) + '</td>' +
          '<td class="num">' + number(row.output) + '</td>' +
          '<td class="num">' + number(row.thinking) + '</td>' +
          '<td class="num">' + number(row.cached) + '</td>' +
          '<td class="num"><strong>' + number(row.total) + '</strong></td>' +
          '<td class="num faint">' + share + '%</td>' +
          '</tr>';
      }).join("");
      return '<div class="usage-table-wrap"><table class="usage-table">' +
        '<thead><tr>' +
        '<th>' + esc(labelHeader) + '</th><th class="num">Sessions</th><th class="num">Input</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">Cached</th><th class="num">Total</th><th class="num">Share</th>' +
        '</tr></thead><tbody>' + body + '</tbody></table></div>';
    }

    function renderUsageBreakdown(sessions, runTotal) {
      var active = state.usageTab === "role" ? "role" : "model";
      var rows = active === "role"
        ? aggregateSessionUsage(sessions, "role")
        : aggregateSessionUsage(sessions, "model");
      var labelHeader = active === "role" ? "Agent type" : "Model";
      var tabs = [
        { id: "model", label: "By model" },
        { id: "role", label: "By agent type" }
      ].map(function (tab) {
        return '<button type="button" class="usage-mini-tab' + (active === tab.id ? ' active' : '') + '" data-usage-tab="' + tab.id + '">' + esc(tab.label) + '</button>';
      }).join("");
      return '<details class="usage-breakdown" data-details-key="usage-breakdown">' +
        '<summary>Breakdown by model &amp; agent</summary>' +
        '<div class="usage-mini-tabs" role="tablist">' + tabs + '</div>' +
        renderUsageBreakdownTable(rows, labelHeader, runTotal) +
        '</details>';
    }

    function renderUsageBudgetCard(s) {
      var usage = s.usage || {};
      var ceilings = (state.detail && state.detail.ceilings) || {};
      var sessions = (state.detail && state.detail.sessions) || [];
      var maxTokens = Number(ceilings.maxRunTokens || 0);
      var maxCost = Number(ceilings.maxRunCostUsd || 0);
      if (!maxTokens && !maxCost && !usage.totalTokens && !sessions.length) return "";
      var usedTokens = Number(usage.totalTokens || 0);
      if (!usedTokens && sessions.length) {
        usedTokens = sessions.reduce(function (sum, session) { return sum + sessionTotalTokens(session.usage); }, 0);
      }
      var usedCost = Number(usage.costUsd || 0);
      var tokenPct = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;
      var costPct = maxCost > 0 ? Math.min(100, Math.round((usedCost / maxCost) * 100)) : 0;
      var html = '<div class="card usage-card"><div class="card-label">Usage</div>';
      html += '<div class="metric">' + number(usedTokens) + '<span class="faint"> tokens</span></div>';
      html += '<div class="muted">' + esc(formatCostUsd(usage)) + (usage.costIsLowerBound ? ' · unpriced models omitted from cost' : '') + '</div>';
      if (maxTokens > 0) {
        html += renderBudgetMeter("Token budget", number(usedTokens), number(maxTokens), tokenPct);
      }
      if (maxCost > 0) {
        html += renderBudgetMeter("Cost budget", formatCostUsd(usage), "$" + String(maxCost), costPct);
      }
      if (sessions.length || usedTokens) {
        html += renderUsageBreakdown(sessions, usedTokens);
      }
      html += '</div>';
      return html;
    }

    function renderFogCard(s) {
      var unknowns = s.openUnknowns || [];
      if (!unknowns.length) return "";
      var open = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; });
      var parked = unknowns.filter(function (u) { return u.status === "parked"; });
      var resolved = unknowns.filter(function (u) { return u.status === "resolved"; });
      var openHtml = open.length ? open.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : '<div class="muted">No open unknowns right now.</div>';
      var parkedHtml = parked.length ? '<div class="fog-group-label">Parked</div>' + parked.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : "";
      var resolvedHtml = resolved.length ? '<details data-details-key="fog-resolved"><summary>' + resolved.length + ' resolved</summary>' + resolved.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-title">' + esc(u.title) + '</div></div>';
      }).join("") + '</details>' : "";
      return '<div class="card fog-card"><div class="card-label">Open unknowns</div><p class="fog-summary">' + esc(fogSummaryLine(unknowns)) + '</p>' + openHtml + parkedHtml + resolvedHtml + '</div>';
    }

    function renderNoteBox(s) {
      var notes = s.operatorNotes || [];
      var unconsumed = notes.filter(function (n) { return !n.consumedAt; });
      var list = unconsumed.length ? '<div class="note-list">' + unconsumed.map(function (n) {
        return '<div class="note-item"><b>' + (n.title ? esc(n.title) + ': ' : '') + '</b>' + esc(n.text) + ' <span class="faint">· will be sent with your next answer</span></div>';
      }).join("") + '</div>' : "";
      return '<div class="card note-box"><div class="card-label">Add a constraint or note</div><form id="noteForm"><textarea id="noteText" placeholder="Add a constraint, correction, or context the griller should account for…">' + esc(state.noteText) + '</textarea><div class="note-row"><label><input type="checkbox" id="noteAsUnknown"' + (state.noteAsUnknown ? ' checked' : '') + '> Ask me about this</label><button class="btn small primary" type="submit">Add note</button></div></form>' + list + '</div>';
    }

    function renderVerificationReady(gate) {
      var current = gate.currentSettings || {};
      var proposed = gate.proposedPatch || {};
      var currentTest = (current.commands && current.commands.test) || "";
      var currentPatterns = ((current.workflow && current.workflow.testPathPatterns) || []).join("\\n");
      var proposedTest = (proposed.commands && proposed.commands.test != null)
        ? proposed.commands.test
        : currentTest;
      var proposedPatterns = (proposed.workflow && proposed.workflow.testPathPatterns)
        ? proposed.workflow.testPathPatterns.join("\\n")
        : currentPatterns;
      var draft = state.verificationDraft || {};
      var testValue = draft.testCommand != null ? draft.testCommand : proposedTest;
      var patternsValue = draft.testPathPatterns != null ? draft.testPathPatterns : proposedPatterns;
      var persist = !!draft.persistProjectDefaults;
      return '<div class="card question-card" id="verificationReadyCard"><div class="card-label">Confirm verification settings</div><p class="muted">Before planning, confirm how this run finds and runs tests. Edit the proposal or keep the current settings.</p><div class="resolution" style="margin:10px 0 12px"><strong>Summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div><div class="muted" style="margin-bottom:10px"><strong>Current</strong><div style="margin-top:4px">Test command: <code>' + esc(currentTest) + '</code></div><div style="margin-top:4px">Path patterns: <code>' + esc(currentPatterns.replace(/\\n/g, ", ") || "(none)") + '</code></div></div><form id="verificationReadyForm"><label class="muted" for="verificationTestCommand">Test command</label><input id="verificationTestCommand" type="text" value="' + attr(testValue) + '" style="width:100%;margin:4px 0 10px"><label class="muted" for="verificationTestPatterns">Test path patterns (one per line)</label><textarea id="verificationTestPatterns" rows="4" style="width:100%;margin:4px 0 10px">' + esc(patternsValue) + '</textarea><label style="display:flex;align-items:center;gap:8px;margin:8px 0 12px"><input type="checkbox" id="verificationPersistDefaults"' + (persist ? " checked" : "") + '> Also write these as project defaults</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="keepCurrentVerificationBtn">Keep current</button><button type="button" class="btn primary" id="confirmVerificationBtn">Confirm verification</button></div></form></div>';
    }

    function renderInstallApproval(installs) {
      var rows = installs.map(function (item) {
        var selected = state.installSelections[item.id];
        if (selected == null) selected = "accept";
        return '<div class="install-item"><div class="item-head"><div><strong>' + esc(item.manager) + '</strong> <span class="pkg">' + esc((item.packages || []).join(" ")) + '</span></div></div><div class="muted" style="margin:6px 0 10px">' + esc(item.reason) + '</div><div style="display:flex;gap:14px;flex-wrap:wrap"><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="accept"' + (selected === "accept" ? " checked" : "") + '> Accept</label><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="deny"' + (selected === "deny" ? " checked" : "") + '> Deny</label></div></div>';
      }).join("");
      return '<div class="card question-card" id="installApprovalCard"><div class="card-label">Approve dependency installs</div><p class="muted">The planner proposed these installs before implementation. Accept or deny each item, then continue.</p>' + rows + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="acceptAllInstallsBtn">Accept all</button><button type="button" class="btn" id="denyAllInstallsBtn">Deny all</button><button type="button" class="btn primary" id="submitInstallsBtn">Continue</button></div></div>';
    }

    function renderGrillReady(gate) {
      return '<div class="card question-card" id="grillReadyCard"><div class="card-label">Grilling complete</div><p class="muted">The griller is ready to plan. Continue, or send feedback to reopen the interview.</p><div class="resolution" style="margin:10px 0 12px"><strong>Summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div><form id="grillReadyForm"><label class="muted" for="grillFeedbackText">Optional feedback</label><textarea id="grillFeedbackText" placeholder="Something the griller missed or got wrong…">' + esc(state.grillFeedbackText) + '</textarea><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="sendGrillFeedbackBtn">Send feedback to griller</button><button type="button" class="btn primary" id="continueToPlanningBtn">Continue to planning</button></div></form></div>';
    }

    function renderRunTddControl(s) {
      var locked = ["completed","cancelled"].includes(s.phase);
      var enabled = s.tasks.length ? s.tasks.some(function (t) { return t.tdd; }) : !!(state.bootstrap && state.bootstrap.project && state.bootstrap.project.defaults && state.bootstrap.project.defaults.tdd);
      if (locked) return '<strong>' + (enabled ? "Enabled" : "Disabled") + '</strong>';
      return '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="runTddToggle"' + (enabled ? " checked" : "") + '> <strong>' + (enabled ? "Enabled" : "Disabled") + '</strong></label><div class="faint" style="margin-top:4px">Applies to the run default and pending tasks</div>';
    }

    function renderInstallLogPanel() {
      var entries = (state.detail && state.detail.installLog) || [];
      if (!entries.length) return '';
      var rows = entries.slice(-20).reverse().map(function (entry) {
        return '<div class="install-item"><div class="item-head"><div class="pkg">' + esc(entry.commandSummary || entry.manager || "install") + '</div><span class="tag">' + esc(entry.source || "agent") + '</span></div><div class="faint" style="margin-top:4px">' + esc(entry.role || "") + (entry.taskId ? " · task " + esc(entry.taskId) : "") + (entry.at ? " · " + esc(ago(entry.at)) : "") + '</div></div>';
      }).join("");
      return '<div class="card"><div class="card-label">Installs observed</div><p class="muted" style="margin:0 0 10px">Passive log of package installs seen during agent work (review only).</p>' + rows + '</div>';
    }

    function batchQuestionAnswered(q) {
      if (state.parked[q.id]) return false; // parked counts separately, not "answered"
      if (state.clarifications[q.id] != null) return false; // clarifying counts separately
      if (state.selectedOptions[q.id] != null) return true;
      var draft = state.answerDrafts[q.id];
      return Boolean(draft && draft.trim().length);
    }

    function batchQuestionHandled(q) {
      return Boolean(state.parked[q.id] || state.clarifications[q.id] != null || batchQuestionAnswered(q));
    }

/*__SPLIT_OVERVIEW__*/
    function renderOverview(s, summary, phase) {
      stopElapsedTimer();
      var taskTotal = s.tasks.length, taskDone = s.tasks.filter(function (t) { return t.status === "done"; }).length;
      var grillTotal = (s.grillResolutions || []).length;
      var unknowns = s.openUnknowns || [];
      var openUnknownCount = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
      var percent = taskTotal ? Math.round(taskDone / taskTotal * 100) : (s.phase === "completed" ? 100 : 0);
      var html = '<div class="grid">';
      var activity = state.detail.activity;
      var activityText = activityLine(activity);
      var thinkingSince = activity && activity.startedAt
        ? activity.startedAt
        : (state.detail.job ? (state.detail.job.startedAt || state.detail.job.queuedAt) : null);
      if (state.cancelling && s.phase !== "cancelled") {
        html += '<div class="thinking-strip" role="status" aria-live="polite"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="thinking-copy"><strong>Cancelling…</strong><span>Waiting for the current step to stop</span></div></div>';
      } else if (phase === "queued" || phase === "running") {
        var jobAction = state.detail.job && state.detail.job.action;
        var jobDetail = state.detail.job && state.detail.job.detail;
        var thinkingDetail = phase === "queued"
          ? "Waiting for the current transition to start"
          : jobAction === "index knowledge and reflect"
            ? "Indexing knowledge before the reflector starts"
            : jobAction === "commit_preflight"
              ? "Committing the working tree and retrying"
              : jobAction === "accept_tree"
                ? "Accepting the current tree and continuing"
                : jobAction === "retry"
                  ? "Retrying the blocked transition"
                  : "An agent or deterministic command is working";
        if (jobDetail) thinkingDetail = jobDetail;
        if (activityText) thinkingDetail = activityText;
        if (s.phase === "grilling" && unknowns.length && !activityText) thinkingDetail += " · " + openUnknownCount + " open unknown(s) remain";
        html += '<div class="thinking-strip" role="status" aria-live="polite"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="thinking-copy"><strong>Thinking…</strong><span>' + esc(thinkingDetail) + '</span>' + (thinkingSince && !activityText ? '<span id="thinkingElapsed">' + esc(elapsed(thinkingSince)) + '</span>' : '') + '</div></div>';
      }
      if (s.phase === "awaiting_input") {
        var pendingInstalls = (s.proposedInstalls || []).filter(function (item) { return !item.decision; });
        if (s.verificationReady) {
          html += renderVerificationReady(s.verificationReady);
        } else if (pendingInstalls.length) {
          html += renderInstallApproval(pendingInstalls);
        } else if (s.grillReady) {
          html += renderGrillReady(s.grillReady);
        } else {
          var q = s.questions.find(function (item) { return item.id === s.activeQuestionId; });
          if (q) {
            if (q.purpose === "reflect") html += renderReflectEditor(q, s);
            else html += renderQuestionBatch(s, q);
          }
        }
      }
      if (s.stoppedAfterTaskAt) {
        html += '<div class="card"><div class="alert warning"><div><strong>Stopped after task</strong><div class="muted" style="margin-top:5px">The current task finished and the next frontier task was not started. Resume continues from here. Cancel remains available to abort immediately.</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      } else if (!state.detail.job && !["completed","cancelled","awaiting_input","blocked"].includes(s.phase) && !s.stopAfterTask) {
        html += '<div class="card"><div class="alert"><div><strong>This run is paused</strong><div class="muted" style="margin-top:5px">Dashboard work does not continue automatically after a restart. Resume queues the next transition and refreshes the document index first.</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      }
      if (s.phase === "blocked" && !state.detail.job) {
        var remediation = blockedRemediation(s);
        var failureText = String(s.failure || "");
        var isTreeDivergence = /Working tree diverged|Diverging paths/i.test(failureText);
        var isDirtyTree = !isTreeDivergence && (remediation.id === "dirty-tree" || /dirty working tree|uncommitted changes|working tree is not clean/i.test(failureText));
        var failureDetail = (isDirtyTree || isTreeDivergence)
          ? '<pre style="margin-top:8px">' + esc(s.failure || "") + '</pre>'
          : '<details data-details-key="raw-failure"><summary>Raw failure detail</summary><pre>' + esc(s.failure || "The current transition could not complete.") + '</pre></details>';
        var commitControls = "";
        if (isDirtyTree) {
          var settingsValues = (state.bootstrap && state.bootstrap.project && state.bootstrap.project.settings && state.bootstrap.project.settings.values) || {};
          var defaultOrder = settingsValues["git.preflightCommitOrder"] === "commit-then-branch" ? "commit-then-branch" : "branch-then-commit";
          var otherOrder = defaultOrder === "commit-then-branch" ? "branch-then-commit" : "commit-then-branch";
          var gitInfo = state.detail.git;
          var currentBranch = gitInfo ? gitInfo.currentBranch : null;
          var baseBranch = gitInfo ? gitInfo.baseBranch : null;
          var onBaseBranch = !!(currentBranch && baseBranch && currentBranch === baseBranch);
          var orderLabel = function (order) {
            return order === "commit-then-branch" ? "Commit then branch" : "Branch then commit";
          };
          var defaultBtnClass = defaultOrder === "commit-then-branch" && onBaseBranch ? "btn danger" : "btn primary";
          var otherBtnClass = otherOrder === "commit-then-branch" && onBaseBranch ? "btn danger" : "btn";
          var cautionNote = onBaseBranch
            ? '<div class="alert warning" style="margin-top:10px;padding:10px 12px"><div><strong>Heads up</strong><div class="muted" style="margin-top:3px">' + esc(currentBranch) + ' is your base branch. Committing onto the current branch lands these changes directly on it.</div></div></div>'
            : "";
          var baseBranchLine = baseBranch
            ? '<div class="muted" style="margin-top:10px">Base branch: <code>' + esc(baseBranch) + '</code></div>'
            : "";
          commitControls = baseBranchLine +
            '<div class="preflight-commit-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="' + defaultBtnClass + '" data-action="commit_preflight" data-preflight-order="' + attr(defaultOrder) + '">' + esc(orderLabel(defaultOrder)) + ' and retry</button>' +
            '<button class="' + otherBtnClass + '" data-action="commit_preflight" data-preflight-order="' + attr(otherOrder) + '">' + esc(orderLabel(otherOrder)) + ' and retry</button>' +
            '</div>' + cautionNote;
        }
        var acceptTreeControls = "";
        if (isTreeDivergence) {
          acceptTreeControls = '<div class="accept-tree-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn primary" data-action="accept_tree">Accept current tree and continue</button>' +
            '</div>';
        }
        var ignoreArtifactControls = "";
        var divergingPaths = parseBlockedPaths(failureText);
        var canEditSettings = !!(state.bootstrap && state.bootstrap.project && state.bootstrap.project.settings && state.bootstrap.project.settings.editable);
        if (divergingPaths.length > 0 && (isTreeDivergence || /changed unreported paths/i.test(failureText)) && canEditSettings) {
          ignoreArtifactControls =
            '<div class="ignore-artifacts" style="margin-top:12px">' +
            '<div class="muted" style="margin-bottom:6px"><strong>Ignore these paths</strong> — add build/generated folders to project config (not .gitignore), then accept the tree and continue.</div>' +
            '<div style="display:grid;gap:6px">' +
            divergingPaths.map(function (filePath) {
              return '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">' +
                '<code style="font-size:12px;word-break:break-all">' + esc(filePath) + '</code>' +
                '<button class="btn small" data-action="ignore_artifacts" data-ignore-path="' + attr(filePath) + '">Ignore</button>' +
                '</div>';
            }).join('') +
            '<div style="margin-top:4px"><button class="btn" data-action="ignore_artifacts" data-ignore-paths="' + attr(JSON.stringify(divergingPaths)) + '">Ignore all listed paths</button></div>' +
            '</div></div>';
        }
        var retryControls = "";
        if (s.blockedKind === "budget") {
          var ceilings = (state.detail && state.detail.ceilings) || {};
          var currentTokens = ceilings.maxRunTokens || 0;
          var currentCost = ceilings.maxRunCostUsd || 0;
          var suggestedTokens = Math.max(currentTokens * 2 || 0, Math.ceil((s.usage && s.usage.totalTokens || 0) * 1.5) || 0, 1);
          var suggestedCost = Math.max(currentCost * 2 || 0, Number(((s.usage && s.usage.costUsd || 0) * 1.5).toFixed(4)) || 0);
          retryControls =
            '<div class="budget-raise" style="margin-top:12px;display:grid;gap:8px">' +
            '<div class="muted">Raise the frozen run ceiling, then force-retry. Project config alone will not unblock this run.</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">' +
            '<label style="display:grid;gap:4px"><span class="faint">maxRunTokens</span><input id="raiseMaxRunTokens" type="number" min="0" step="1" value="' + attr(String(suggestedTokens)) + '" style="width:140px"></label>' +
            '<label style="display:grid;gap:4px"><span class="faint">maxRunCostUsd</span><input id="raiseMaxRunCostUsd" type="number" min="0" step="0.01" value="' + attr(String(suggestedCost || currentCost || 0)) + '" style="width:140px"></label>' +
            '<button class="btn primary" data-action="raise_budget_retry">Raise ceiling and retry</button>' +
            '</div></div>';
        } else if (s.blockedRetriable === false) {
          retryControls = '<div class="alert warning" style="margin-top:10px;padding:10px 12px"><div><strong>Not retriable</strong><div class="muted" style="margin-top:3px">This block is classified as <code>' + esc(s.blockedKind || "unknown") + '</code>. Retrying without fixing the cause is unlikely to help.</div></div></div><button class="btn danger" data-action="retry" data-force="true">Retry anyway</button>';
        } else if (!isTreeDivergence) {
          retryControls = '<button class="btn danger" data-action="retry">Retry transition</button>';
        }
        var fixer = s.fixerRecovery;
        var fixerControls = '';
        var isConfigBlock = s.blockedKind === 'config' || /run configuration changed|configurationHash|resume with the persisted run config|configVersion .+ is newer than harness|Test writer changed non-test paths/i.test(String(s.failure || ''));
        if (fixer && fixer.status === 'proposed' && fixer.role === 'config-fixer') {
          var repairDetails = formatConfigRepair(fixer.plan.configPatch || {});
          var persistButton = canEditSettings
            ? '<button class="btn" data-action="apply_fix" data-persist-project-defaults="true" title="Update this run frozen config and write the same patch into agent-harness.config.yaml for future runs">Apply to run + project defaults</button>'
            : '';
          fixerControls = '<strong>Recommended configuration repair</strong><div class="muted" style="margin-top:5px">' + esc(fixer.plan.summary) + '</div>' +
            repairDetails +
            '<div class="field" style="margin-top:10px"><label for="fixerGuidance">Tweak the plan</label><textarea id="fixerGuidance" rows="2" placeholder="Optional revised instructions for the config fixer"></textarea></div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button class="btn" data-action="propose_fix" data-revise-fix="true">Revise recommendation</button><button class="btn primary" data-action="apply_fix" title="Update only this run frozen config.json, then resume">Apply to this run only</button>' + persistButton + '</div>';
        } else if (fixer && fixer.status === 'proposed') {
          var fixerSteps = (fixer.plan.steps || []).map(function (step) { return '<li><strong>' + esc(step.title) + '</strong><div class="muted">' + esc(step.description) + '</div></li>'; }).join('');
          var fixerRisks = (fixer.plan.risks || []).length ? '<div class="faint" style="margin-top:8px">Risks: ' + esc(fixer.plan.risks.join(' · ')) + '</div>' : '';
          fixerControls = '<strong>Proposed fixer plan</strong><div class="muted" style="margin-top:5px">' + esc(fixer.plan.summary) + '</div><ol style="margin:8px 0 0;padding-left:20px">' + fixerSteps + '</ol>' + fixerRisks + '<div class="field" style="margin-top:10px"><label for="fixerGuidance">Tweak the plan</label><textarea id="fixerGuidance" rows="3" placeholder="Optional revised instructions for the fixer"></textarea></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-action="propose_fix" data-revise-fix="true">Revise plan</button><button class="btn primary" data-action="apply_fix">Approve, fix, and recover</button></div>';
        } else if (isConfigBlock) {
          fixerControls = '<strong>Fix harness configuration</strong><div class="muted" style="margin-top:5px">A focused config fixer will recommend the smallest safe repair. You will review the affected settings before applying it.</div><div class="field" style="margin-top:10px"><label for="fixerGuidance">Recovery guidance</label><textarea id="fixerGuidance" rows="3" placeholder="For example: preserve the existing test and recognize its test folder"></textarea></div><button class="btn" data-action="propose_fix">Draft recommended repair</button>';
        } else {
          fixerControls = '<strong>Fix with an agent</strong><div class="muted" style="margin-top:5px">Describe how you want this handled. The fixer will propose a plan first; it cannot edit until you approve it.</div><div class="field" style="margin-top:10px"><label for="fixerGuidance">Recovery guidance</label><textarea id="fixerGuidance" rows="3" placeholder="For example: preserve the existing test and update the configured test path patterns"></textarea></div><button class="btn" data-action="propose_fix">Draft recovery plan</button>';
        }
        html += '<div class="card"><div class="alert"><div><strong>' + esc(remediation.title) + '</strong><div class="muted" style="margin-top:5px">' + esc(remediation.hint) + '</div><div class="faint" style="margin-top:6px">Stopped from: ' + esc(s.blockedFrom || "unknown") + (s.blockedKind ? ' · kind: ' + esc(s.blockedKind) : '') + '</div>' + failureDetail + commitControls + acceptTreeControls + ignoreArtifactControls + '</div>' + retryControls + '</div><div class="resolution">' + fixerControls + '</div></div>';
      }
      if (["grilling","awaiting_input","planning"].includes(s.phase)) {
        html += renderFogCard(s);
      }
      if (["grilling","awaiting_input"].includes(s.phase) && !s.grillReady) {
        html += renderNoteBox(s);
      }
      var repoRoot = (state.bootstrap && state.bootstrap.project && state.bootstrap.project.root) || "";
      var repoCopyBtn = repoRoot
        ? '<button type="button" class="copy-path-btn" data-copy-path="' + attr(repoRoot) + '" title="Copy path" aria-label="Copy repository path"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg></button>'
        : '';
      html += '<div class="card third"><div class="card-label">Build progress</div><div class="metric">' + taskDone + '<span class="faint"> / ' + taskTotal + '</span></div><div class="muted">implementation tasks done</div><div class="progress"><i style="width:' + percent + '%"></i></div><div class="muted repo-label">Repository' + repoCopyBtn + '</div><div style="margin-top:4px"><code title="' + attr(repoRoot) + '" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(repoRoot || "Unknown") + '</code></div></div>';
      html += '<div class="card third"><div class="card-label">Grill resolutions</div><div class="metric">' + grillTotal + '</div><div class="muted">' + (unknowns.length ? (openUnknownCount + ' open unknown(s) · ' + unknowns.length + ' in register') : 'decisions locked in') + '</div></div>';
      var episode = s.grillEpisode;
      var usage = s.usage || {};
      var tokenTotals = { tokens: Number(usage.totalTokens || 0), cached: Number(usage.cacheReadTokens || 0) };
      if (!tokenTotals.tokens) {
        tokenTotals = state.detail.sessions.reduce(function (acc, session) { var sessionUsage = session.usage || {}; var total = sessionUsage.totalTokens; if (total == null && (sessionUsage.inputTokens != null || sessionUsage.outputTokens != null)) total = Number(sessionUsage.inputTokens || 0) + Number(sessionUsage.outputTokens || 0); acc.tokens += Number(total || 0); acc.cached += Number(sessionUsage.cacheReadTokens || 0); return acc; }, { tokens: 0, cached: 0 });
      }
      var episodeDetail = episode ? ('grill episode ' + episode.number + ' · ' + episode.questionsAnswered + ' answered' + (episode.closedAt ? ' · closed' : ' · active')) : 'bounded grill episodes';
      if (tokenTotals.tokens) episodeDetail += ' · ' + number(tokenTotals.tokens) + ' recorded tokens' + (tokenTotals.cached ? ' (' + number(tokenTotals.cached) + ' served from cache)' : '');
      html += '<div class="card third"><div class="card-label">Sessions</div><div class="metric">' + state.detail.sessions.length + '</div><div class="muted">' + esc(episodeDetail) + '</div><div class="faint" style="margin-top:12px">Updated ' + esc(ago(s.updatedAt)) + '</div></div>';
      html += renderUsageBudgetCard(s);
      var brief = s.reflectBrief;
      var briefTitle = brief && brief.confirmed ? "Confirmed brief" : (brief ? "Draft brief" : "Feature brief");
      var briefBody = brief ? (brief.confirmed || brief.draft) : "The reflector will restate the idea for your confirmation before grilling begins.";
      html += '<div class="card two-thirds"><div class="card-label">' + esc(briefTitle) + '</div><pre class="brief-body" data-scroll-key="brief">' + esc(briefBody) + '</pre></div>';
      html += '<div class="card third"><div class="card-label">Delivery</div><div class="muted">Branch</div><div style="margin:4px 0 13px"><code>' + esc(s.branchName || "Not created yet") + '</code></div><div class="muted">TDD</div><div style="margin-top:4px">' + renderRunTddControl(s) + '</div></div>';
      html += renderInstallLogPanel();
      html += '<div class="card"><div class="card-label">Recent activity</div><div class="timeline">' + (state.detail.events.slice(-10).reverse().map(renderEvent).join("") || '<div class="muted">No events yet.</div>') + '</div></div>';
      html += '</div>';
      $("tabBody").innerHTML = html;
      autoGrowReflectFields();
      if (thinkingSince && $("thinkingElapsed")) startElapsedTimer(thinkingSince);
    }
    function renderEvent(event) { return '<div class="event"><div class="event-name">' + esc(event.type) + '</div><div class="event-time">' + esc(date(event.at)) + '</div></div>'; }

    function renderDecisions(s) {
      var resolutions = s.grillResolutions || [];
      var html = resolutions.length ? '<div class="list">' + resolutions.map(function (item) {
        return '<article class="item"><div class="item-head"><div><div class="item-title">' + esc(item.summary) + '</div><div class="muted" style="margin-top:5px">' + esc(item.question) + '</div></div><span class="badge completed">resolved</span></div><div class="conversation"><div class="turn"><b>Answer:</b> ' + esc(item.answer) + '</div></div></article>';
      }).join("") + '</div>' : '<div class="empty">No grill resolutions yet. Confirm the reflect brief to begin grilling.</div>';
      $("tabBody").innerHTML = html;
    }

    function renderTasks(s) {
      var html = s.tasks.length ? '<div class="list">' + s.tasks.map(function (task, index) {
        var taskKey = task.id || ("task-" + index);
        var criteria = '<ul>' + task.acceptanceCriteria.map(function (criterion) { return '<li>' + esc(criterion) + '</li>'; }).join("") + '</ul>';
        var evidence = task.evidence.length ? '<details data-details-key="' + attr(taskKey + "-evidence") + '"><summary>' + task.evidence.length + ' command result(s)</summary>' + task.evidence.map(function (item, evidenceIndex) { var output = [item.stderr,item.stdout].filter(Boolean).join(String.fromCharCode(10)); return '<div class="evidence"><div class="evidence-head"><span>' + esc(item.purpose) + ' · <code>' + esc(item.command) + '</code></span><strong class="' + (item.passed ? "pass" : "fail") + '">' + (item.passed ? "PASS" : "FAIL") + ' / ' + item.exitCode + '</strong></div>' + (output ? '<pre data-scroll-key="' + attr(taskKey + "-evidence-" + evidenceIndex) + '">' + esc(output.slice(-8000)) + '</pre>' : '') + '</div>'; }).join("") + '</details>' : '';
        var canToggle = task.status === "pending" && task.step === "pending" && !["completed","cancelled"].includes(s.phase);
        var tddControl = canToggle
          ? '<button type="button" class="tag" data-action="set_tdd" data-task-id="' + attr(task.id) + '" data-tdd="' + (task.tdd ? "false" : "true") + '" title="Toggle TDD for this pending task">TDD ' + (task.tdd ? "on" : "off") + ' · click</button>'
          : '<span class="tag" title="TDD is locked once the task starts">TDD ' + (task.tdd ? "on" : "off") + '</span>';
        return '<article class="item"><div class="item-head"><div><div class="card-label">Task ' + String(index + 1).padStart(2,"0") + '</div><div class="item-title">' + esc(task.title) + '</div><div class="muted" style="margin-top:5px">' + esc(task.description) + '</div></div><span class="badge ' + attr(task.status === "done" ? "completed" : task.status) + '">' + esc(task.status + " · " + task.step) + '</span></div><div class="tags">' + tddControl + (task.blockedBy.length ? '<span class="tag">after ' + esc(task.blockedBy.join(", ")) + '</span>' : '') + (task.commitSha ? '<span class="tag">' + esc(task.commitSha.slice(0,8)) + '</span>' : '') + '</div><details data-details-key="' + attr(taskKey + "-criteria") + '"><summary>Acceptance criteria</summary>' + criteria + '</details>' + evidence + (task.failure ? '<div class="resolution" style="border-color:var(--red)">' + esc(task.failure) + '</div>' : '') + '</article>';
      }).join("") + '</div>' : '<div class="empty">Implementation tasks appear after grilling reaches shared understanding.</div>';
      $("tabBody").innerHTML = html;
    }

    function renderSessions() {
      var sessions = state.detail.sessions;
      $("tabBody").innerHTML = sessions.length ? '<div class="session-grid">' + sessions.map(function (session) {
        var usage = session.usage && (session.usage.inputTokens || session.usage.outputTokens) ? (String(session.usage.inputTokens || 0) + ' in' + (session.usage.cacheReadTokens ? ' (' + number(session.usage.cacheReadTokens) + ' cached)' : '') + ' · ' + String(session.usage.outputTokens || 0) + ' out') : 'usage unavailable';
        var summary = session.handoff && session.handoff.summary ? session.handoff.summary : (session.error || 'Session record');
        var contextMode = session.providerSessionReused === true ? ' · continued' : (session.providerSessionReused === false ? ' · fresh' : '');
        return '<article class="session"><div class="item-head"><span class="session-role">' + esc(session.role) + '</span><span class="badge ' + attr(session.status === "completed" ? "completed" : session.status) + '">' + esc(session.status) + '</span></div><div class="session-model">' + esc(session.model) + ' · ' + esc(usage) + esc(contextMode) + '</div><p class="muted">' + esc(summary) + '</p><button class="btn small" data-session="' + attr(session.path) + '">Inspect session</button></article>';
      }).join("") + '</div>' : '<div class="empty">No model sessions have launched yet.</div>';
    }
`;

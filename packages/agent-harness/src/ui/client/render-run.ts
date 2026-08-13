/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderRunScript = `    function renderSidebar() {
      var runList = $("runList");
      var scrollTop = runList ? runList.scrollTop : 0;
      var needle = state.filter.toLowerCase();
      var runs = state.runs.filter(function (run) { return !needle || ((run.title || "") + " " + run.idea + " " + (run.destination || "") + " " + run.runId).toLowerCase().includes(needle); });
      var html = runs.length ? runs.map(function (run) {
        var phase = effectivePhase(run);
        var title = shortTitle(run.title || run.idea || run.destination || run.runId, 62);
        var progress = run.taskProgress && run.taskProgress.total ? run.taskProgress.completed + "/" + run.taskProgress.total : phaseLabel(phase);
        var warn = (phase === "blocked" || phase === "failed")
          ? '<span class="run-warn" title="This run needs attention — open it to see the error" aria-label="Run needs attention">!</span>'
          : "";
        return '<button class="run-item ' + (run.runId === state.selected && state.view === "runs" ? "active" : "") + '" data-run="' + attr(run.runId) + '"><div class="run-title"><i class="dot ' + attr(phase) + '"></i><span>' + esc(title) + '</span>' + warn + '</div><div class="run-meta"><span>' + esc(progress) + '</span><span>' + esc(ago(run.updatedAt)) + '</span></div></button>';
      }).join("") : '<div class="empty" style="padding:25px 10px">No matching runs</div>';
      // Unreadable runs are listed, not hidden: a run silently missing from this
      // list is indistinguishable from a run the harness lost.
      (state.unreadableRuns || []).forEach(function (failure) {
        html += '<div class="run-item" style="cursor:default" title="' + attr(failure.error) + '"><div class="run-title"><i class="dot blocked"></i><span>' + esc(shortTitle(failure.runId, 62)) + '</span><span class="run-warn" title="This run needs attention — open it to see the error" aria-label="Run needs attention">!</span></div><div class="run-meta"><span>unreadable state.json</span></div></div>';
      });
      // Skip the rewrite when nothing changed — innerHTML churn vs scrollTop
      // restore is what trips Chrome's scroll-anchoring warning.
      if (state.sidebarHtml === html) return;
      state.sidebarHtml = html;
      runList.innerHTML = html;
      runList.scrollTop = scrollTop;
    }

    function renderInlineError() {
      if (!state.inlineError) return "";
      return '<div class="alert run-error" role="alert"><div class="run-error-message">' + esc(state.inlineError) + '</div><button type="button" class="toast-dismiss" id="runErrorDismiss" aria-label="Dismiss">×</button></div>';
    }

    function renderHome() {
      state.inlineError = "";
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
      var tabs = [
        { id: "overview", label: "Overview" },
        { id: "decisions", label: "Decisions" },
        { id: "tasks", label: "Tasks" },
        { id: "activity", label: "Agent activity" },
        { id: "artifacts", label: "Artifacts" },
      ];
      if (state.tab === "sessions") state.tab = "activity";
      var fullIdea = String(s.idea || "");
      var subtitle = title !== fullIdea ? '<div class="subtitle">' + esc(fullIdea) + '</div>' : '';
      var html = '<div class="title-row"><div><div class="eyebrow">Run ' + esc(s.runId.slice(0,8)) + '</div><h1>' + esc(title) + '</h1>' + subtitle + '</div><span class="badge ' + attr(phase) + '" data-testid="run-status"><i class="dot ' + attr(phase) + '"></i>' + esc(phaseLabel(phase)) + '</span></div>';
      html += renderRunVitals(s);
      html += '<div id="runErrorSlot">' + renderInlineError() + '</div>';
      html += '<nav class="tabs">' + tabs.map(function (tab) { return '<button class="tab ' + (state.tab === tab.id ? "active" : "") + '" data-tab="' + tab.id + '">' + esc(tab.label) + '</button>'; }).join("") + '</nav><div id="tabBody"></div>';
      $("content").innerHTML = html;
      if (state.tab === "overview") renderOverview(s, summary, phase);
      else if (state.tab === "decisions") renderDecisions(s);
      else if (state.tab === "tasks") renderTasks(s);
      else if (state.tab === "activity") renderAgentActivity();
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
      if (/Working tree diverged|Workspace diverged|Diverging paths/i.test(text)) {
        var componentHint = /HEAD|index|working files/i.test(text)
          ? " The failure names whether HEAD, the index, or working files changed inside this run's worktree."
          : "";
        return {
          id: "tree-divergence",
          title: "This run's worktree diverged from the harness's last known state",
          hint: "Inspect the unexpected changes in this run's worktree. Accept the current tree to continue from here, or restore the tree and retry." + componentHint,
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
      if (commands.verification) rows.push('<li>Use <code>' + esc(commands.verification.length) + '</code> verification command' + (commands.verification.length === 1 ? '' : 's') + '</li>');
      if (commands.testTargetTemplate) rows.push('<li>Use <code>' + esc(commands.testTargetTemplate) + '</code> for targeted tests</li>');
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

    function renderRunVitals(s) {
      var tasks = s.tasks || [];
      var taskTotal = tasks.length;
      var taskDone = tasks.filter(function (t) { return t.status === "done"; }).length;
      var grillTotal = (s.grillResolutions || []).length;
      var unknowns = s.openUnknowns || [];
      var openUnknownCount = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
      var grillMeta = unknowns.length
        ? (openUnknownCount + " open · " + unknowns.length + " in register")
        : (grillTotal ? "decisions locked in" : "none yet");
      var activityTotals = (state.detail && state.detail.agentActivity && state.detail.agentActivity.totals) || {};
      var contextCount = activityTotals.providerContexts != null ? activityTotals.providerContexts : ((state.detail && state.detail.sessions) || []).length;
      var invocationCount = activityTotals.invocations != null ? activityTotals.invocations : ((state.detail && state.detail.sessions) || []).length;
      var items = [
        {
          tab: "tasks",
          label: "Build progress",
          value: taskDone + " / " + taskTotal,
          meta: taskTotal ? "implementation tasks done" : "no tasks yet",
        },
        {
          tab: "decisions",
          label: "Grill resolutions",
          value: String(grillTotal),
          meta: grillMeta,
        },
        {
          tab: "activity",
          label: "Agent activity",
          value: contextCount + " / " + invocationCount,
          meta: "provider contexts · invocations",
        },
      ];
      return '<div class="run-vitals" role="navigation" aria-label="Run vitals">' + items.map(function (item) {
        var active = state.tab === item.tab ? " active" : "";
        return '<button type="button" class="vital' + active + '" data-tab="' + attr(item.tab) + '" title="Open ' + attr(item.label) + '">' +
          '<span class="vital-label">' + esc(item.label) + '</span>' +
          '<span class="vital-value">' + esc(item.value) + '</span>' +
          '<span class="vital-meta">' + esc(item.meta) + '</span>' +
          '</button>';
      }).join("") + '</div>';
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
          map[label] = { label: label, invocations: 0, input: 0, output: 0, thinking: 0, cached: 0, total: 0 };
        }
        var row = map[label];
        row.invocations += 1;
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
        return '<div class="muted" style="margin-top:4px">No invocation usage recorded yet.</div>';
      }
      var body = rows.map(function (row) {
        var share = runTotal > 0 ? Math.round((row.total / runTotal) * 1000) / 10 : 0;
        return '<tr>' +
          '<td><code>' + esc(row.label) + '</code></td>' +
          '<td class="num">' + number(row.invocations) + '</td>' +
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
        '<th>' + esc(labelHeader) + '</th><th class="num">Invocations</th><th class="num">Input</th><th class="num">Output</th><th class="num">Thinking</th><th class="num">Cached</th><th class="num">Total</th><th class="num">Share</th>' +
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
      var cachedTokens = Number(usage.cacheReadTokens || 0);
      if (!cachedTokens && sessions.length) {
        cachedTokens = sessions.reduce(function (sum, session) {
          return sum + Number((session.usage && session.usage.cacheReadTokens) || 0);
        }, 0);
      }
      var usedCost = Number(usage.costUsd || 0);
      var tokenPct = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0;
      var costPct = maxCost > 0 ? Math.min(100, Math.round((usedCost / maxCost) * 100)) : 0;
      var html = '<div class="card usage-card"><div class="card-label">Usage</div>';
      html += '<div class="metric">' + number(usedTokens) + '<span class="faint"> tokens</span></div>';
      html += '<div class="muted">' + number(cachedTokens) + ' cached · ' + esc(formatCostUsd(usage)) + (usage.costIsLowerBound ? ' · unpriced models omitted from cost' : '') + '</div>';
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
      var dropped = unknowns.filter(function (u) { return u.status === "dropped"; });
      var openHtml = open.length ? open.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : '<div class="muted">No open unknowns right now.</div>';
      var parkedHtml = parked.length ? '<div class="fog-group-label">Parked</div>' + parked.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : "";
      var resolvedHtml = resolved.length ? '<details data-details-key="fog-resolved"><summary>' + resolved.length + ' resolved</summary>' + resolved.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-title">' + esc(u.title) + '</div></div>';
      }).join("") + '</details>' : "";
      var droppedHtml = dropped.length ? '<details data-details-key="fog-dropped"><summary>' + dropped.length + ' dropped</summary>' + dropped.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-title">' + esc(u.title) + '</div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") + '</details>' : "";
      return '<div class="card fog-card"><div class="card-label">Open unknowns</div><p class="fog-summary">' + esc(fogSummaryLine(unknowns)) + '</p>' + openHtml + parkedHtml + resolvedHtml + droppedHtml + '</div>';
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
      var currentVerification = ((current.commands && current.commands.verification) || []).map(function (item) { return item.command; }).join("\\n");
      var currentTemplate = (current.commands && current.commands.testTargetTemplate) || "";
      var currentPatterns = ((current.workflow && current.workflow.testPathPatterns) || []).join("\\n");
      var proposedVerification = (proposed.commands && proposed.commands.verification != null)
        ? proposed.commands.verification.map(function (item) { return item.command; }).join("\\n")
        : currentVerification;
      var proposedTemplate = (proposed.commands && proposed.commands.testTargetTemplate != null)
        ? proposed.commands.testTargetTemplate
        : currentTemplate;
      var proposedPatterns = (proposed.workflow && proposed.workflow.testPathPatterns)
        ? proposed.workflow.testPathPatterns.join("\\n")
        : currentPatterns;
      var draft = state.verificationDraft || {};
      var verificationValue = draft.verificationCommands != null ? draft.verificationCommands : proposedVerification;
      var templateValue = draft.testTargetTemplate != null ? draft.testTargetTemplate : proposedTemplate;
      var patternsValue = draft.testPathPatterns != null ? draft.testPathPatterns : proposedPatterns;
      var persist = !!draft.persistProjectDefaults;
      return '<div class="card question-card" id="verificationReadyCard"><div class="card-label">Confirm verification settings</div><p class="muted">Before planning, confirm every command that must pass. Commands run in order.</p><div class="resolution" style="margin:10px 0 12px"><strong>Summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div><div class="muted" style="margin-bottom:10px"><strong>Current</strong><div style="margin-top:4px">Verification: <code>' + esc(currentVerification.replace(/\\n/g, ", ") || "(none)") + '</code></div><div style="margin-top:4px">Target template: <code>' + esc(currentTemplate || "(none)") + '</code></div><div style="margin-top:4px">Path patterns: <code>' + esc(currentPatterns.replace(/\\n/g, ", ") || "(none)") + '</code></div></div><form id="verificationReadyForm"><label class="muted" for="verificationCommands">Verification commands (one per line)</label><textarea id="verificationCommands" rows="4" style="width:100%;margin:4px 0 10px">' + esc(verificationValue) + '</textarea><label class="muted" for="verificationTargetTemplate">Targeted-test template (optional; use {filter})</label><input id="verificationTargetTemplate" type="text" value="' + attr(templateValue) + '" style="width:100%;margin:4px 0 10px"><label class="muted" for="verificationTestPatterns">Test path patterns (one per line)</label><textarea id="verificationTestPatterns" rows="4" style="width:100%;margin:4px 0 10px">' + esc(patternsValue) + '</textarea><label style="display:flex;align-items:center;gap:8px;margin:8px 0 12px"><input type="checkbox" id="verificationPersistDefaults"' + (persist ? " checked" : "") + '> Also write these as project defaults</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="keepCurrentVerificationBtn">Keep current</button><button type="button" class="btn primary" id="confirmVerificationBtn">Confirm verification</button></div></form></div>';
    }

    function renderVerificationBaselineReady(gate) {
      var evidence = gate.evidence || {};
      var draft = state.verificationBaselineDraft || {};
      var testValue = draft.verificationCommand != null ? draft.verificationCommand : (evidence.command || "");
      var persist = !!draft.persistProjectDefaults;
      var output = [evidence.stderr, evidence.stdout].filter(Boolean).join("\\n").slice(-4000);
      return '<div class="card question-card" id="verificationBaselineReadyCard"><div class="card-label">Verification baseline failed</div><p class="muted">The confirmed test command did not pass before planning. Edit the command and retry, or cancel the run.</p><div class="resolution" style="margin:10px 0 12px"><strong>Summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div><div class="muted" style="margin-bottom:10px"><div>Command: <code>' + esc(evidence.command || "") + '</code></div><div style="margin-top:4px">Exit: <code>' + esc(String(evidence.exitCode == null ? "" : evidence.exitCode)) + '</code> · ' + (evidence.passed ? "PASS" : "FAIL") + (evidence.durationMs != null ? " · " + esc(String(evidence.durationMs)) + "ms" : "") + '</div></div>' + (output ? '<pre class="code-block" style="max-height:220px;overflow:auto;margin:0 0 12px">' + esc(output) + '</pre>' : '') + '<form id="verificationBaselineReadyForm"><label class="muted" for="verificationBaselineTestCommand">Test command</label><input id="verificationBaselineTestCommand" type="text" value="' + attr(testValue) + '" style="width:100%;margin:4px 0 10px"><label style="display:flex;align-items:center;gap:8px;margin:8px 0 12px"><input type="checkbox" id="verificationBaselinePersistDefaults"' + (persist ? " checked" : "") + '> Also write this as the project default test command</label><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn primary" id="retryVerificationBaselineBtn">Retry baseline</button></div></form></div>';
    }

    function renderInstallApproval(installs) {
      var rows = installs.map(function (item) {
        var selected = state.installSelections[item.id];
        if (selected == null) selected = "accept";
        return '<div class="install-item"><div class="item-head"><div><strong>' + esc(item.manager) + '</strong> <span class="pkg">' + esc((item.packages || []).join(" ")) + '</span></div></div><div class="muted" style="margin:6px 0 10px">' + esc(item.reason) + '</div><div style="display:flex;gap:14px;flex-wrap:wrap"><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="accept"' + (selected === "accept" ? " checked" : "") + '> Accept</label><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="deny"' + (selected === "deny" ? " checked" : "") + '> Deny</label></div></div>';
      }).join("");
      return '<div class="card question-card" id="installApprovalCard"><div class="card-label">Approve dependency installs</div><p class="muted">The issue slicer proposed these installs before implementation. Accept or deny each item, then continue.</p>' + rows + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="acceptAllInstallsBtn">Accept all</button><button type="button" class="btn" id="denyAllInstallsBtn">Deny all</button><button type="button" class="btn primary" id="submitInstallsBtn">Continue</button></div></div>';
    }

    function renderPlanReady(gate, plan, prd, scenarios) {
      var draft = state.planDraft || {};
      var summary = draft.summary != null ? draft.summary : (plan && plan.summary) || gate.summary || "";
      var problemStatement = draft.problemStatement != null ? draft.problemStatement : (plan && plan.problemStatement) || "";
      var solution = draft.solution != null ? draft.solution : (plan && plan.solution) || "";
      var approach = draft.approach != null ? draft.approach : (plan && plan.approach) || "";
      var constraints = draft.constraints != null ? draft.constraints : ((plan && plan.constraints) || []).join("\\n");
      var outOfScope = draft.outOfScope != null ? draft.outOfScope : ((plan && plan.outOfScope) || []).join("\\n");
      var openQuestions = draft.openQuestions != null ? draft.openQuestions : ((plan && plan.openQuestions) || []).join("\\n");
      var scenarioList = (scenarios || []).map(function (scenario) {
        return '<div class="resolution" style="margin-top:10px"><strong>' + esc(scenario.id) + '</strong> <span class="tag">' + esc(scenario.kind || "") + '</span><div class="muted" style="margin-top:4px">' + esc(scenario.title || "") + '</div><div class="muted" style="margin-top:4px">' + esc(scenario.intent || "") + '</div><div class="faint" style="margin-top:4px">Given ' + esc(scenario.given || "") + ' · When ' + esc(scenario.when || "") + ' · Then ' + esc(scenario.then || "") + '</div></div>';
      }).join("");
      var prdBlock = prd
        ? '<div class="resolution" style="margin:10px 0 12px"><strong>Local PRD</strong><div class="muted" style="margin-top:5px">' + esc(prd.summary || "") + '</div>' + ((prd.userStories || []).length ? '<ol style="margin:8px 0 0;padding-left:20px">' + prd.userStories.map(function (story) { return '<li>' + esc(story) + '</li>'; }).join("") + '</ol>' : '') + '</div>'
        : "";
      var scenariosBlock = scenarioList
        ? '<div class="resolution" style="margin:10px 0 12px"><strong>Test scenarios</strong>' + scenarioList + '</div>'
        : "";
      return '<div class="card question-card" id="planReadyCard"><div class="card-label">Review plan, PRD, and scenarios</div><p class="muted">Edit the plan if needed, then approve. Approving slices implementation tasks from the PRD and scenario register. Feedback discards the plan, PRD, and scenarios and restarts planning.</p><div class="resolution" style="margin:10px 0 12px"><strong>Gate summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div>' + prdBlock + scenariosBlock + '<form id="planReadyForm"><label class="muted" for="planSummary">Summary</label><textarea id="planSummary" rows="2" style="width:100%;margin:4px 0 10px">' + esc(summary) + '</textarea><label class="muted" for="planProblemStatement">Problem statement</label><textarea id="planProblemStatement" rows="3" style="width:100%;margin:4px 0 10px">' + esc(problemStatement) + '</textarea><label class="muted" for="planSolution">Solution</label><textarea id="planSolution" rows="3" style="width:100%;margin:4px 0 10px">' + esc(solution) + '</textarea><label class="muted" for="planApproach">Approach</label><textarea id="planApproach" rows="4" style="width:100%;margin:4px 0 10px">' + esc(approach) + '</textarea><label class="muted" for="planConstraints">Constraints (one per line)</label><textarea id="planConstraints" rows="3" style="width:100%;margin:4px 0 10px">' + esc(constraints) + '</textarea><label class="muted" for="planOutOfScope">Out of scope (one per line)</label><textarea id="planOutOfScope" rows="3" style="width:100%;margin:4px 0 10px">' + esc(outOfScope) + '</textarea><label class="muted" for="planOpenQuestions">Open questions (one per line)</label><textarea id="planOpenQuestions" rows="2" style="width:100%;margin:4px 0 10px">' + esc(openQuestions) + '</textarea><label class="muted" for="planFeedbackText">Optional feedback</label><textarea id="planFeedbackText" placeholder="Something the planner missed or got wrong…">' + esc(state.planFeedbackText) + '</textarea><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="sendPlanFeedbackBtn">Send feedback to planner</button><button type="button" class="btn primary" id="approvePlanBtn">Approve plan</button></div></form></div>';
    }

    function renderPrdReadonly(prd) {
      if (!prd) return "";
      var stories = (prd.userStories || []).map(function (item, index) {
        return '<li>' + esc(item) + '</li>';
      }).join("");
      return '<div class="card" style="margin-bottom:16px"><details data-details-key="local-prd" style="border-top:0;margin-top:0;padding-top:0"><summary class="card-label" style="margin-bottom:0">Local PRD</summary><div style="padding-top:12px"><div class="muted" style="margin-bottom:8px">' + esc(prd.summary || "") + '</div><div class="resolution"><strong>Problem</strong><div class="muted" style="margin-top:4px">' + esc(prd.problemStatement || "") + '</div></div><div class="resolution" style="margin-top:10px"><strong>Solution</strong><div class="muted" style="margin-top:4px">' + esc(prd.solution || "") + '</div></div>' + (stories ? '<div class="resolution" style="margin-top:10px"><strong>User stories</strong><ol style="margin:6px 0 0;padding-left:20px">' + stories + '</ol></div>' : '') + '</div></details></div>';
    }

    function renderBriefReadonly(brief) {
      if (!brief) return "";
      var title = brief.confirmed ? "Confirmed brief" : "Draft brief";
      var body = brief.confirmed || brief.draft || "";
      return '<div class="card" style="margin-bottom:16px"><details data-details-key="reflect-brief" style="border-top:0;margin-top:0;padding-top:0"><summary class="card-label" style="margin-bottom:0">' + esc(title) + '</summary><div style="padding-top:12px"><pre class="brief-body" data-scroll-key="brief" style="margin:0">' + esc(body) + '</pre></div></details></div>';
    }

    function renderGrillReady(gate) {
      return '<div class="card question-card" id="grillReadyCard"><div class="card-label">Grilling complete</div><p class="muted">The griller is ready to plan. Continue, or send feedback to reopen the interview.</p><div class="resolution" style="margin:10px 0 12px"><strong>Summary</strong><div class="muted" style="margin-top:5px">' + esc(gate.summary || "") + '</div></div><form id="grillReadyForm"><label class="muted" for="grillFeedbackText">Optional feedback</label><textarea id="grillFeedbackText" placeholder="Something the griller missed or got wrong…">' + esc(state.grillFeedbackText) + '</textarea><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="sendGrillFeedbackBtn">Send feedback to griller</button><button type="button" class="btn primary" id="continueToPlanningBtn">Continue to planning</button></div></form></div>';
    }

    function renderRunRetrievalToggles() {
      var s = state.detail && state.detail.state;
      var locked = !s || ["completed","cancelled"].includes(s.phase);
      var policy = (state.detail && state.detail.retrievalPolicy) || {};
      var ragOn = policy.rag !== false;
      var graphifyOn = !!policy.graphify;
      if (locked) {
        return '<div style="margin-top:8px"><div><strong>Document RAG:</strong> ' + (ragOn ? "Enabled" : "Disabled") + '</div>' +
          '<div style="margin-top:6px"><strong>Graphify:</strong> ' + (graphifyOn ? "Enabled" : "Disabled") + '</div></div>';
      }
      return '<div style="margin-top:8px">' +
        '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="runRagToggle"' + (ragOn ? " checked" : "") + '> <strong>Document RAG</strong> · ' + (ragOn ? "Enabled" : "Disabled") + '</label>' +
        '<div style="margin-top:8px"><label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="runGraphifyToggle"' + (graphifyOn ? " checked" : "") + '> <strong>Graphify</strong> · ' + (graphifyOn ? "Enabled" : "Disabled") + '</label></div>' +
        '<div class="faint" style="margin-top:4px">Applies to the next agent step</div></div>';
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
      var unknowns = s.openUnknowns || [];
      var openUnknownCount = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
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
                  : jobAction === "confirm_verification"
                    ? "Confirming verification and running the baseline"
                    : jobAction === "retry_verification_baseline"
                      ? "Retrying the verification baseline"
                  : jobAction === "confirm_plan"
                    ? "Slicing issues from the approved plan"
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
        } else if (s.verificationBaselineReady) {
          html += renderVerificationBaselineReady(s.verificationBaselineReady);
        } else if (s.planReady) {
          html += renderPlanReady(s.planReady, s.plan, s.prd, s.scenarios);
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
        var pauseHint = s.phase === "new"
          ? "Setup did not finish. Resume retries Graphify and indexing first."
          : "Dashboard work does not continue automatically after a restart. Resume queues the next transition and refreshes the document index first.";
        html += '<div class="card"><div class="alert"><div><strong>This run is paused</strong><div class="muted" style="margin-top:5px">' + pauseHint + '</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      }
      var workspaceMeta = state.detail.workspace || {};
      if (!state.detail.job && ["completed","cancelled"].includes(s.phase) && workspaceMeta.kind === "git-worktree" && workspaceMeta.worktreePath && !workspaceMeta.removedAt) {
        html += '<div class="card"><div class="alert"><div><strong>Worktree cleanup</strong><div class="muted" style="margin-top:5px">Remove the registered worktree after verifying cleanliness and publication state. State, events, and retained branches stay on disk.</div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button class="btn" data-action="cleanup">Clean up worktree</button><button class="btn danger" data-action="cleanup" data-discard="true">Discard unpublished and clean up</button></div></div></div>';
      }
      if (s.phase === "blocked" && !state.detail.job) {
        var remediation = blockedRemediation(s);
        var failureText = String(s.failure || "");
        var isTreeDivergence = /Working tree diverged|Workspace diverged|Diverging paths/i.test(failureText);
        var isDirtyTree = !isTreeDivergence && (remediation.id === "dirty-tree" || /dirty working tree|uncommitted changes|working tree is not clean/i.test(failureText));
        var failureDetail = (isDirtyTree || isTreeDivergence)
          ? '<pre style="margin-top:8px">' + esc(s.failure || "") + '</pre>'
          : '<details data-details-key="raw-failure"><summary>Raw failure detail</summary><pre>' + esc(s.failure || "The current transition could not complete.") + '</pre></details>';
        var commitControls = "";
        if (isDirtyTree) {
          commitControls =
            '<div class="alert warning" style="margin-top:10px;padding:10px 12px"><div><strong>Committed-base worktree</strong><div class="muted" style="margin-top:3px">Commit or stash changes inside this run\\'s worktree, then retry. Control-checkout dirt is never imported, and preflight commit-order controls are not offered for worktree runs.</div></div></div>';
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
          retryControls = '<div class="alert warning" style="padding:10px 12px"><div><strong>Not retriable</strong><div class="muted" style="margin-top:3px">This block is classified as <code>' + esc(s.blockedKind || "unknown") + '</code>. Retrying without fixing the cause is unlikely to help.</div></div></div><button class="btn danger" data-action="retry" data-force="true">Retry anyway</button>';
        } else if (!isTreeDivergence) {
          retryControls = '<button class="btn danger" data-action="retry">Retry transition</button>';
        }
        if (retryControls) {
          retryControls = '<div class="alert-actions">' + retryControls + '</div>';
        }
        var fixer = s.fixerRecovery;
        var fixerControls = '';
        var isConfigBlock = s.blockedKind === 'config' || /run configuration changed|configurationHash|resume with the persisted run config|configVersion .+ is newer than harness|Test command could not be launched/i.test(String(s.failure || ''));
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
      // Note box is for interview turns only — not plan/verification/install/grill-complete gates.
      var pendingInstallNotes = (s.proposedInstalls || []).some(function (item) { return !item.decision; });
      if (
        ["grilling","awaiting_input"].includes(s.phase) &&
        !s.grillReady &&
        !s.planReady &&
        !s.verificationReady &&
        !s.verificationBaselineReady &&
        !pendingInstallNotes
      ) {
        html += renderNoteBox(s);
      }
      if (["grilling","awaiting_input","planning"].includes(s.phase)) {
        html += renderFogCard(s);
      }
      var repoRoot = (state.bootstrap && state.bootstrap.project && state.bootstrap.project.root) || "";
      function copyPathBtn(value, ariaLabel) {
        if (!value) return "";
        return '<button type="button" class="copy-path-btn" data-copy-path="' + attr(value) + '" title="Copy" aria-label="' + attr(ariaLabel) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg></button>';
      }
      html += renderUsageBudgetCard(s);
      var delivery = state.detail.workspace || {};
      var deliveryBranch = s.branchName || delivery.branchName;
      var deliveryBranchLabel = deliveryBranch || "branch pending";
      var baseBranch = delivery.baseBranch || "";
      var fullBaseSha = delivery.baseSha ? String(delivery.baseSha) : "";
      var baseSha = fullBaseSha ? fullBaseSha.slice(0, 12) : "";
      var worktreePath = delivery.worktreePath || "";
      html += '<div class="card"><div class="card-label">Delivery</div>';
      html += '<div class="muted repo-label">Repository' + copyPathBtn(repoRoot, "Copy repository path") + '</div><div style="margin:4px 0 10px"><code title="' + attr(repoRoot) + '" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(repoRoot || "Unknown") + '</code></div>';
      html += '<div class="muted repo-label">Branch' + copyPathBtn(deliveryBranch, "Copy branch name") + '</div><div style="margin:4px 0 10px"><code>' + esc(deliveryBranchLabel) + '</code></div>';
      if (baseBranch) {
        html += '<div class="muted repo-label">Base branch' + copyPathBtn(baseBranch, "Copy base branch") + '</div><div style="margin:4px 0 10px"><code>' + esc(baseBranch) + '</code></div>';
      }
      if (baseSha) {
        html += '<div class="muted repo-label">Base SHA' + copyPathBtn(fullBaseSha, "Copy base SHA") + '</div><div style="margin:4px 0 10px"><code title="' + attr(fullBaseSha) + '">' + esc(baseSha) + '</code></div>';
      }
      if (worktreePath) {
        html += '<div class="muted repo-label">Worktree' + copyPathBtn(worktreePath, "Copy worktree path") + '</div><div style="margin:4px 0 10px"><code title="' + attr(worktreePath) + '" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(worktreePath) + '</code></div>';
      }
      html += '<div class="muted" style="margin-top:10px">Retrieval</div>' + renderRunRetrievalToggles() + '</div>';
      html += renderInstallLogPanel();
      html += '</div>';
      $("tabBody").innerHTML = html;
      autoGrowReflectFields();
      if (thinkingSince && $("thinkingElapsed")) startElapsedTimer(thinkingSince);
    }

    function renderDecisions(s) {
      var resolutions = s.grillResolutions || [];
      var html = renderBriefReadonly(s.reflectBrief);
      html += resolutions.length ? '<div class="list">' + resolutions.map(function (item) {
        return '<article class="item"><div class="item-head"><div><div class="item-title">' + esc(item.summary) + '</div><div class="muted" style="margin-top:5px">' + esc(item.question) + '</div></div><span class="badge completed">resolved</span></div><div class="conversation"><div class="turn"><b>Answer:</b> ' + esc(item.answer) + '</div></div></article>';
      }).join("") + '</div>' : '<div class="empty">No grill resolutions yet. Confirm the reflect brief to begin grilling.</div>';
      $("tabBody").innerHTML = html;
    }

    function displayActivityRole(role, _taskId) {
      return role || "unknown";
    }

    function renderTasks(s) {
      var html = '';
      if (s.prd && !s.planReady) {
        html += renderPrdReadonly(s.prd);
      }
      html += s.tasks.length ? '<div class="list">' + s.tasks.map(function (task, index) {
        var taskKey = task.id || ("task-" + index);
        var criteria = '<ul>' + task.acceptanceCriteria.map(function (criterion) { return '<li>' + esc(criterion) + '</li>'; }).join("") + '</ul>';
        var evidence = task.evidence.length ? '<details data-details-key="' + attr(taskKey + "-evidence") + '"><summary>' + task.evidence.length + ' command result(s)</summary>' + task.evidence.map(function (item, evidenceIndex) { var output = [item.stderr,item.stdout].filter(Boolean).join(String.fromCharCode(10)); return '<div class="evidence"><div class="evidence-head"><span>' + esc(item.purpose) + ' · <code>' + esc(item.command) + '</code></span><strong class="' + (item.passed ? "pass" : "fail") + '">' + (item.passed ? "PASS" : "FAIL") + ' / ' + item.exitCode + '</strong></div>' + (output ? '<pre data-scroll-key="' + attr(taskKey + "-evidence-" + evidenceIndex) + '">' + esc(output.slice(-8000)) + '</pre>' : '') + '</div>'; }).join("") + '</details>' : '';
        var scenarioTags = (task.scenarioIds || []).map(function (id) { return '<span class="tag">scenario ' + esc(id) + '</span>'; }).join('');
        return '<article class="item"><div class="item-head"><div><div class="card-label">Task ' + String(index + 1).padStart(2,"0") + '</div><div class="item-title">' + esc(task.title) + '</div><div class="muted" style="margin-top:5px">' + esc(task.description) + '</div></div><span class="badge ' + attr(task.status === "done" ? "completed" : task.status) + '">' + esc(task.status + " · " + task.step) + '</span></div><div class="tags">' + scenarioTags + (task.blockedBy.length ? '<span class="tag">after ' + esc(task.blockedBy.join(", ")) + '</span>' : '') + (task.commitSha ? '<span class="tag">' + esc(task.commitSha.slice(0,8)) + '</span>' : '') + '</div><details data-details-key="' + attr(taskKey + "-criteria") + '"><summary>Acceptance criteria</summary>' + criteria + '</details>' + evidence + (task.failure ? '<div class="resolution" style="border-color:var(--red)">' + esc(task.failure) + '</div>' : '') + '</article>';
      }).join("") + '</div>' : '<div class="empty">Implementation tasks appear after grilling reaches shared understanding.</div>';
      $("tabBody").innerHTML = html;
    }

    function formatTokenCount(value) {
      var n = Number(value || 0);
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/\\.0+$/, '').replace(/(\\.[0-9]*?)0+$/, '$1') + 'M';
      if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\\.0$/, '') + 'K';
      return String(n);
    }

    function activityViewMode() {
      return state.activityView === 'contexts' ? 'contexts' : 'sequence';
    }

    function timelineClock(value) {
      if (!value) return '—';
      var iso = String(value);
      if (iso.length >= 19 && iso.charAt(10) === 'T') return iso.slice(11, 19);
      try {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
      } catch (error) {
        return '—';
      }
    }

    function sequenceLabel(sequence) {
      return String(sequence || 0).padStart(2, '0');
    }

    function invocationResultLabel(invocation) {
      var outcome = invocation.outcome || {};
      if (outcome.status) return outcome.status;
      if (invocation.status === 'failed') return 'failed';
      if (invocation.status === 'cancelled') return 'cancelled';
      if (invocation.status === 'running') return 'running';
      if (invocation.handoff && invocation.handoff.summary) {
        var summary = String(invocation.handoff.summary);
        return summary.length > 48 ? summary.slice(0, 45) + '…' : summary;
      }
      return invocation.status || '—';
    }

    function taskTitleForId(taskId) {
      if (!taskId || !state.detail || !state.detail.state || !state.detail.state.tasks) return '';
      var task = state.detail.state.tasks.find(function (item) { return item.id === taskId; });
      return task ? task.title : '';
    }

    function schemaRepairFollowed(invocations, index) {
      var invocation = invocations[index];
      if (!invocation || invocation.status !== 'failed') return false;
      return invocations.slice(index + 1).some(function (candidate) {
        return candidate.invocationId && candidate.invocationId === invocation.invocationId && candidate.invocationKind === 'schema-repair' && candidate.status === 'completed';
      });
    }

    function outcomeSummary(invocation) {
      var outcome = invocation && invocation.outcome;
      if (!outcome) return '';
      var parts = [];
      if (outcome.summary) parts.push(outcome.summary);
      if (outcome.blockingCount) parts.push(outcome.blockingCount + ' blocking');
      if (outcome.repairRoute) parts.push('route ' + outcome.repairRoute);
      return parts.join(' · ');
    }

    function renderInvocationInspectButton(invocation, contextTurn, contextTotal, badge, repaired) {
      return '<button class="btn small" data-session="' + attr(invocation.path) + '" data-context-turn="' + attr(String(contextTurn || 1)) + '" data-context-total="' + attr(String(contextTotal || 1)) + '" data-context-badge="' + attr(badge) + '"' + (repaired ? ' data-display-status="repaired"' : '') + '>Inspect invocation</button>';
    }

    function renderProviderContextActivity(contexts) {
      if (!state.expandedContexts) state.expandedContexts = {};
      var html = '<div class="activity-timeline" data-testid="agent-activity-contexts">';
      contexts.forEach(function (context, contextIndex) {
        var key = context.id || ('ctx-' + contextIndex);
        var expanded = !!state.expandedContexts[key];
        var usage = context.usage || {};
        var totalTokens = usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0));
        var cachedTokens = usage.cacheReadTokens || 0;
        var tokenLabel = formatTokenCount(totalTokens);
        var cachedLabel = cachedTokens ? (formatTokenCount(cachedTokens) + ' cached') : '';
        var durationMs = 0;
        if (context.startedAt && context.endedAt) durationMs = Math.max(0, Date.parse(context.endedAt) - Date.parse(context.startedAt));
        else if (context.startedAt) durationMs = Math.max(0, Date.now() - Date.parse(context.startedAt));
        var durationLabel = durationMs ? ((durationMs / 1000).toFixed(1) + 's') : '—';
        var taskTitle = '';
        var taskId = '';
        (context.invocations || []).some(function (inv) {
          if (!inv.taskId || !state.detail || !state.detail.state || !state.detail.state.tasks) return false;
          var task = state.detail.state.tasks.find(function (item) { return item.id === inv.taskId; });
          if (task) { taskTitle = task.title; taskId = task.id; return true; }
          return false;
        });
        var roleLabel = displayActivityRole(context.role, taskId);
        html += '<article class="activity-context' + (expanded ? ' open' : '') + '" data-context-key="' + attr(key) + '">';
        html += '<button type="button" class="activity-context-head" data-toggle-context="' + attr(key) + '">';
        html += '<div class="item-head"><div><div class="session-role">' + esc(roleLabel) + (taskTitle ? ' · ' + esc(taskTitle) : '') + '</div>';
        html += '<div class="session-model">' + esc(context.model || 'unknown') + '</div>';
        html += '<div class="muted">1 provider context · ' + esc(String(context.invocationCount || 0)) + ' invocations / turns</div></div>';
        html += '<span class="badge ' + attr(context.status === 'completed' ? 'completed' : context.status) + '">' + esc(context.status || 'unknown') + '</span></div>';
        html += '<div class="muted" style="margin-top:8px">' + esc(durationLabel) + ' · ' + esc(tokenLabel) + ' tokens' + (cachedLabel ? ' · ' + esc(cachedLabel) : '') + '</div>';
        html += '</button>';
        if (expanded) {
          html += '<div class="activity-invocations">';
          (context.invocations || []).forEach(function (invocation, invocationIndex) {
            var turn = invocation.contextTurn || 1;
            var badge = invocation.providerSessionReused === true || turn > 1 ? 'REUSED CONTEXT' : 'NEW CONTEXT';
            var kind = invocation.invocationKind || 'invocation';
            var repaired = schemaRepairFollowed(context.invocations || [], invocationIndex);
            var trigger = invocation.triggerSummary || (invocation.trigger && invocation.trigger.summary) || 'Reason unavailable for historical invocation';
            var invUsage = invocation.usage || {};
            var tokens = formatTokenCount(invUsage.totalTokens || 0);
            var invCached = invUsage.cacheReadTokens ? (' · ' + formatTokenCount(invUsage.cacheReadTokens) + ' cached') : '';
            var time = invocation.startedAt ? date(invocation.startedAt).slice(11, 16) : '—';
            html += '<div class="activity-invocation">';
            html += '<div class="activity-invocation-main"><span class="faint">' + esc(time) + '</span>';
            html += '<strong>Turn ' + esc(String(turn)) + '</strong>';
            html += '<span class="context-badge ' + (badge === 'NEW CONTEXT' ? 'new' : 'reused') + '">' + badge + '</span>';
            html += '<span>' + esc(kind) + '</span>';
            if (repaired) html += '<span class="badge completed">repaired</span>';
            html += '<span class="faint">' + esc(tokens) + esc(invCached) + '</span></div>';
            html += '<div class="muted" style="margin-top:4px">' + esc(trigger) + '</div>';
            if (invocation.error) html += '<div class="' + (repaired ? 'muted' : 'fail') + '" style="margin-top:4px">' + (repaired ? '<strong>Repaired contract error:</strong> ' : '') + esc(invocation.error) + '</div>';
            html += renderInvocationInspectButton(invocation, turn, context.invocationCount || 0, badge, repaired);
            html += '</div>';
          });
          html += '</div>';
        }
        html += '</article>';
      });
      html += '</div>';
      return html;
    }

    function timelineRoleClass(role) {
      if (role === 'implementer') return 'role-green';
      if (role === 'reviewer' || role === 'task-reviewer') return 'role-review';
      return 'role-other';
    }

    function transitionRoleClass(entry) {
      if (entry.event === 'routing') return 'role-routing';
      if (entry.event === 'task.gates_passed' || entry.event === 'task.gates_failed') return 'role-verify';
      return 'role-transition';
    }

    function renderExecutionSequence(timeline, contexts) {
      if (!state.expandedTimelineRows) state.expandedTimelineRows = {};
      var contextTotals = {};
      (contexts || []).forEach(function (context) {
        contextTotals[context.id] = context.invocationCount || (context.invocations || []).length;
      });
      var html = '<div class="activity-sequence" data-testid="agent-activity-sequence">';
      if (!timeline.length) {
        html += '<div class="empty">No execution steps recorded yet.</div></div>';
        return html;
      }
      timeline.slice().reverse().forEach(function (entry) {
        var seq = sequenceLabel(entry.sequence);
        var time = timelineClock(entry.occurredAt);
        if (entry.type === 'invocation') {
          var invocation = entry.invocation || {};
          var turn = invocation.contextTurn || 1;
          var badge = invocation.providerSessionReused === true || turn > 1 ? 'REUSED CONTEXT · turn ' + turn : 'NEW CONTEXT';
          var badgeClass = invocation.providerSessionReused === true || turn > 1 ? 'reused' : 'new';
          var kind = invocation.invocationKind || 'invocation';
          var role = displayActivityRole(invocation.role, invocation.taskId);
          var taskTitle = taskTitleForId(invocation.taskId);
          var trigger = invocation.triggerSummary || (invocation.trigger && invocation.trigger.summary) || 'Reason unavailable for historical invocation';
          var providerKey = invocation.providerSessionId || ('synthetic:' + invocation.sessionId);
          var invUsage = invocation.usage || {};
          var tokens = formatTokenCount(invUsage.totalTokens || 0);
          var invCached = invUsage.cacheReadTokens ? (' · ' + formatTokenCount(invUsage.cacheReadTokens) + ' cached') : '';
          var repaired = false;
          var siblings = ((contexts || []).find(function (context) {
            return context.id === invocation.providerSessionId || context.id === ('synthetic:' + invocation.sessionId);
          }) || {}).invocations || [];
          var selfIndex = siblings.findIndex(function (item) { return item.path === invocation.path; });
          if (selfIndex >= 0) repaired = schemaRepairFollowed(siblings, selfIndex);
          var result = invocationResultLabel(invocation);
          var invocationStatus = (invocation.outcome && invocation.outcome.status) || invocation.status || '';
          var rowSummary = taskTitle || (result && result !== invocationStatus ? result : trigger);
          var rowResult = taskTitle
            ? result
            : invocationStatus;
          var invocationRowKey = 'invocation-' + (entry.sequence != null ? entry.sequence : invocation.path || invocation.sessionId || 'unknown');
          var invocationExpanded = !!state.expandedTimelineRows[invocationRowKey];
          html += '<article class="activity-row invocation ' + timelineRoleClass(invocation.role) + (invocationExpanded ? ' open' : '') + '" data-testid="activity-row">';
          html += '<button type="button" class="activity-row-toggle" data-toggle-timeline-row="' + attr(invocationRowKey) + '" aria-expanded="' + (invocationExpanded ? 'true' : 'false') + '">';
          html += '<div class="activity-row-main">';
          html += '<span class="activity-seq">' + esc(seq) + '</span>';
          html += '<span class="activity-time faint">' + esc(time) + '</span>';
          html += '<strong class="activity-role">' + esc(role) + '</strong>';
          html += '<span class="activity-task">' + esc(rowSummary) + '</span>';
          html += '<span class="activity-result">' + esc(rowResult) + '</span>';
          html += '<span class="activity-tokens faint">' + esc(tokens) + esc(invCached) + '</span>';
          html += '<span class="activity-chevron" aria-hidden="true">›</span>';
          html += '</div></button>';
          if (invocationExpanded) {
            html += '<div class="activity-row-detail">';
            html += '<div class="activity-detail-meta"><span class="tag">' + esc(kind) + '</span>';
            html += '<span class="context-badge ' + badgeClass + '">' + esc(badge) + '</span>';
            html += '<span>' + esc(tokens) + esc(invCached) + '</span>';
            if (repaired) html += '<span class="badge completed">repaired</span>';
            html += '</div>';
            html += '<div><strong>Trigger:</strong> ' + esc(trigger) + '</div>';
            if (outcomeSummary(invocation)) html += '<div><strong>Outcome:</strong> ' + esc(outcomeSummary(invocation)) + '</div>';
            if (invocation.error) html += '<div class="' + (repaired ? 'muted' : 'fail') + '">' + (repaired ? '<strong>Repaired contract error:</strong> ' : '<strong>Error:</strong> ') + esc(invocation.error) + '</div>';
            html += renderInvocationInspectButton(invocation, turn, contextTotals[providerKey] || turn, badge.indexOf('REUSED') === 0 ? 'REUSED CONTEXT' : 'NEW CONTEXT', repaired);
            html += '</div>';
          }
          html += '</article>';
          return;
        }
        var rowKey = 'transition-' + (entry.eventSequence != null ? entry.eventSequence : entry.sequence) + '-' + (entry.event || 'event');
        var expanded = !!state.expandedTimelineRows[rowKey];
        var status = entry.status || '';
        html += '<article class="activity-row transition ' + transitionRoleClass(entry) + (expanded ? ' open' : '') + '" data-testid="activity-row">';
        html += '<button type="button" class="activity-row-toggle" data-toggle-timeline-row="' + attr(rowKey) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
        html += '<div class="activity-row-main">';
        html += '<span class="activity-seq">' + esc(seq) + '</span>';
        html += '<span class="activity-time faint">' + esc(time) + '</span>';
        html += '<strong class="activity-role">' + esc(entry.event === 'routing' ? 'Routing' : entry.event === 'task.gates_passed' || entry.event === 'task.gates_failed' ? 'Verification' : 'Harness') + '</strong>';
        html += '<span class="activity-task">' + esc(entry.summary || entry.event || 'transition') + '</span>';
        html += '<span class="activity-result">' + esc(entry.from || entry.to ? ((entry.from || '?') + ' → ' + (entry.to || '?')) : status) + '</span>';
        html += '<span class="activity-tokens faint" aria-hidden="true"></span>';
        html += '<span class="activity-chevron" aria-hidden="true">›</span>';
        html += '</div></button>';
        if (expanded) {
          html += '<div class="activity-row-detail">';
          if (status) html += '<div class="activity-detail-meta"><span class="badge ' + attr(status === 'passed' || status === 'completed' ? 'completed' : status === 'failed' || status === 'blocking' ? 'failed' : status) + '">' + esc(status) + '</span></div>';
          if (entry.taskId) html += '<div>Task: ' + esc(taskTitleForId(entry.taskId) || entry.taskId) + '</div>';
          if (entry.round != null) html += '<div>Round: ' + esc(String(entry.round)) + '</div>';
          if (entry.eventSequence != null) html += '<div>Event sequence: ' + esc(String(entry.eventSequence)) + '</div>';
          if (entry.event) html += '<div>Event: <code>' + esc(entry.event) + '</code></div>';
          if (entry.detail) html += '<pre>' + esc(JSON.stringify(entry.detail, null, 2).slice(0, 4000)) + '</pre>';
          html += '</div>';
        }
        html += '</article>';
      });
      html += '</div>';
      return html;
    }

    function renderAgentActivity() {
      var activity = state.detail.agentActivity;
      var contexts = (activity && activity.providerContexts) || [];
      var timeline = (activity && activity.timeline) || [];
      if (!contexts.length && !timeline.length) {
        $("tabBody").innerHTML = '<div class="empty">No provider contexts have launched yet.</div>';
        return;
      }
      var mode = activityViewMode();
      var html = '<div class="activity-view" data-testid="agent-activity">';
      html += '<div class="activity-view-head"><div class="activity-view-switch" role="tablist" aria-label="Activity view">';
      html += '<button type="button" class="btn small' + (mode === 'sequence' ? ' primary' : '') + '" data-activity-view="sequence" data-testid="activity-view-sequence">Execution sequence</button>';
      html += '<button type="button" class="btn small' + (mode === 'contexts' ? ' primary' : '') + '" data-activity-view="contexts" data-testid="activity-view-contexts">Provider contexts</button>';
      html += '</div><div class="activity-view-help">' + (mode === 'sequence' ? 'Latest first · tokens on each step · select for trigger and details.' : 'Select a context to see its invocations.') + '</div></div>';
      if (mode === 'contexts') html += renderProviderContextActivity(contexts);
      else html += renderExecutionSequence(timeline, contexts);
      html += '</div>';
      $("tabBody").innerHTML = html;
    }

`;

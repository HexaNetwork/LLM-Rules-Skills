/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const apiScript = `    async function api(path, options) {
      var init = options || {};
      // The server also accepts an HttpOnly session cookie set when the
      // tokenized URL was first opened, so a refresh that lost sessionStorage
      // still authenticates. Send the header only when we actually have one.
      init.credentials = "same-origin";
      init.headers = Object.assign(token ? {"X-Harness-Token":token} : {}, init.headers || {});
      if (init.body && typeof init.body !== "string") {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(init.body);
      }
      var response = await fetch(path, init);
      var body = await response.json();
      if (!response.ok) throw new Error(body.error || ("Request failed: " + response.status));
      return body;
    }

    async function bootstrap(keepSelection) {
      try {
        var data = await api("/api/bootstrap");
        state.bootstrap = data; state.runs = data.runs || [];
        state.unreadableRuns = data.unreadableRuns || [];
        $("projectName").textContent = data.project.name;
        $("projectName").title = data.project.root || "";
        if (!keepSelection && !state.selected && state.runs.length) state.selected = state.runs[0].runId;
        if (state.selected && !state.runs.some(function (run) { return run.runId === state.selected; })) state.selected = state.runs[0] ? state.runs[0].runId : null;
        renderSidebar();
        if (state.view === "knowledge") renderKnowledge();
        else if (state.view === "guidance") renderGuidance();
        else if (state.selected) await loadRun(state.selected, false);
        else renderHome();
      } catch (error) {
        toast(error.message, true);
        // A blank shell reads as data loss. Name the failure instead, and say
        // whether the runs on disk are affected (they are not).
        if (/token|401|denied/i.test(String(error.message))) renderAuthError(error.message);
        else renderLoadError("The dashboard could not load this workspace.", error.message);
      }
    }
    async function loadRun(runId, showSpinner, silent, preserveEditor) {
      var sameRun = state.selected === runId;
      // The inline error belongs to the run that raised it; switching runs drops it.
      if (!sameRun) state.inlineError = "";
      state.selected = runId; state.view = "runs";
      if (showSpinner !== false) $("content").innerHTML = '<div class="empty">Loading run…</div>';
      try {
        var since = sameRun && state.signature ? ("?since=" + encodeURIComponent(state.signature)) : "";
        var detail = await api("/api/runs/" + encodeURIComponent(runId) + since, undefined, silent);
        if (detail.unchanged) return;
        state.detail = detail;
        if (detail.state && (detail.state.phase === "cancelled" || detail.state.phase === "completed")) {
          state.cancelling = false;
        }
        renderSidebar();
        // The signature tracks the last *rendered* payload; do not advance it
        // when a poll skips render, or a later poll treats stale DOM as current.
        if (preserveEditor && (editorIsActive() || batchIsActive())) return;
        if (silent) captureScrolls();
        renderRun();
        state.signature = detail.signature || "";
        if (detail.state) maybePlayPhaseSound(detail.state.phase);
        if (silent) restoreScrolls();
      } catch (error) {
        toast(error.message, true);
        playTone('error');
        // A background poll must not blow away a good render; only a foreground
        // load (refresh, run switch) is allowed to replace the content area.
        if (!silent) renderLoadError("This run could not be loaded.", error.message);
      }
    }
`;

/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderGuidanceScript = `    function renderGuidance() {
      state.view = "guidance"; state.selected = null; state.detail = null; state.inlineError = ""; renderSidebar();
      $("crumbTitle").textContent = "Agent guidance";
      $("topActions").innerHTML = "";
      $("content").innerHTML = '<div class="title-row"><div><div class="eyebrow">Role inspector</div><h1>Agent guidance</h1><div class="subtitle">Read-only view of the compiled guidance pack each agent role receives — role rules plus assigned skills/rules, without retrieval headers.</div></div></div><div class="guidance-layout"><aside class="card"><div class="card-label">Roles</div><div class="guidance-roles" id="guidanceRoles"><div class="muted">Loading…</div></div></aside><div class="card" id="guidanceDetail"><div class="muted">Loading guidance packs…</div></div></div>';
      void loadGuidancePacks();
    }

    async function loadGuidancePacks() {
      try {
        var data = await api("/api/guidance/packs");
        state.guidancePacks = data.packs || [];
        if (!state.guidanceRole && state.guidancePacks.length) state.guidanceRole = state.guidancePacks[0].role;
        if (state.guidanceRole && !state.guidancePacks.some(function (pack) { return pack.role === state.guidanceRole; })) {
          state.guidanceRole = state.guidancePacks[0] ? state.guidancePacks[0].role : null;
        }
        renderGuidanceRoles();
        renderGuidanceDetail();
      } catch (error) {
        $("guidanceRoles").innerHTML = '<div class="muted">Unable to load roles.</div>';
        $("guidanceDetail").innerHTML = '<div class="muted">' + esc(error.message) + '</div>';
      }
    }

    function renderGuidanceRoles() {
      var packs = state.guidancePacks || [];
      $("guidanceRoles").innerHTML = packs.length
        ? packs.map(function (pack) {
            var active = pack.role === state.guidanceRole ? " active" : "";
            return '<button type="button" class="btn ghost guidance-role' + active + '" data-guidance-role="' + attr(pack.role) + '">' + esc(pack.role) + '</button>';
          }).join("")
        : '<div class="empty">No roles configured.</div>';
    }

    function renderGuidanceDetail() {
      var pack = (state.guidancePacks || []).find(function (item) { return item.role === state.guidanceRole; });
      if (!pack) {
        $("guidanceDetail").innerHTML = '<div class="empty">Select a role to inspect its guidance pack.</div>';
        return;
      }
      var assignment = pack.assignment || { rules: [], skills: [] };
      var assignmentNames = []
        .concat((assignment.rules || []).map(function (name) { return "rule:" + name; }))
        .concat((assignment.skills || []).map(function (name) { return "skill:" + name; }));
      var warnings = [];
      (pack.missingAssignments || []).forEach(function (item) {
        warnings.push("Missing " + item.kind + " '" + item.name + "': " + item.reason);
      });
      (pack.omittedOverrides || []).forEach(function (item) {
        warnings.push("Overridden: " + item.source + " (" + item.reason + ")");
      });
      if (pack.truncated) {
        warnings.push("Pack truncated from " + pack.truncated.before + " to " + pack.truncated.after + " characters.");
      }
      $("guidanceDetail").innerHTML =
        '<div class="item-head"><div><div class="card-label">Role</div><h2 style="margin:6px 0 0">' + esc(pack.role) + '</h2></div><span class="tag">' + esc(String((pack.sources || []).length)) + ' source(s)</span></div>' +
        '<div class="guidance-meta">' +
          '<div><div class="card-label">Assignment</div><div class="faint">' + (assignmentNames.length ? esc(assignmentNames.join(", ")) : "none") + '</div></div>' +
          '<div><div class="card-label">Resolved sources</div><div class="faint">' + ((pack.sources || []).length ? esc((pack.sources || []).join(", ")) : "none") + '</div></div>' +
        '</div>' +
        (warnings.length
          ? '<div class="guidance-warnings">' + warnings.map(function (warning) {
              return '<div class="muted">' + esc(warning) + '</div>';
            }).join("") + '</div>'
          : "") +
        '<div class="guidance-section"><h2>Role rules</h2><pre>' + esc((pack.roleRules || []).map(function (rule) { return "- " + rule; }).join(String.fromCharCode(10)) || "(none)") + '</pre></div>' +
        '<div class="guidance-section"><h2>Guidance pack</h2><pre>' + esc(pack.guidancePack || "(empty)") + '</pre></div>' +
        '<details class="session-section" data-details-key="guidance-prompt-preview" style="margin-top:16px"><summary>Full prompt preview <small>role intro + rules + GUIDANCE</small></summary><pre>' + esc(pack.promptPreview || "") + '</pre></details>';
    }
`;

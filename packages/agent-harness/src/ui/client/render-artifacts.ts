/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderArtifactsScript = `    function renderArtifacts() {
      var artifacts = state.detail.artifacts;
      $("tabBody").innerHTML = artifacts.length ? '<div class="artifact-list">' + artifacts.map(function (file) { return '<button class="btn artifact" data-artifact="' + attr(file) + '"><span>◇</span><code>' + esc(file) + '</code></button>'; }).join("") + '</div>' : '<div class="empty">No artifacts yet.</div>';
    }

    function renderKnowledge() {
      state.view = "knowledge"; state.selected = null; state.detail = null; state.inlineError = ""; renderSidebar();
      $("crumbTitle").textContent = "Knowledge base";
      $("topActions").innerHTML = '<button class="btn small" id="refreshKnowledge">Refresh sources</button>';
      $("content").innerHTML = '<div class="title-row"><div><div class="eyebrow">RAG inspector</div><h1>Knowledge base</h1><div class="subtitle">Manually test the same lexical, semantic, and repository context retrieval used in agent work packets.</div></div></div><div class="card" id="knowledgeStatus"><div class="muted">Loading retrieval configuration…</div></div><div class="knowledge-layout"><div class="card"><form id="knowledgeSearch"><div class="field"><label for="knowledgeQuery">Manual RAG query</label><div style="display:flex;gap:8px"><input id="knowledgeQuery" type="text" required placeholder="e.g. where is retry logic configured?"><button class="btn primary">Search</button></div></div></form><div class="knowledge-results" id="knowledgeResults"><div class="empty">Enter a query to inspect retrieved chunks.</div></div></div><aside class="card"><div class="card-label">Add a source</div><p class="muted">Index a text file already inside this repository.</p><form id="knowledgeAdd"><div class="field"><label for="knowledgePath">Repository-relative path</label><input id="knowledgePath" type="text" required placeholder="docs/api.md"></div><button class="btn" style="width:100%">Add document</button></form><hr style="border:0;border-top:1px solid var(--line-soft);margin:20px 0"><div class="card-label">Storage</div><p class="faint"><code>.agent-harness/knowledge/</code><br>Lexical chunks and optional vectors stay local; CodeGraph reads <code>.codegraph/</code>.</p></aside></div>';
      void loadKnowledgeStatus();
    }

    async function loadKnowledgeStatus() {
      try {
        var status = await api('/api/knowledge/status');
        var semantic = status.semantic || {};
        var semanticText = semantic.enabled
          ? 'Enabled · ' + String(semantic.provider) + ' · ' + String(semantic.model)
          : 'Disabled · lexical retrieval remains active';
        $("knowledgeStatus").innerHTML = '<div class="item-head"><div><div class="card-label">Retrieval configuration</div><div class="muted" style="margin-top:6px"><strong>Lexical:</strong> enabled &nbsp; <strong>Semantic:</strong> ' + esc(semanticText) + ' &nbsp; <strong>CodeGraph:</strong> ' + (status.codegraph && status.codegraph.enabled ? 'enabled' : 'disabled') + '</div></div><span class="tag">' + esc((status.sources || []).length + ' source(s)') + '</span></div>';
      } catch (error) {
        $("knowledgeStatus").innerHTML = '<div class="muted">Retrieval configuration unavailable.</div>';
      }
    }

    function renderLoadError(headline, message) {
      $("crumbTitle").textContent = "Error"; $("topActions").innerHTML = "";
      $("content").innerHTML = '<div class="hero"><div><div class="eyebrow">Load failed</div><h1>' + esc(headline) + '</h1><p class="hero-copy">' + esc(message) + '</p><p class="muted">Runs are stored on disk under <code>.agent-harness/runs/</code> and are not affected by this failure. Retry, or check the terminal running <code>agent-harness ui</code>.</p><p><button class="btn primary" id="retryLoadBtn">Retry</button></p></div></div>';
      var retry = $("retryLoadBtn");
      if (retry) retry.addEventListener('click', function () { bootstrap(true); });
    }

    function renderAuthError(message) {
      $("content").innerHTML = '<div class="hero"><div><div class="eyebrow">Connection failed</div><h1>Dashboard access denied.</h1><p class="hero-copy">' + esc(message) + '</p><p class="muted">Open the exact tokenized URL printed by <code>agent-harness ui</code>.</p></div></div>';
    }
`;

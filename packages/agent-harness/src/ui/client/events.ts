/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const eventsScript = `    async function waitForJob(runId) {
      while (true) {
        var detail = await api('/api/runs/' + encodeURIComponent(runId), undefined, true);
        if (detail.unchanged) {
          await new Promise(function (resolve) { setTimeout(resolve, 150); });
          continue;
        }
        state.detail = detail;
        var job = detail.job;
        if (!job) return { ok: true };
        if (job.status === 'failed') return { ok: false, error: job.error || 'Action failed' };
        await new Promise(function (resolve) { setTimeout(resolve, 150); });
      }
    }

    async function runAction(action, extra) {
      if (!state.selected) return;
      try {
        var response = await api('/api/runs/' + encodeURIComponent(state.selected) + '/actions', {method:'POST',body:Object.assign({action:action},extra||{})});
        if (action === 'answer' && extra && extra.questionId) delete state.answerDrafts[extra.questionId];
        if (action === 'cancel') {
          state.cancelling = !!(response && response.pending);
          toast(state.cancelling ? 'Cancelling…' : 'Run cancelled');
          await bootstrap(true);
          return;
        }
        if (action === 'stop') {
          toast(response && response.state && response.state.stoppedAfterTaskAt ? 'Stopped after task' : 'Will stop after the current task');
          await bootstrap(true);
          return;
        }
        if (state.detail && response && response.job) {
          state.detail.job = response.job;
          renderRun();
        }
        // Reflect confirm / grill batch can queue a long agent job; scroll before
        // waiting so the thinking strip at the top is visible while it works.
        if (action === 'answer') scrollMainToTop();
        if (action === 'resolve_installs' || action === 'confirm_grill') scrollMainToTop();
        if (action === 'commit_preflight' || action === 'accept_tree' || action === 'retry') scrollMainToTop();
        var result = await waitForJob(state.selected);
        await bootstrap(true);
        if (action === 'answer') scrollMainToTop();
        if (action === 'resolve_installs' || action === 'confirm_grill' || action === 'confirm_verification') scrollMainToTop();
        if (action === 'retry_verification_baseline') scrollMainToTop();
        state.pinScrollTop = false;
        if (!result.ok) {
          playTone('error');
          toast(result.error, true);
          return;
        }
        var landedGrillReady = !!(state.detail && state.detail.state && state.detail.state.grillReady);
        var landedVerification = !!(state.detail && state.detail.state && state.detail.state.verificationReady);
        var landedBaseline = !!(state.detail && state.detail.state && state.detail.state.verificationBaselineReady);
        var doneMsg = action === 'answer'
          ? (landedGrillReady ? 'Grilling complete — review before planning' : 'Answer recorded')
            : (action === 'ignore_artifacts' ? 'Ignored artifacts and continued'
          : (action === 'resolve_installs' ? 'Install decisions applied'
          : (action === 'confirm_grill'
            ? (extra && extra.feedback
              ? 'Feedback sent — grilling resumed'
              : (landedVerification
                ? 'Confirm verification settings before planning'
                : 'Continuing to planning'))
            : (action === 'confirm_verification'
              ? (landedBaseline
                ? 'Baseline tests failed — fix the command and retry'
                : 'Verification confirmed — planning')
            : (action === 'retry_verification_baseline'
              ? (landedBaseline
                ? 'Baseline still failing — inspect evidence and retry'
                : 'Baseline passed — planning')
            : (action === 'set_tdd' ? 'TDD updated'
            : (action === 'commit_preflight' ? 'Working tree committed — continuing'
            : (action === 'accept_tree' ? 'Current tree accepted — continuing'
            : (action === 'retry' ? 'Retry started' : 'Action completed')))))))));
        toast(doneMsg);
      } catch (error) {
        state.pinScrollTop = false;
        playTone('error');
        toast(error.message,true);
      }
    }

    async function openArtifact(file) {
      try {
        var data = await api('/api/runs/' + encodeURIComponent(state.selected) + '/artifact?path=' + encodeURIComponent(file));
        $("artifactTitle").textContent = data.path; $("artifactContent").textContent = data.content; $("artifactDialog").showModal();
      } catch (error) { toast(error.message,true); }
    }

    function pretty(value, fallback) {
      if (value == null) return fallback || "Unavailable";
      if (typeof value === "string") return value;
      try { return JSON.stringify(value,null,2); } catch (error) { return String(value); }
    }

    function number(value) {
      return value == null ? "—" : new Intl.NumberFormat().format(Number(value));
    }

    function sessionStat(label, value) {
      return '<div class="session-stat"><span>' + esc(label) + '</span><strong title="' + attr(value) + '">' + esc(value) + '</strong></div>';
    }

    function sessionSection(title, detail, value, open, extraClass) {
      return '<details class="session-section"' + (open ? ' open' : '') + '><summary>' + esc(title) + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</summary><pre class="' + attr(extraClass || '') + '">' + esc(pretty(value)) + '</pre></details>';
    }

    async function openSession(file, metaHints) {
      try {
        var data = await api('/api/runs/' + encodeURIComponent(state.selected) + '/session?path=' + encodeURIComponent(file));
        var session = data.session || {}, usage = session.usage || {};
        var started = session.startedAt ? new Date(session.startedAt) : null;
        var ended = session.endedAt ? new Date(session.endedAt) : null;
        var duration = started && ended ? Math.max(0,ended.getTime()-started.getTime()) : null;
        var prompt = data.inputPrompt || "Input unavailable for this historical session.";
        var hints = metaHints || {};
        var contextBadge = hints.contextBadge || (session.providerSessionReused === true ? 'REUSED CONTEXT' : (session.providerSessionReused === false ? 'NEW CONTEXT' : 'UNKNOWN CONTEXT'));
        var turnLabel = hints.contextTurn && hints.contextTotal
          ? (String(session.role || 'agent') + ' · turn ' + hints.contextTurn + ' of ' + hints.contextTotal)
          : (session.role || 'Invocation');
        var meta = '';
        meta += '<div class="context-badge ' + (contextBadge === 'NEW CONTEXT' ? 'new' : 'reused') + '" style="grid-column:1/-1">' + esc(contextBadge) + '</div>';
        meta += sessionStat('Status', session.status || 'unknown');
        meta += sessionStat('Model', session.model || 'unknown');
        meta += sessionStat('Schema attempt', String(Number(session.attempt || 0) + 1));
        meta += sessionStat('Duration', duration == null ? '—' : (duration / 1000).toFixed(1) + 's');
        meta += sessionStat('Input tokens', number(usage.inputTokens));
        meta += sessionStat('Output tokens', number(usage.outputTokens));
        meta += sessionStat('Cache read', number(usage.cacheReadTokens));
        meta += sessionStat('Cache write', number(usage.cacheWriteTokens));
        meta += sessionStat('Total tokens', number(usage.totalTokens));
        meta += sessionStat('Reasoning tokens', number(usage.reasoningTokens));
        meta += sessionStat('Started', session.startedAt || '—');
        meta += sessionStat('Ended', session.endedAt || '—');
        meta += sessionStat('Invocation ID', session.invocationId || '—');
        meta += sessionStat('Provider context', session.providerSessionId || '—');
        meta += sessionStat('Provider run', session.providerRunId || '—');
        meta += sessionStat('Invocation kind', session.invocationKind || '—');
        meta += sessionStat('Trigger', (session.trigger && session.trigger.summary) || 'Reason unavailable for historical invocation');
        var artifacts = Array.isArray(data.relatedArtifacts) && data.relatedArtifacts.length ? '<div class="related-artifacts">' + data.relatedArtifacts.map(function (artifact) { return '<code>' + esc(artifact) + '</code>'; }).join('') + '</div>' : '';
        var packet = data.packet || {};
        var context = Array.isArray(packet.context) ? packet.context : [];
        var retrieval = data.retrieval;
        var graphify = retrieval && retrieval.graphify ? retrieval.graphify : null;
        var graphifySkipped = graphify && graphify.included === false && graphify.skippedReason;
        var weakContext = context.length === 0 || graphifySkipped;
        var html = '<div class="session-meta">' + meta + '</div>';
        html += sessionSection('Actual submitted input', String(data.inputSource || 'unknown source') + ' · ' + number(prompt.length) + ' characters', prompt, true);
        html += sessionSection('Work packet', session.packet || 'No packet linked', data.packet, false);
        if (weakContext && retrieval) {
          var retrievalDetail = context.length === 0
            ? 'Empty context'
            : (graphifySkipped ? 'Graphify skipped · ' + String(graphify.skippedReason) : 'Weak context');
          html += sessionSection('Retrieval audit', retrievalDetail + ' · ' + number((retrieval.kept || []).length) + ' kept / ' + number((retrieval.omitted || []).length) + ' omitted', retrieval, true);
        } else if (retrieval) {
          html += sessionSection('Retrieval audit', number((retrieval.kept || []).length) + ' kept / ' + number((retrieval.omitted || []).length) + ' omitted', retrieval, false);
        }
        if (retrieval && retrieval.budget) {
          html += sessionSection('Packet budget', number((retrieval.budget.truncations || []).length) + ' truncations', retrieval.budget, (retrieval.budget.truncations || []).length > 0);
        }
        html += sessionSection('Model output', session.output == null ? 'No output recorded' : '', session.output, false);
        if (session.error) html += sessionSection('Error', '', session.error, true, 'session-error');
        if (Array.isArray(data.steps) && data.steps.length) {
          var stepsText = data.steps.map(function (step) {
            if (!step || typeof step !== "object") return String(step);
            var tool = step.toolName || step.type || "step";
            var summary = step.summary ? String(step.summary) : tool;
            var when = step.at ? String(step.at) : "";
            return (when ? when + "  " : "") + summary;
          }).join(String.fromCharCode(10));
          html += '<details class="session-section" data-details-key="session-steps"><summary>Live steps<small>' + number(data.steps.length) + (data.stepsPath ? ' · ' + String(data.stepsPath) : '') + '</small></summary><pre data-scroll-key="session-steps">' + esc(stepsText) + '</pre></details>';
        }
        html += sessionSection('Raw session record', '', session, false);
        if (artifacts) html += '<details class="session-section"><summary>Related artifacts</summary>' + artifacts + '</details>';
        $("sessionTitle").textContent = turnLabel;
        $("sessionSubtitle").textContent = String(session.sessionId || file);
        $("sessionInspector").innerHTML = html;
        $("sessionDialog").showModal();
      } catch (error) { toast(error.message,true); }
    }

    // Surgical DOM updates so answering a question never triggers a full renderRun().
/*__SPLIT_EVENTS__*/
    document.addEventListener('click', function (event) {
      var target = event.target.closest('button,a'); if (!target) return;
      if (target.dataset.copyPath != null) {
        var path = target.dataset.copyPath;
        if (!path) { toast('Nothing to copy', true); return; }
        var copied = function () { toast('Copied'); };
        var failed = function () { toast('Could not copy', true); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(path).then(copied).catch(failed);
        } else {
          var area = document.createElement('textarea');
          area.value = path;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          try { if (document.execCommand('copy')) copied(); else failed(); } catch (error) { failed(); }
          document.body.removeChild(area);
        }
        return;
      }
      if (target.dataset.run) { document.body.classList.remove('menu-open'); loadRun(target.dataset.run); }
      if (target.dataset.tab) { state.tab = target.dataset.tab; renderRun(); }
      if (target.dataset.usageTab) {
        // Mini-tabs live inside <details>; a bare re-render remounts it closed.
        state.usageTab = target.dataset.usageTab;
        captureScrolls();
        renderRun();
        restoreScrolls();
      }
      if (target.dataset.action) {
        if (target.dataset.action === 'cancel' && !confirm('Cancel this run?')) return;
        if (target.dataset.action === 'stop' && !confirm('Finish the current task, then stop before starting the next one?')) return;
        if (target.dataset.action === 'migrate_workspace' && !confirm('Migrate this legacy run onto a registered worktree at the current HEAD? The shared checkout must be clean.')) return;
        if (target.dataset.action === 'cleanup') {
          var discardCleanup = target.dataset.discard === 'true';
          var cleanupPrompt = discardCleanup
            ? 'Discard unpublished commits that are not on a retained named ref, then remove the worktree?'
            : 'Remove this run worktree after safety checks? State, events, and retained branches stay on disk.';
          if (!confirm(cleanupPrompt)) return;
          runAction('cleanup', { discard: discardCleanup });
          return;
        }
        if (target.dataset.action === 'set_tdd') {
          runAction('set_tdd', {
            tdd: target.dataset.tdd === 'true',
            taskId: target.dataset.taskId || undefined
          });
        } else if (target.dataset.action === 'commit_preflight') {
          runAction(target.dataset.action, { order: target.dataset.preflightOrder });
        } else if (target.dataset.action === 'ignore_artifacts') {
          var ignorePaths = [];
          if (target.dataset.ignorePath) {
            ignorePaths = [target.dataset.ignorePath];
          } else if (target.dataset.ignorePaths) {
            try { ignorePaths = JSON.parse(target.dataset.ignorePaths); } catch (error) { ignorePaths = []; }
          }
          if (!ignorePaths.length) { toast('No paths to ignore', true); return; }
          runAction('ignore_artifacts', { paths: ignorePaths });
        } else if (target.dataset.action === 'raise_budget_retry') {
          var tokenInput = document.getElementById('raiseMaxRunTokens');
          var costInput = document.getElementById('raiseMaxRunCostUsd');
          var maxRunTokens = tokenInput && tokenInput.value !== '' ? Number(tokenInput.value) : undefined;
          var maxRunCostUsd = costInput && costInput.value !== '' ? Number(costInput.value) : undefined;
          runAction('retry', { force: true, maxRunTokens: maxRunTokens, maxRunCostUsd: maxRunCostUsd });
        } else if (target.dataset.action === 'propose_fix') {
          var fixerInput = document.getElementById('fixerGuidance');
          var guidance = fixerInput ? fixerInput.value.trim() : '';
          if (!guidance && target.dataset.reviseFix !== 'true') {
            var blockedKind = state.detail && state.detail.state ? state.detail.state.blockedKind : undefined;
            var failureText = state.detail && state.detail.state ? String(state.detail.state.failure || '') : '';
            var configRepair =
              blockedKind === 'config' ||
              /run configuration changed|configurationHash|resume with the persisted run config|configVersion .+ is newer than harness|Test writer changed non-test paths|Test command could not be launched/i.test(failureText);
            if (configRepair) guidance = 'Propose the smallest recommended repair that unblocks this harness configuration failure.';
            else { toast('Describe the recovery you want before asking the fixer to plan it', true); return; }
          }
          if (!guidance && state.detail && state.detail.state && state.detail.state.fixerRecovery) guidance = state.detail.state.fixerRecovery.guidance;
          runAction('propose_fix', { guidance: guidance });
        } else if (target.dataset.action === 'apply_fix') {
          var persistProjectDefaults = target.dataset.persistProjectDefaults === 'true';
          var reviewFixer = persistProjectDefaults
            ? 'Update this run frozen config and write the same repair into agent-harness.config.yaml for future runs, then resume?'
            : 'Update only this run frozen config and resume? Project settings stay unchanged.';
          if (!confirm(reviewFixer)) return;
          var body = { persistProjectDefaults: persistProjectDefaults };
          runAction('apply_fix', body);
        } else if (target.dataset.action === 'retry' && target.dataset.force === 'true') {
          runAction('retry', { force: true });
        } else {
          runAction(target.dataset.action);
        }
      }
      if (target.id === 'acceptAllInstallsBtn') {
        var pending = ((state.detail && state.detail.state && state.detail.state.proposedInstalls) || []).filter(function (item) { return !item.decision; });
        pending.forEach(function (item) { state.installSelections[item.id] = 'accept'; });
        renderRun();
      }
      if (target.id === 'denyAllInstallsBtn') {
        var denyPending = ((state.detail && state.detail.state && state.detail.state.proposedInstalls) || []).filter(function (item) { return !item.decision; });
        denyPending.forEach(function (item) { state.installSelections[item.id] = 'deny'; });
        renderRun();
      }
      if (target.id === 'submitInstallsBtn') {
        var installPending = ((state.detail && state.detail.state && state.detail.state.proposedInstalls) || []).filter(function (item) { return !item.decision; });
        var accepted = [], denied = [];
        installPending.forEach(function (item) {
          var choice = state.installSelections[item.id] || 'accept';
          if (choice === 'deny') denied.push(item.id); else accepted.push(item.id);
        });
        state.installSelections = {};
        runAction('resolve_installs', { accepted: accepted, denied: denied });
      }
      if (target.id === 'continueToPlanningBtn') {
        state.grillFeedbackText = '';
        runAction('confirm_grill', {});
      }
      if (target.id === 'sendGrillFeedbackBtn') {
        var grillFeedback = (state.grillFeedbackText || '').trim();
        if (!grillFeedback) { toast('Feedback is required to reopen the griller', true); return; }
        state.grillFeedbackText = '';
        runAction('confirm_grill', { feedback: grillFeedback });
      }
      if (target.id === 'confirmVerificationBtn' || target.id === 'keepCurrentVerificationBtn') {
        var keepCurrent = target.id === 'keepCurrentVerificationBtn';
        var gate = state.detail && state.detail.state && state.detail.state.verificationReady;
        var draft = state.verificationDraft || {};
        var current = (gate && gate.currentSettings) || {};
        var proposed = (gate && gate.proposedPatch) || {};
        var fallbackTest = (proposed.commands && proposed.commands.test != null)
          ? proposed.commands.test
          : ((current.commands && current.commands.test) || '');
        var fallbackPatterns = (proposed.workflow && proposed.workflow.testPathPatterns)
          ? proposed.workflow.testPathPatterns
          : ((current.workflow && current.workflow.testPathPatterns) || []);
        var testCommand = (draft.testCommand != null ? draft.testCommand : fallbackTest).trim();
        var patternsRaw = draft.testPathPatterns != null
          ? draft.testPathPatterns
          : fallbackPatterns.join('\\n');
        var testPathPatterns = String(patternsRaw).split(/\\r?\\n/).map(function (line) { return line.trim(); }).filter(Boolean);
        var persistProjectDefaults = !!draft.persistProjectDefaults;
        var body = { keepCurrent: keepCurrent, persistProjectDefaults: persistProjectDefaults };
        if (!keepCurrent) {
          body.patch = {
            commands: testCommand ? { test: testCommand } : undefined,
            workflow: testPathPatterns.length ? { testPathPatterns: testPathPatterns } : undefined
          };
        }
        state.verificationDraft = {};
        runAction('confirm_verification', body);
      }
      if (target.id === 'retryVerificationBaselineBtn') {
        var baselineGate = state.detail && state.detail.state && state.detail.state.verificationBaselineReady;
        var baselineDraft = state.verificationBaselineDraft || {};
        var baselineFallback = (baselineGate && baselineGate.evidence && baselineGate.evidence.command) || '';
        var baselineCommand = (baselineDraft.testCommand != null ? baselineDraft.testCommand : baselineFallback).trim();
        var baselinePersist = !!baselineDraft.persistProjectDefaults;
        var baselineBody = { persistProjectDefaults: baselinePersist };
        if (baselineCommand) baselineBody.testCommand = baselineCommand;
        state.verificationBaselineDraft = {};
        runAction('retry_verification_baseline', baselineBody);
      }
      if (target.id === 'soundMuteBtn') {
        setSoundsMuted(!soundsMuted());
      }
      if (target.dataset.artifact) openArtifact(target.dataset.artifact);
      if (target.dataset.toggleContext) {
        if (!state.expandedContexts) state.expandedContexts = {};
        var contextKey = target.dataset.toggleContext;
        state.expandedContexts[contextKey] = !state.expandedContexts[contextKey];
        renderRun();
        return;
      }
      if (target.dataset.session) {
        openSession(target.dataset.session, {
          contextTurn: target.dataset.contextTurn,
          contextTotal: target.dataset.contextTotal,
          contextBadge: target.dataset.contextBadge,
        });
      }
      if (target.id === 'settingsBtn') openSettings();
      if (target.dataset.removeArtifactIndex != null) {
        event.preventDefault();
        removeIgnoredArtifact(Number(target.dataset.removeArtifactIndex));
      }
      if (target.dataset.openTestFolderPicker != null) openTestFolderPicker('');
      if (target.dataset.testFolderPath != null) openTestFolderPicker(target.dataset.testFolderPath);
      if (target.dataset.useTestFolder != null) useTestFolder(target.dataset.useTestFolder);
      if (target.dataset.closeTestFolderPicker != null) {
        var picker = $("testFolderPicker");
        if (picker) picker.hidden = true;
      }
      // data-question-choice: legacy single-question click; batch card uses data-batch-choice.
      if (target.dataset.questionChoice) {
        var answerForm = target.closest('.question-card').querySelector('#answerForm');
        var answerInput = answerForm.querySelector('textarea[name="answer"]');
        answerInput.value = target.dataset.questionChoice;
        state.answerDrafts[answerForm.dataset.question] = target.dataset.questionChoice;
        answerInput.focus();
      }
      if (target.dataset.batchChoice) {
        selectBatchOption(target.dataset.batchChoice, target.dataset.optionId);
      }
      if (target.dataset.batchSkip) {
        toggleParked(target.dataset.batchSkip);
      }
      if (target.dataset.batchClarify) {
        toggleClarify(target.dataset.batchClarify);
      }
      if (target.id === 'acceptAllBtn') acceptAllRecommendations();
      if (target.id === 'submitBatchBtn') submitBatch();
      if (target.dataset.reflectAdd) {
        reflectListMutate(target.dataset.reflectAdd, function (list) { list.push(''); });
      }
      if (target.dataset.reflectRemove) {
        var parts = target.dataset.reflectRemove.split(':');
        reflectListMutate(parts[0], function (list) { list.splice(Number(parts[1]), 1); });
      }
      if (target.dataset.close) $(target.dataset.close).close();
      if (target.hasAttribute('data-open-new')) openNewRun();
      if (target.id === 'toastDismiss') hideToast();
      if (target.id === 'runErrorDismiss') {
        state.inlineError = '';
        var errorSlot = $('runErrorSlot');
        if (errorSlot) errorSlot.innerHTML = '';
      }
    });
    $("newRunBtn").addEventListener('click', openNewRun);
    $("menuBtn").addEventListener('click', function () { document.body.classList.toggle('menu-open'); });
    $("refreshBtn").addEventListener('click', function () { bootstrap(true); });
    $("knowledgeBtn").addEventListener('click', renderKnowledge);
    $("runFilter").addEventListener('input', function (event) { state.filter = event.target.value; renderSidebar(); });
    document.addEventListener('input', function (event) {
      if (event.target.name === 'answer' && event.target.closest('#answerForm')) state.answerDrafts[event.target.closest('#answerForm').dataset.question] = event.target.value;
      if (event.target.dataset.batchAnswer) {
        state.answerDrafts[event.target.dataset.batchAnswer] = event.target.value;
        updateBatchQuestionChrome(event.target.dataset.batchAnswer);
        updateBatchFooter();
      }
      if (event.target.dataset.batchClarifyText) {
        state.clarifications[event.target.dataset.batchClarifyText] = event.target.value;
        updateBatchQuestionChrome(event.target.dataset.batchClarifyText);
        updateBatchFooter();
        autoGrowTextarea(event.target);
      }
      if (event.target.dataset.reflectField && event.target.closest('#reflectForm')) {
        var reflectQid = event.target.closest('#reflectForm').dataset.question;
        if (state.reflectDrafts[reflectQid]) state.reflectDrafts[reflectQid][event.target.dataset.reflectField] = event.target.value;
        autoGrowTextarea(event.target);
      }
      if (event.target.dataset.reflectList && event.target.closest('#reflectForm')) {
        var listQid = event.target.closest('#reflectForm').dataset.question;
        var draftObj = state.reflectDrafts[listQid];
        if (draftObj) draftObj[event.target.dataset.reflectList][Number(event.target.dataset.reflectIndex)] = event.target.value;
        autoGrowTextarea(event.target);
      }
      if (event.target.id === 'noteText') state.noteText = event.target.value;
      if (event.target.id === 'grillFeedbackText') state.grillFeedbackText = event.target.value;
      if (event.target.id === 'verificationTestCommand') {
        state.verificationDraft = state.verificationDraft || {};
        state.verificationDraft.testCommand = event.target.value;
      }
      if (event.target.id === 'verificationTestPatterns') {
        state.verificationDraft = state.verificationDraft || {};
        state.verificationDraft.testPathPatterns = event.target.value;
      }
      if (event.target.id === 'verificationBaselineTestCommand') {
        state.verificationBaselineDraft = state.verificationBaselineDraft || {};
        state.verificationBaselineDraft.testCommand = event.target.value;
      }
    });
    document.addEventListener('change', function (event) {
      if (event.target.id === 'noteAsUnknown') state.noteAsUnknown = event.target.checked;
      if (event.target.id === 'verificationPersistDefaults') {
        state.verificationDraft = state.verificationDraft || {};
        state.verificationDraft.persistProjectDefaults = !!event.target.checked;
      }
      if (event.target.id === 'verificationBaselinePersistDefaults') {
        state.verificationBaselineDraft = state.verificationBaselineDraft || {};
        state.verificationBaselineDraft.persistProjectDefaults = !!event.target.checked;
      }
      if (event.target.dataset && event.target.dataset.installId) {
        state.installSelections[event.target.dataset.installId] = event.target.value;
      }
      if (event.target.id === 'runTddToggle') {
        runAction('set_tdd', { tdd: event.target.checked });
      }
    });
    document.addEventListener('keydown', function (event) {
      var answerForm = event.target.closest && event.target.closest('#answerForm');
      if (event.target.name === 'answer' && answerForm && event.key === 'Enter' && event.shiftKey && !event.isComposing) {
        event.preventDefault();
        answerForm.requestSubmit();
      }
    });
    // Rapid-fire batch keyboard shortcuts. Must only fire when the question
    // CONTAINER itself is focused, so typing "1" in the textarea is never swallowed.
    document.addEventListener('keydown', function (event) {
      var container = event.target.closest && event.target.closest('[data-batch-question]');
      if (!container || event.target !== container) return;
      if (event.key >= '1' && event.key <= '4') {
        var idx = Number(event.key) - 1;
        var optionButtons = container.querySelectorAll('[data-batch-choice]');
        if (optionButtons[idx]) {
          event.preventDefault();
          var qid = container.getAttribute('data-batch-question');
          selectBatchOption(qid, optionButtons[idx].getAttribute('data-option-id'));
          focusNextUnanswered(qid);
        }
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusAdjacentQuestion(container, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusAdjacentQuestion(container, -1);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        toggleParked(container.getAttribute('data-batch-question'), true);
      }
    });
    $("ideaFile").addEventListener('change', async function (event) { var file = event.target.files[0]; if (file) $("idea").value = await file.text(); });
    $("newRunForm").addEventListener('submit', async function (event) {
      event.preventDefault();
      var submit = event.target.querySelector('button[type="submit"]');
      var originalLabel = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'Starting reflect…';
      setNewRunFeedback('Creating the durable run and queuing the reflector…', false);
      try {
        var body = { idea:$("idea").value, tdd:$("tdd").checked, graphify:$("graphify").checked, push:$("push").checked, openPullRequest:$("openPr").checked, smallModel:$("smallModel").value || undefined, capableModel:$("capableModel").value || undefined };
        var baseBranchSelect = $("baseBranch");
        if (baseBranchSelect && !baseBranchSelect.disabled && baseBranchSelect.value) body.baseBranch = baseBranchSelect.value;
        var data = await api('/api/runs',{method:'POST',body:body});
        $("newRunDialog").close(); event.target.reset(); state.selected = data.run.runId; state.tab = 'overview'; toast('Run created and queued'); await bootstrap(true);
      } catch (error) { setNewRunFeedback(error.message, true); toast(error.message,true); }
      finally { submit.disabled = false; submit.textContent = originalLabel; }
    });
    $("settingsForm").addEventListener('submit', async function (event) {
      event.preventDefault();
      try {
        var values = collectSettingsValues();
        var data = await api('/api/settings',{method:'PUT',body:{values:values}});
        state.settings = data.settings;
        if (state.bootstrap) state.bootstrap.project.settings = data.settings;
        $("settingsDialog").close();
        toast('Settings saved');
      } catch (error) { toast(error.message,true); }
    });
    document.addEventListener('submit', async function (event) {
      if (event.target.id === 'answerForm') { event.preventDefault(); var answer = new FormData(event.target).get('answer'); await runAction('answer',{questionId:event.target.dataset.question,answer:String(answer)}); }
      if (event.target.id === 'reflectForm') {
        event.preventDefault();
        var reflectQid = event.target.dataset.question;
        var d = state.reflectDrafts[reflectQid];
        if (!d) return;
        var trim = function (value) { return String(value || '').trim(); };
        var cleaned = {
          proposedTitle: trim(d.proposedTitle),
          summary: trim(d.summary) || trim(d.restatement).slice(0, 200) || 'Confirmed brief',
          restatement: trim(d.restatement),
          goal: trim(d.goal),
          users: d.users.map(trim).filter(Boolean),
          inScope: d.inScope.map(trim).filter(Boolean),
          outOfScope: d.outOfScope.map(trim).filter(Boolean),
          assumptions: d.assumptions.map(trim).filter(Boolean),
          unknowns: d.unknowns.map(trim).filter(Boolean)
        };
        if (!cleaned.proposedTitle || !cleaned.restatement || !cleaned.goal) { toast('Feature title, restatement, and goal cannot be empty', true); return; }
        delete state.reflectDrafts[reflectQid];
        await runAction('answer', { answers: [{ questionId: reflectQid, answer: cleaned.restatement, structured: cleaned }] });
      }
      if (event.target.id === 'noteForm') {
        event.preventDefault();
        var text = state.noteText.trim();
        if (!text) { toast('Note text is required', true); return; }
        var asUnknown = state.noteAsUnknown;
        state.noteText = ''; state.noteAsUnknown = false;
        try {
          await api('/api/runs/' + encodeURIComponent(state.selected) + '/actions', { method: 'POST', body: { action: 'note', text: text, asUnknown: asUnknown } });
          toast('Note added');
          await loadRun(state.selected, false);
        } catch (error) { toast(error.message, true); }
      }
      if (event.target.id === 'knowledgeSearch') { event.preventDefault(); try { var data = await api('/api/knowledge/search',{method:'POST',body:{query:$("knowledgeQuery").value}}); $("knowledgeResults").innerHTML = data.results.length ? data.results.map(function (result) { var scoreLabel = String(result.source || '').indexOf('graphify:') === 0 ? 'structural' : Number(result.score).toFixed(3); return '<article class="item"><div class="item-head"><div class="item-title">' + esc(result.title) + '</div><span class="score">' + scoreLabel + '</span></div><div class="faint">' + esc(result.source) + '</div><p class="muted">' + esc(result.excerpt) + '</p></article>'; }).join('') : '<div class="empty">No retrieved chunks matched this query.</div>'; } catch(error) { toast(error.message,true); } }
      if (event.target.id === 'knowledgeAdd') { event.preventDefault(); try { var added = await api('/api/knowledge/add',{method:'POST',body:{path:$("knowledgePath").value}}); toast(added.changed ? 'Document indexed' : 'Document unchanged'); } catch(error) { toast(error.message,true); } }
    });
    document.addEventListener('click', async function (event) { if (event.target.id === 'refreshKnowledge') { try { var result = await api('/api/knowledge/refresh',{method:'POST'}); toast('Indexed ' + result.changed + ' changed document(s)'); } catch(error) { toast(error.message,true); } } });

    function applyDefaults() {
      if (!state.bootstrap) return;
      $("tdd").checked = state.bootstrap.project.defaults.tdd;
      $("push").checked = state.bootstrap.project.defaults.push;
      $("openPr").checked = state.bootstrap.project.defaults.openPullRequest;
      $("graphify").checked = state.bootstrap.project.graphify && state.bootstrap.project.graphify.enabled === true;
      $("smallModel").value = state.bootstrap.project.models.small;
      $("capableModel").value = state.bootstrap.project.models.capable;
      fillBaseBranchSelect();
    }
    function fillBaseBranchSelect() {
      var field = $("baseBranchField");
      var select = $("baseBranch");
      var git = state.bootstrap && state.bootstrap.project ? state.bootstrap.project.git : null;
      var branches = git && Array.isArray(git.branches) ? git.branches : [];
      var enabled = !!(git && git.enabled && branches.length);
      if (!enabled) {
        field.hidden = true;
        select.disabled = true;
        select.innerHTML = "";
        return;
      }
      var preferred = git.baseBranch;
      select.innerHTML = branches.map(function (branch) {
        return '<option value="' + attr(branch) + '"' + (branch === preferred ? ' selected' : '') + '>' + esc(branch) + '</option>';
      }).join('');
      select.disabled = false;
      field.hidden = false;
    }
    async function openNewRun() {
      try {
        var data = await api("/api/bootstrap", undefined, true);
        if (data && data.project) {
          if (!state.bootstrap) state.bootstrap = data;
          else state.bootstrap.project = data.project;
        }
      } catch (_error) {}
      applyDefaults();
      var agent = state.bootstrap && state.bootstrap.project ? state.bootstrap.project.agent : undefined;
      if (agent && agent.ready === false) {
        setNewRunFeedback('Cannot chart a route: ' + (agent.message || 'The configured agent backend is unavailable.') + ' Set the required credential, then restart the dashboard from that same terminal.', true);
      } else {
        setNewRunFeedback('', false);
      }
      $("newRunDialog").showModal();
    }
    bootstrap(false);
    setSoundsMuted(soundsMuted());
    setInterval(function () {
      if (document.visibilityState !== 'visible' || !state.bootstrap) return;
      api('/api/bootstrap', undefined, true).then(function (data) {
        state.bootstrap = data; state.runs = data.runs || []; state.unreadableRuns = data.unreadableRuns || []; renderSidebar();
        if (state.view === 'runs' && state.selected) loadRun(state.selected,false,true,true);
      }).catch(function () {});
    }, 1800);
  })();`;

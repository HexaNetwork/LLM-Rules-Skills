/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const renderInterviewScript = `    function renderBatchQuestion(q, index, total) {
      var draft = state.answerDrafts[q.id];
      if (draft == null) draft = q.draftAnswer || "";
      var selected = state.selectedOptions[q.id];
      var parked = Boolean(state.parked[q.id]);
      var clarifying = state.clarifications[q.id] != null;
      var clarifyText = clarifying ? state.clarifications[q.id] : "";
      var questionOptions = Array.isArray(q.options) ? q.options : [];
      var optionsClass = "question-options" + (getGrillOptionsLayout() === "rows" ? " layout-rows" : "");
      var options = (!clarifying && questionOptions.length) ? '<div class="' + optionsClass + '">' + questionOptions.map(function (option, i) {
        var recommended = option.id === q.recommendedOptionId;
        var isSelected = selected === option.id;
        return '<button type="button" class="question-option' + (recommended ? ' recommended' : '') + (isSelected ? ' selected' : '') + '" data-batch-choice="' + attr(q.id) + '" data-option-id="' + attr(option.id) + '" data-option-index="' + i + '"><strong>' + esc(option.label) + '</strong>' + (isSelected ? '<span class="selected-badge">Selected</span>' : (recommended ? '<span class="recommendation-badge">Recommended</span>' : '')) + '<small>' + esc(option.description) + '</small></button>';
      }).join("") + '</div>' : '';
      var context = q.context ? '<div class="question-context">' + esc(q.context) + '</div>' : '';
      var recommendation = (!clarifying && q.recommendation) ? '<div class="recommendation"><strong>Our recommendation:</strong>' + esc(q.recommendation) + '</div>' : '';
      var answered = batchQuestionAnswered(q);
      var statusTag = clarifying
        ? '<span class="tag">Wait what?</span>'
        : (parked ? '<span class="tag">Skipped</span>' : (answered ? '<span class="tag hitl">Answered</span>' : '<span class="tag">Unanswered</span>'));
      var answerArea = clarifying
        ? '<div class="batch-clarify-box"><textarea data-batch-clarify-text="' + attr(q.id) + '" placeholder="What is unclear? Ask the griller to rephrase or add precision…">' + esc(clarifyText) + '</textarea></div>'
        : '<textarea data-batch-answer="' + attr(q.id) + '" placeholder="Optional notes, or answer in your own words…">' + esc(draft) + '</textarea>';
      return '<div class="batch-question' + (parked ? ' parked' : '') + (clarifying ? ' clarifying' : '') + '" data-batch-question="' + attr(q.id) + '" tabindex="0">' +
        '<div class="item-head"><div class="card-label">Question ' + (index + 1) + ' of ' + total + '</div>' + statusTag + '</div>' +
        '<div class="question">' + esc(q.prompt) + '</div>' + context + options + recommendation +
        answerArea +
        '<div class="batch-question-foot">' +
          '<button type="button" class="btn ghost small" data-batch-clarify="' + attr(q.id) + '">' + (clarifying ? 'Cancel Wait what?' : 'Wait what?') + '</button>' +
          '<button type="button" class="btn ghost small" data-batch-skip="' + attr(q.id) + '">' + (parked ? 'Unskip' : 'Skip for now') + '</button>' +
        '</div>' +
        '</div>';
    }

    function renderQuestionBatch(s, activeQuestion) {
      var batchId = activeQuestion.batchId;
      var batch = batchId ? s.questions.filter(function (item) { return item.status === "open" && item.batchId === batchId; }) : [activeQuestion];
      if (!batch.length) batch = [activeQuestion];
      var answeredCount = batch.filter(function (q) { return batchQuestionHandled(q); }).length;
      var html = '<section class="card question-card batch-card" id="batchCard" data-testid="question-batch" data-batch-id="' + attr(batchId || activeQuestion.id) + '">';
      html += '<div class="card-label">Grill question' + (batch.length > 1 ? "s" : "") + '</div>';
      html += '<div class="keyboard-hint faint">Keys: 1–4 choose an option for the focused question · ↑/↓ move between questions · Esc skips the focused question</div>';
      html += batch.map(function (q, i) { return renderBatchQuestion(q, i, batch.length); }).join("");
      html += '<div class="batch-footer"><span class="muted" id="batchCount">' + answeredCount + ' of ' + batch.length + ' answered</span><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="acceptAllBtn">Accept all recommendations</button><button type="button" class="btn primary" id="submitBatchBtn" data-testid="submit-answers">Submit answers</button></div></div>';
      html += '<div class="form-feedback error" id="batchFeedback"' + (state.batchFeedback ? '' : ' hidden') + '>' + esc(state.batchFeedback) + '</div>';
      html += '</section>';
      return html;
    }

    function reflectListSection(key, label, items) {
      var rows = items.map(function (value, index) {
        return '<div class="reflect-list-row"><textarea data-reflect-list="' + attr(key) + '" data-reflect-index="' + index + '" rows="1">' + esc(value) + '</textarea><button type="button" class="btn small ghost" data-reflect-remove="' + attr(key) + ':' + index + '">Remove</button></div>';
      }).join("");
      return '<div class="reflect-list-section"><h3>' + esc(label) + '</h3>' + rows + '<button type="button" class="btn small" data-reflect-add="' + attr(key) + '">+ Add ' + esc(label.toLowerCase()) + '</button></div>';
    }

    function autoGrowTextarea(node) {
      if (!node || !node.style || node.tagName !== "TEXTAREA") return;
      node.style.height = "auto";
      node.style.height = Math.max(node.scrollHeight, 0) + "px";
    }

    function autoGrowReflectFields() {
      var fields = $("reflectFields");
      if (!fields) return;
      fields.querySelectorAll("textarea").forEach(autoGrowTextarea);
    }

    function renderReflectEditor(q, s) {
      var structured = s.reflectBrief && s.reflectBrief.structured;
      var reflectContext = q.context ? '<div class="question-context">' + esc(q.context) + '</div>' : '';
      var head = '<div class="card-label">Confirm feature understanding</div><div class="question">' + esc(q.prompt) + '</div>' + reflectContext;
      if (!structured) {
        return '<div class="card question-card reflect-card">' +
          head + '<div class="question-context">This run has no structured reflect brief. Archive it and start a new run.</div></div>';
      }
      if (!state.reflectDrafts[q.id]) {
        state.reflectDrafts[q.id] = {
          proposedTitle: structured.proposedTitle || "",
          summary: structured.summary || "",
          restatement: structured.restatement || "",
          goal: structured.goal || "",
          users: (structured.users || []).slice(),
          inScope: (structured.inScope || []).slice(),
          outOfScope: (structured.outOfScope || []).slice(),
          assumptions: (structured.assumptions || []).slice(),
          unknowns: (structured.unknowns || []).slice()
        };
      }
      var d = state.reflectDrafts[q.id];
      var html = '<div class="card question-card reflect-card">' + head;
      html += '<form id="reflectForm" data-testid="reflect-form" data-question="' + attr(q.id) + '"><div class="reflect-fields" id="reflectFields">';
      html += '<div class="field"><label for="reflectProposedTitle">Feature title</label><input id="reflectProposedTitle" type="text" data-reflect-field="proposedTitle" value="' + attr(d.proposedTitle) + '" placeholder="Short imperative run label…" /></div>';
      html += '<div class="field"><label for="reflectRestatement">Restatement</label><textarea id="reflectRestatement" data-reflect-field="restatement">' + esc(d.restatement) + '</textarea></div>';
      html += '<div class="field"><label for="reflectGoal">Goal</label><textarea id="reflectGoal" class="reflect-goal" data-reflect-field="goal">' + esc(d.goal) + '</textarea></div>';
      html += reflectListSection("users", "Users", d.users);
      html += reflectListSection("inScope", "In scope", d.inScope);
      html += reflectListSection("outOfScope", "Out of scope", d.outOfScope);
      html += reflectListSection("assumptions", "Assumptions", d.assumptions);
      html += reflectListSection("unknowns", "Unknowns", d.unknowns);
      html += '</div><button class="btn primary" type="submit">Confirm & continue to grill</button></form></div>';
      return html;
    }

/*__SPLIT_BATCH_DOM__*/
    function batchQuestionNode(qid) {
      return document.querySelector('[data-batch-question="' + String(qid).replace(/"/g, '') + '"]');
    }
    function updateBatchQuestionChrome(qid) {
      var node = batchQuestionNode(qid);
      if (!node) return;
      var parked = Boolean(state.parked[qid]);
      var clarifying = state.clarifications[qid] != null;
      node.classList.toggle('parked', parked);
      node.classList.toggle('clarifying', clarifying);
      var q = (state.detail.state.questions || []).find(function (item) { return item.id === qid; });
      var answered = q ? batchQuestionAnswered(q) : false;
      var tag = node.querySelector('.item-head .tag');
      if (tag) tag.textContent = clarifying ? 'Wait what?' : (parked ? 'Skipped' : (answered ? 'Answered' : 'Unanswered'));
      if (tag) tag.className = 'tag' + (!parked && !clarifying && answered ? ' hitl' : '');
      var skipBtn = node.querySelector('[data-batch-skip]');
      if (skipBtn) skipBtn.textContent = parked ? 'Unskip' : 'Skip for now';
      var clarifyBtn = node.querySelector('[data-batch-clarify]');
      if (clarifyBtn) clarifyBtn.textContent = clarifying ? 'Cancel Wait what?' : 'Wait what?';
    }
    function updateBatchFooter() {
      var card = $("batchCard"); if (!card) return;
      var qids = Array.prototype.map.call(card.querySelectorAll('[data-batch-question]'), function (n) { return n.getAttribute('data-batch-question'); });
      var questions = state.detail.state.questions || [];
      var answeredCount = qids.filter(function (qid) {
        var q = questions.find(function (item) { return item.id === qid; });
        return q ? batchQuestionHandled(q) : false;
      }).length;
      var countNode = $("batchCount");
      if (countNode) countNode.textContent = answeredCount + ' of ' + qids.length + ' answered';
      setBatchFeedback('');
    }
    function setBatchFeedback(message) {
      state.batchFeedback = message || '';
      var node = $("batchFeedback");
      if (!node) return;
      node.textContent = state.batchFeedback;
      node.hidden = !state.batchFeedback;
    }
    function selectBatchOption(qid, optionId) {
      if (state.clarifications[qid] != null) {
        delete state.clarifications[qid];
        renderRun();
      }
      if (state.selectedOptions[qid] === optionId) {
        delete state.selectedOptions[qid];
        var clearedNode = batchQuestionNode(qid);
        if (clearedNode) {
          clearedNode.querySelectorAll('[data-batch-choice]').forEach(function (btn) {
            btn.classList.remove('selected');
            var badge = btn.querySelector('.selected-badge,.recommendation-badge');
            var recommended = btn.classList.contains('recommended');
            if (badge) badge.outerHTML = recommended ? '<span class="recommendation-badge">Recommended</span>' : '';
          });
        }
        updateBatchQuestionChrome(qid);
        updateBatchFooter();
        return;
      }
      state.selectedOptions[qid] = optionId;
      delete state.parked[qid];
      var node = batchQuestionNode(qid);
      if (node) {
        node.querySelectorAll('[data-batch-choice]').forEach(function (btn) {
          var isSelected = btn.getAttribute('data-option-id') === optionId;
          btn.classList.toggle('selected', isSelected);
          var badge = btn.querySelector('.selected-badge,.recommendation-badge');
          var recommended = btn.classList.contains('recommended');
          if (badge) badge.outerHTML = isSelected ? '<span class="selected-badge">Selected</span>' : (recommended ? '<span class="recommendation-badge">Recommended</span>' : '');
          else if (isSelected) btn.insertAdjacentHTML('beforeend', '<span class="selected-badge">Selected</span>');
        });
      }
      updateBatchQuestionChrome(qid);
      updateBatchFooter();
    }
    function toggleParked(qid, forceValue) {
      var next = forceValue != null ? forceValue : !state.parked[qid];
      if (next) {
        state.parked[qid] = true;
        delete state.selectedOptions[qid];
        delete state.clarifications[qid];
        delete state.answerDrafts[qid];
        renderRun();
        return;
      }
      delete state.parked[qid];
      updateBatchQuestionChrome(qid);
      updateBatchFooter();
    }
    function toggleClarify(qid) {
      if (state.clarifications[qid] != null) {
        delete state.clarifications[qid];
      } else {
        state.clarifications[qid] = '';
        delete state.selectedOptions[qid];
        delete state.parked[qid];
        delete state.answerDrafts[qid];
      }
      renderRun();
      if (state.clarifications[qid] != null) {
        var box = document.querySelector('[data-batch-clarify-text="' + String(qid).replace(/"/g, '') + '"]');
        if (box) box.focus();
      }
    }
    function batchQuestionIds() {
      var card = $("batchCard"); if (!card) return [];
      return Array.prototype.map.call(card.querySelectorAll('[data-batch-question]'), function (n) { return n.getAttribute('data-batch-question'); });
    }
    function focusQuestion(qid) {
      var node = batchQuestionNode(qid);
      if (node) node.focus();
    }
    function focusAdjacentQuestion(fromNode, direction) {
      var ids = batchQuestionIds();
      var currentId = fromNode.getAttribute('data-batch-question');
      var index = ids.indexOf(currentId);
      if (index === -1) return;
      var next = ids[(index + direction + ids.length) % ids.length];
      focusQuestion(next);
    }
    function focusNextUnanswered(fromQid) {
      var ids = batchQuestionIds();
      var questions = state.detail.state.questions || [];
      var index = Math.max(0, ids.indexOf(fromQid));
      for (var step = 1; step <= ids.length; step++) {
        var candidate = ids[(index + step) % ids.length];
        var q = questions.find(function (item) { return item.id === candidate; });
        if (!state.parked[candidate] && state.clarifications[candidate] == null && q && !batchQuestionAnswered(q)) { focusQuestion(candidate); return; }
      }
      var submitBtn = $("submitBatchBtn");
      if (submitBtn) submitBtn.focus();
    }
    function submitBatch() {
      var card = $("batchCard"); if (!card) return;
      var ids = batchQuestionIds();
      var questions = state.detail.state.questions || [];
      var answers = [], parked = [], clarifications = [], missing = [];
      ids.forEach(function (qid) {
        if (state.parked[qid]) { parked.push(qid); return; }
        if (state.clarifications[qid] != null) {
          var ask = String(state.clarifications[qid] || '').trim();
          if (!ask) { missing.push(qid); return; }
          clarifications.push({ questionId: qid, text: ask });
          return;
        }
        var q = questions.find(function (item) { return item.id === qid; });
        var optionId = state.selectedOptions[qid];
        var draft = (state.answerDrafts[qid] || '').trim();
        if (optionId == null && !draft) { missing.push(qid); return; }
        var option = q && Array.isArray(q.options) ? q.options.find(function (o) { return o.id === optionId; }) : null;
        var answerText = draft || (option ? option.label : '');
        answers.push({ questionId: qid, answer: answerText, optionId: optionId || undefined });
      });
      if (missing.length) {
        // Explicit block over silent auto-park: an answer must be a deliberate decision.
        setBatchFeedback(missing.length + ' question(s) still need an answer, Skip, or Wait what? with a clarification.');
        focusQuestion(missing[0]);
        return;
      }
      if (!answers.length && !parked.length && !clarifications.length) { setBatchFeedback('Answer, skip, or clarify at least one question.'); return; }
      ids.forEach(function (qid) { delete state.selectedOptions[qid]; delete state.parked[qid]; delete state.answerDrafts[qid]; delete state.clarifications[qid]; });
      // Immediate — the footer sits at the bottom of a tall batch card.
      scrollMainToTop();
      runAction('answer', { answers: answers, parked: parked, clarifications: clarifications });
    }
    function acceptAllRecommendations() {
      var ids = batchQuestionIds();
      var questions = state.detail.state.questions || [];
      ids.forEach(function (qid) {
        if (state.parked[qid] || state.clarifications[qid] != null) return;
        var q = questions.find(function (item) { return item.id === qid; });
        if (!q || state.selectedOptions[qid] != null) return;
        if (q.recommendedOptionId) selectBatchOption(qid, q.recommendedOptionId);
      });
    }
    function reflectListMutate(key, mutator) {
      var q = (state.detail.state.questions || []).find(function (item) { return item.id === state.detail.state.activeQuestionId; });
      if (!q || !state.reflectDrafts[q.id]) return;
      mutator(state.reflectDrafts[q.id][key]);
      renderRun();
    }
`;

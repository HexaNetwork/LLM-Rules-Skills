/** Browser JS fragment inlined by renderDashboard (Phase 4). */
export const stateScript = `  (function () {
    "use strict";
    var params = new URLSearchParams(location.search);
    var token = params.get("token") || sessionStorage.getItem("harnessToken") || "";
    if (token) sessionStorage.setItem("harnessToken", token);
    if (params.has("token")) history.replaceState(null, "", location.pathname);
    var state = {
      bootstrap: null, runs: [], unreadableRuns: [], selected: null, detail: null, signature: "", scrolls: null,
      sidebarHtml: "",
      // Sticky error shown inline under the run vitals; survives poll re-renders
      // until dismissed or the selected run changes.
      inlineError: "",
      tab: "overview", usageTab: "model", view: "runs", filter: "", answerDrafts: {}, settings: null,
      selectedOptions: {}, parked: {}, clarifications: {}, batchFeedback: "",
      reflectDrafts: {},
      noteText: "", noteAsUnknown: false,
      grillFeedbackText: "",
      planFeedbackText: "",
      planDraft: {},
      verificationDraft: {},
      verificationBaselineDraft: {},
      elapsedTimer: null,
      cancelling: false,
      lastSoundPhase: null,
      installSelections: {},
      guidancePacks: [],
      guidanceRole: null,
      activityView: "sequence",
      expandedContexts: {},
      expandedTimelineRows: {},
      // After reflect confirm / grill batch submit, keep the viewport at the top
      // until the operator scrolls away or the follow-on job finishes — so a
      // silent poll cannot restore the deep pre-submit offset mid-flight.
      pinScrollTop: false
    };
    var $ = function (id) { return document.getElementById(id); };

    function esc(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
        return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch];
      });
    }
    function attr(value) { return esc(value).split(String.fromCharCode(10)).join("&#10;"); }
    function getGrillOptionsLayout() {
      try {
        var stored = localStorage.getItem("harnessGrillOptionsLayout");
        return stored === "rows" ? "rows" : "columns";
      } catch (error) { return "columns"; }
    }
    function setGrillOptionsLayout(value) {
      var layout = value === "rows" ? "rows" : "columns";
      try { localStorage.setItem("harnessGrillOptionsLayout", layout); } catch (error) { /* ignore quota / private mode */ }
      return layout;
    }
    function soundsMuted() {
      try { return localStorage.getItem("harnessSoundsMuted") === "1"; } catch (error) { return false; }
    }
    function setSoundsMuted(muted) {
      try { localStorage.setItem("harnessSoundsMuted", muted ? "1" : "0"); } catch (error) { /* ignore */ }
      var btn = $("soundMuteBtn");
      if (btn) btn.textContent = muted ? "Sound off" : "Sound on";
    }
    function playTone(kind) {
      if (soundsMuted()) return;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!playTone.ctx) playTone.ctx = new Ctx();
        var ctx = playTone.ctx;
        if (ctx.state === "suspended") ctx.resume();
        var now = ctx.currentTime;
        var specs = {
          awaiting_input: [523.25, 659.25, 0.08, 0.12],
          error: [220, 164.81, 0.12, 0.18],
          completed: [392, 523.25, 0.1, 0.16]
        };
        var spec = specs[kind] || specs.awaiting_input;
        [spec[0], spec[1]].forEach(function (freq, index) {
          var osc = ctx.createOscillator();
          var gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02 + index * spec[2]);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + spec[3] + index * spec[2]);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + index * spec[2]);
          osc.stop(now + spec[3] + index * spec[2] + 0.05);
        });
      } catch (error) { /* Web Audio unavailable */ }
    }
    function maybePlayPhaseSound(phase) {
      if (!phase || phase === state.lastSoundPhase) return;
      var previous = state.lastSoundPhase;
      state.lastSoundPhase = phase;
      if (previous == null) return;
      if (phase === "awaiting_input") playTone("awaiting_input");
      else if (phase === "blocked") playTone("error");
      else if (phase === "completed") playTone("completed");
    }
    function applyGrillOptionsLayout() {
      var rows = getGrillOptionsLayout() === "rows";
      Array.prototype.forEach.call(document.querySelectorAll(".question-options"), function (node) {
        if (rows) node.classList.add("layout-rows");
        else node.classList.remove("layout-rows");
      });
    }
    function safeUrl(value) { var url = String(value || ""); return url.startsWith("https://") || url.startsWith("http://") ? url : "#"; }
    function date(value) { if (!value) return "—"; return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(value)); }
    // Local wall-clock HH:MM from ISO timestamps (startedAt is stored as UTC ISO).
    function clockTime(value) {
      if (!value) return "—";
      var d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";
      return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }
    function ago(value) {
      if (!value) return "";
      var seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return seconds + "s ago";
      if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
      return Math.floor(seconds / 86400) + "d ago";
    }
    function elapsed(sinceValue) {
      if (!sinceValue) return "";
      var seconds = Math.max(0, Math.floor((Date.now() - new Date(sinceValue).getTime()) / 1000));
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return m > 0 ? (m + "m " + String(s).padStart(2, "0") + "s") : (s + "s");
    }
    function compactElapsed(sinceValue) {
      if (!sinceValue) return "";
      var seconds = Math.max(0, Math.floor((Date.now() - new Date(sinceValue).getTime()) / 1000));
      var m = Math.floor(seconds / 60), s = seconds % 60;
      return m > 0 ? (m + "m" + String(s).padStart(2, "0") + "s") : (s + "s");
    }
    function activityLine(activity) {
      if (!activity) return "";
      var parts = [];
      if (activity.role) parts.push(String(activity.role));
      if (activity.model) parts.push(String(activity.model));
      if (activity.startedAt) parts.push(compactElapsed(activity.startedAt));
      if (activity.lastStepSummary) parts.push(String(activity.lastStepSummary));
      return parts.join(" · ");
    }
    // Ticks every second without a full re-render, so it must not disturb scroll or focus.
    function startElapsedTimer(sinceValue) {
      stopElapsedTimer();
      var node = $("thinkingElapsed");
      if (!node) return;
      state.elapsedTimer = setInterval(function () {
        var target = $("thinkingElapsed");
        if (!target) { stopElapsedTimer(); return; }
        target.textContent = elapsed(sinceValue);
      }, 1000);
    }
    function stopElapsedTimer() {
      if (state.elapsedTimer) { clearInterval(state.elapsedTimer); state.elapsedTimer = null; }
    }
    function effectivePhase(run) { return run && run.job ? run.job.status : (run ? run.phase : ""); }
    function phaseLabel(phase) { return String(phase || "unknown").replaceAll("_", " "); }
    function shortTitle(value, limit) {
      var normalized = String(value || "Untitled run").replaceAll(String.fromCharCode(10), " ").replaceAll(String.fromCharCode(9), " ").split(" ").filter(Boolean).join(" ").trim();
      var max = limit || 88;
      if (normalized.length <= max) return normalized;
      var candidate = normalized.slice(0, max - 1);
      var boundary = candidate.lastIndexOf(" ");
      if (boundary > Math.floor(max * .6)) candidate = candidate.slice(0, boundary);
      return candidate + "…";
    }
    function editorIsActive() {
      var active = document.activeElement;
      return Boolean(active && active.matches && active.matches("textarea,input,select") && active.closest("form"));
    }
    // A batch card can be half-filled with NO control focused; a silent poll
    // must not clobber that progress.
    function batchIsActive() {
      var card = $("batchCard");
      if (!card) return false;
      var active = document.activeElement;
      if (active && active.closest && active.closest("[data-batch-question]")) return true;
      var nodes = card.querySelectorAll("[data-batch-question]");
      for (var i = 0; i < nodes.length; i++) {
        var qid = nodes[i].getAttribute("data-batch-question");
        if (state.selectedOptions[qid] != null) return true;
        if (state.parked[qid]) return true;
        if (state.clarifications[qid] != null) return true;
        if (state.answerDrafts[qid] && String(state.answerDrafts[qid]).trim().length) return true;
      }
      return false;
    }
    function releaseScrollTopPin() {
      if (!state.pinScrollTop) return;
      state.pinScrollTop = false;
      if (state.scrolls) {
        state.scrolls.windowX = window.scrollX;
        state.scrolls.windowY = window.scrollY;
      }
    }
    function captureScrolls() {
      var nodes = {};
      var details = {};
      document.querySelectorAll("[data-scroll-key]").forEach(function (node) {
        var key = node.getAttribute("data-scroll-key");
        if (!key) return;
        nodes[key] = { top: node.scrollTop, left: node.scrollLeft };
      });
      document.querySelectorAll("[data-details-key]").forEach(function (node) {
        var key = node.getAttribute("data-details-key");
        if (!key) return;
        details[key] = node.open;
      });
      var runList = $("runList");
      if (runList) nodes.runList = { top: runList.scrollTop, left: runList.scrollLeft };
      // Pin only fights the post-submit race that would restore a deep offset.
      // Once the operator scrolls away from top, stop yanking them back up on
      // every activity-driven silent poll during a long thinking wait.
      if (state.pinScrollTop && window.scrollY > 0) releaseScrollTopPin();
      if (state.pinScrollTop) window.scrollTo(0, 0);
      state.scrolls = {
        windowX: state.pinScrollTop ? 0 : window.scrollX,
        windowY: state.pinScrollTop ? 0 : window.scrollY,
        nodes: nodes,
        details: details
      };
    }
    function restoreScrolls() {
      var scrolls = state.scrolls;
      if (!scrolls) return;
      Object.keys(scrolls.nodes || {}).forEach(function (key) {
        var node = key === "runList" ? $("runList") : document.querySelector('[data-scroll-key="' + key.replace(/"/g, "") + '"]');
        if (!node) return;
        node.scrollTop = scrolls.nodes[key].top;
        node.scrollLeft = scrolls.nodes[key].left;
      });
      Object.keys(scrolls.details || {}).forEach(function (key) {
        var node = document.querySelector('[data-details-key="' + key.replace(/"/g, "") + '"]');
        if (node) node.open = scrolls.details[key];
      });
      if (state.pinScrollTop && window.scrollY > 0) releaseScrollTopPin();
      if (state.pinScrollTop) window.scrollTo(0, 0);
      else if (scrolls.windowY != null) window.scrollTo(scrolls.windowX || 0, scrolls.windowY);
    }
    // Answers (reflect confirm + grill batch) leave the user deep in a tall form.
    // Scroll immediately — do not wait for the follow-on job — and pin restored
    // window coords so a silent poll cannot jump them back down mid-work.
    // Pin after scrollTo so a scroll listener never treats this jump as operator intent.
    function scrollMainToTop() {
      window.scrollTo(0, 0);
      var content = $("content");
      if (content) content.scrollTop = 0;
      state.pinScrollTop = true;
      if (state.scrolls) {
        state.scrolls.windowX = 0;
        state.scrolls.windowY = 0;
      } else {
        state.scrolls = { windowX: 0, windowY: 0, nodes: {}, details: {} };
      }
    }
    window.addEventListener("scroll", function () {
      if (state.pinScrollTop && window.scrollY > 0) releaseScrollTopPin();
    }, { passive: true });
    function hideToast() {
      var node = $("toast");
      node.className = "toast";
      $("toastMessage").textContent = "";
      $("toastDismiss").hidden = true;
      clearTimeout(toast.timer);
    }
    // Run-view errors belong next to the run, not floating over unrelated
    // content. When the run page is rendered they go inline under the vitals;
    // the fixed toast remains for successes and errors outside the run view.
    function showRunError(message) {
      var slot = $("runErrorSlot");
      if (!slot) return false;
      state.inlineError = String(message || "Action failed");
      slot.innerHTML = renderInlineError();
      return true;
    }
    function toast(message, error) {
      if (error && showRunError(message)) { hideToast(); return; }
      var node = $("toast");
      $("toastMessage").textContent = message;
      $("toastDismiss").hidden = !error;
      node.className = "toast show" + (error ? " error" : "");
      clearTimeout(toast.timer);
      // Errors stay until dismissed; brief success notices still auto-hide.
      if (!error) toast.timer = setTimeout(hideToast, 3500);
    }
    function setNewRunFeedback(message, error) {
      var node = $("newRunFeedback");
      // The submit button already conveys normal progress. Reserve this space
      // for actionable failures so the dialog stays visually quiet by default.
      if (!error) message = "";
      node.textContent = message || "";
      node.hidden = !message;
      node.className = "form-feedback" + (error ? " error" : "");
    }
`;

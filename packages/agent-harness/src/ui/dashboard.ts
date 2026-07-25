/**
 * Single-file dashboard served by the loopback UI server.
 *
 * Constraints: this is a TS template literal, so the embedded HTML/JS must not
 * contain backticks or "${" — client JS uses string concatenation throughout.
 * No external assets: strict same-origin, works offline.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Agent Harness</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='7' fill='%230b6e4f'/%3E%3C/svg%3E" />
<style>
  :root {
    --bg: #f7f6f3; --panel: #ffffff; --panel-2: #f1efe9; --border: #e1ddd3;
    --ink: #1d1b17; --muted: #6f6a5f; --accent: #0b6e4f; --accent-ink: #ffffff;
    --ok: #0b6e4f; --ok-bg: #e3f2ea; --warn: #92610a; --warn-bg: #fdf0d7;
    --err: #a3332c; --err-bg: #fbe6e4; --info: #22557a; --info-bg: #e3edf5;
    --idle: #6f6a5f; --idle-bg: #edebe4;
    --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
    --shadow: 0 1px 3px rgba(20,18,12,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a; --panel: #1c1f24; --panel-2: #23262c; --border: #30343b;
      --ink: #e8e6e1; --muted: #9a978f; --accent: #34a37f; --accent-ink: #0c1512;
      --ok: #4cc39a; --ok-bg: #17352b; --warn: #e0b25c; --warn-bg: #3a2f17;
      --err: #e88a83; --err-bg: #3d211f; --info: #7fb3d8; --info-bg: #1d2f3d;
      --idle: #9a978f; --idle-bg: #2a2d33;
      --shadow: 0 1px 3px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  .layout { display: grid; grid-template-columns: 300px minmax(0,1fr); min-height: 100vh; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

  /* ---------- sidebar ---------- */
  .sidebar {
    border-right: 1px solid var(--border); background: var(--panel);
    padding: 1rem; display: flex; flex-direction: column; gap: 1rem;
  }
  .brand { display: flex; align-items: center; gap: .55rem; }
  .brand svg { flex: none; }
  .brand h1 { font-size: 1rem; margin: 0; letter-spacing: .02em; }
  .brand .sub { font-size: .72rem; color: var(--muted); }
  textarea, input[type=text] {
    width: 100%; padding: .55rem .6rem; border: 1px solid var(--border); border-radius: 8px;
    background: var(--panel-2); color: var(--ink); font: inherit; resize: vertical;
  }
  textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  button {
    font: inherit; font-weight: 600; border: 1px solid transparent; border-radius: 8px;
    padding: .5rem .9rem; cursor: pointer; background: var(--accent); color: var(--accent-ink);
  }
  button.ghost { background: transparent; color: var(--ink); border-color: var(--border); font-weight: 500; }
  button.danger { background: transparent; color: var(--err); border-color: var(--err); }
  button:disabled { opacity: .5; cursor: default; }
  .composer { display: flex; flex-direction: column; gap: .5rem; }
  .runlist { display: flex; flex-direction: column; gap: .25rem; overflow-y: auto; flex: 1; min-height: 0; }
  .runlist-head { display: flex; justify-content: space-between; align-items: baseline; }
  .runlist-head h2 { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0; }
  .run-item {
    display: flex; align-items: center; gap: .55rem; width: 100%; text-align: left;
    padding: .45rem .55rem; border-radius: 8px; background: transparent; color: var(--ink);
    border: 1px solid transparent; font-weight: 500; cursor: pointer;
  }
  .run-item:hover { background: var(--panel-2); }
  .run-item.active { background: var(--panel-2); border-color: var(--border); }
  .run-item .rid { font-family: var(--mono); font-size: .8rem; }
  .run-item .meta { margin-left: auto; text-align: right; font-size: .7rem; color: var(--muted); font-weight: 400; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .empty { color: var(--muted); font-size: .85rem; padding: .5rem; }

  /* ---------- main ---------- */
  .main { padding: 1.25rem 1.5rem; display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem; box-shadow: var(--shadow); }
  .card h2 { margin: 0 0 .7rem; font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }

  .run-head { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; }
  .run-head .rid { font-family: var(--mono); font-size: 1.05rem; font-weight: 600; }
  .pill {
    display: inline-flex; align-items: center; gap: .35rem; padding: .18rem .6rem;
    border-radius: 999px; font-size: .74rem; font-weight: 600; white-space: nowrap;
  }
  .chip {
    display: inline-flex; align-items: center; gap: .3rem; padding: .18rem .55rem;
    border-radius: 6px; font-size: .74rem; background: var(--panel-2); color: var(--muted);
    border: 1px solid var(--border); font-family: var(--mono);
  }
  .head-actions { margin-left: auto; display: flex; gap: .5rem; }
  a.prlink { color: var(--accent); font-weight: 600; text-decoration: none; }
  a.prlink:hover { text-decoration: underline; }
  .banner { border-radius: 8px; padding: .55rem .8rem; font-size: .85rem; margin-top: .7rem; }
  .banner.warn { background: var(--warn-bg); color: var(--warn); }
  .banner.err { background: var(--err-bg); color: var(--err); }

  /* stepper */
  .stepper { display: flex; gap: .25rem; margin-top: .9rem; flex-wrap: wrap; }
  .step { display: flex; align-items: center; gap: .4rem; font-size: .78rem; color: var(--muted); }
  .step .node {
    width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center;
    justify-content: center; font-size: .68rem; font-weight: 700;
    background: var(--idle-bg); color: var(--idle); border: 1px solid var(--border);
  }
  .step.done .node { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
  .step.now .node { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
  .step.now { color: var(--ink); font-weight: 600; }
  .step.fail .node { background: var(--err-bg); color: var(--err); border-color: transparent; }
  .step .bar { width: 26px; height: 2px; background: var(--border); margin: 0 .15rem; }

  /* decision */
  .question { border: 1px solid var(--border); border-radius: 10px; padding: .8rem; margin-bottom: .7rem; background: var(--panel-2); }
  .question .qtext { font-weight: 600; margin-bottom: .3rem; }
  .question .qctx { font-size: .82rem; color: var(--muted); margin-bottom: .5rem; }
  .decision-actions { display: flex; gap: .6rem; }

  /* tasks */
  .taskgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: .8rem; }
  .task { border: 1px solid var(--border); border-radius: 10px; padding: .8rem .9rem; background: var(--panel); display: flex; flex-direction: column; gap: .5rem; }
  .task-top { display: flex; align-items: center; gap: .5rem; }
  .task-top .tid { font-family: var(--mono); font-size: .78rem; color: var(--muted); }
  .task-title { font-weight: 600; }
  .phase-row { display: flex; gap: .35rem; flex-wrap: wrap; }
  .blocked-detail { font-size: .8rem; color: var(--err); background: var(--err-bg); border-radius: 6px; padding: .4rem .6rem; }
  ul.criteria { list-style: none; margin: 0; padding: 0; font-size: .82rem; }
  ul.criteria li { display: flex; gap: .4rem; align-items: baseline; padding: .12rem 0; }
  ul.criteria .mark { font-weight: 700; }
  ul.criteria .mark.ok { color: var(--ok); }
  ul.criteria .mark.bad { color: var(--err); }
  .finding { border-left: 3px solid var(--err); padding: .3rem .6rem; margin: .3rem 0; font-size: .8rem; background: var(--err-bg); border-radius: 0 6px 6px 0; }
  .finding.advisory { border-left-color: var(--warn); background: var(--warn-bg); }
  .finding .floc { font-family: var(--mono); font-size: .72rem; color: var(--muted); }
  details { border: none; }
  details > summary { cursor: pointer; font-size: .78rem; color: var(--muted); user-select: none; }
  details[open] > summary { margin-bottom: .3rem; }

  /* timeline */
  .timeline { max-height: 420px; overflow-y: auto; display: flex; flex-direction: column; }
  .evt { display: grid; grid-template-columns: 64px 10px minmax(0,1fr); gap: .6rem; padding: .28rem 0; align-items: baseline; }
  .evt time { font-family: var(--mono); font-size: .72rem; color: var(--muted); text-align: right; }
  .evt .edot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); align-self: center; }
  .evt .elabel { font-size: .84rem; min-width: 0; }
  .evt .elabel .etask { font-family: var(--mono); font-size: .72rem; color: var(--muted); margin-left: .4rem; }
  .evt .edetail { font-family: var(--mono); font-size: .72rem; color: var(--muted); overflow-wrap: anywhere; }

  pre.raw {
    font-family: var(--mono); font-size: .74rem; background: var(--panel-2); border: 1px solid var(--border);
    border-radius: 8px; padding: .7rem; overflow: auto; max-height: 420px; white-space: pre-wrap; margin: 0;
  }
  .placeholder { color: var(--muted); text-align: center; padding: 4rem 1rem; }
  .hide { display: none !important; }

  /* pill palettes keyed by tone */
  .tone-ok   { background: var(--ok-bg);   color: var(--ok); }
  .tone-err  { background: var(--err-bg);  color: var(--err); }
  .tone-warn { background: var(--warn-bg); color: var(--warn); }
  .tone-info { background: var(--info-bg); color: var(--info); }
  .tone-idle { background: var(--idle-bg); color: var(--idle); }
  .bg-ok { background: var(--ok); } .bg-err { background: var(--err); }
  .bg-warn { background: var(--warn); } .bg-info { background: var(--info); } .bg-idle { background: var(--idle); }
</style>
</head>
<body>
<div class="layout">
  <aside class="sidebar">
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="none" stroke="var(--accent)" stroke-width="2"/><circle cx="13" cy="13" r="5" fill="var(--accent)"/></svg>
      <div>
        <h1>Agent Harness</h1>
        <div class="sub">loopback dashboard</div>
      </div>
    </div>
    <div class="composer">
      <textarea id="idea" rows="5" placeholder="Describe the change you want the harness to build&hellip;"></textarea>
      <button id="start">Start run</button>
    </div>
    <div class="runlist-head">
      <h2>Runs</h2>
      <button class="ghost" id="reload" style="padding:.15rem .5rem;font-size:.72rem">refresh</button>
    </div>
    <div class="runlist" id="runs"><div class="empty">No runs yet.</div></div>
  </aside>

  <main class="main">
    <div id="placeholder" class="placeholder">Select a run or start a new one.</div>

    <div id="detail" class="hide">
      <div class="card" id="headcard">
        <div class="run-head">
          <span class="rid" id="h-runid" title="Click to copy"></span>
          <span class="pill tone-idle" id="h-status">&mdash;</span>
          <span class="chip hide" id="h-branch"></span>
          <a class="prlink hide" id="h-pr" target="_blank" rel="noopener">View PR &rarr;</a>
          <div class="head-actions">
            <button class="ghost hide" id="h-resume">Resume</button>
            <button class="danger" id="h-cancel">Cancel</button>
          </div>
        </div>
        <div class="stepper" id="stepper"></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem" id="h-chips"></div>
        <div id="h-banner"></div>
      </div>

      <div class="card hide" id="decisioncard" style="margin-top:1rem">
        <h2>Decision required</h2>
        <div id="questions"></div>
        <div class="decision-actions">
          <button id="approve">Approve &amp; resume</button>
          <button class="danger" id="reject">Reject run</button>
        </div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h2>Tasks</h2>
        <div class="taskgrid" id="tasks"><div class="empty">No tasks yet &mdash; planning in progress.</div></div>
      </div>

      <div class="card" style="margin-top:1rem">
        <h2>Timeline</h2>
        <div class="timeline" id="timeline"></div>
      </div>

      <div class="card" style="margin-top:1rem">
        <details>
          <summary>Raw state &amp; artifacts (debug)</summary>
          <pre class="raw" id="raw"></pre>
        </details>
      </div>
    </div>
  </main>
</div>

<script>
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var $ = function (id) { return document.getElementById(id); };
  var currentRunId = null;
  var lastDetail = null;
  var es = null;
  var pollTimer = null;

  var ACTIVE = { intake:1, refining:1, awaiting_decision:1, prepared:1, approved:1, running:1, paused:1 };
  var STATUS_TONE = {
    intake:'info', refining:'info', awaiting_decision:'warn', prepared:'info', approved:'info',
    running:'info', paused:'warn', partial:'warn', blocked:'err', succeeded:'ok', failed:'err', cancelled:'idle'
  };
  var TASK_TONE = {
    pending:'idle', ready:'info', writing_tests:'info', awaiting_red:'info', implementing:'info',
    awaiting_green:'info', refactoring:'info', working:'info', verifying:'info', repairing:'warn',
    accepted:'ok', blocked:'err', blocked_dependency:'err', skipped:'idle'
  };
  var EVENT_TONE = {
    'run.finished':'ok', 'run.approved':'ok', 'task.accepted':'ok', 'tdd.green':'ok', 'tdd.red':'ok',
    'final_gate.passed':'ok', 'publish.pr_opened':'ok', 'gates.finished':'info',
    'task.blocked':'err', 'task.blocked_dependency':'err', 'agent.failed':'err', 'budget.exhausted':'err',
    'final_gate.failed':'err', 'publish.push_failed':'err', 'publish.pr_failed':'err',
    'run.paused':'warn', 'run.awaiting_decision':'warn', 'task.repairing':'warn', 'run.cancelled':'idle'
  };
  var EVENT_LABEL = {
    'run.created':'Run created', 'run.intake':'Intake captured', 'run.refining':'Refining plan',
    'run.awaiting_decision':'Awaiting operator decision', 'run.decision':'Decision recorded',
    'run.approved':'Manifest approved', 'run.started':'Execution started', 'run.paused':'Run paused',
    'run.resumed':'Run resumed', 'run.cancelled':'Run cancelled', 'run.finished':'Run finished',
    'task.working':'Worker started', 'task.writing_tests':'Writing tests', 'task.red':'RED phase',
    'task.implementing':'Implementing', 'task.green':'GREEN phase', 'task.refactoring':'Refactoring',
    'task.verifying':'Verifying', 'task.repairing':'Repairing', 'task.accepted':'Task accepted',
    'task.blocked':'Task blocked', 'task.blocked_dependency':'Blocked by dependency',
    'worker.finished':'Worker finished', 'test_author.finished':'Test author finished',
    'implementer.finished':'Implementer finished', 'spec_review.finished':'Spec review finished',
    'standards_review.finished':'Standards review finished', 'review.aggregated':'Reviews aggregated',
    'verifier.finished':'Verifier finished', 'yagni.finished':'YAGNI check finished',
    'tdd.red':'TDD: red confirmed', 'tdd.green':'TDD: green confirmed', 'tdd.refactor':'TDD: refactor done',
    'gates.finished':'Command gates finished', 'final_gate.failed':'Final gate failed',
    'final_gate.passed':'Final gate passed', 'publish.push_failed':'Push failed',
    'publish.pr_failed':'PR creation failed', 'publish.pr_opened':'PR opened',
    'agent.failed':'Agent failed', 'budget.exhausted':'Retry budget exhausted'
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function api(path, opts) {
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(path + sep + 'token=' + encodeURIComponent(token), opts);
  }
  function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }
  function relTime(iso) {
    if (!iso) return '';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 5) return 'now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function clock(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour12: false }); } catch (e) { return ''; }
  }
  function pill(text, tone) {
    return '<span class="pill tone-' + (tone || 'idle') + '">' + esc(text) + '</span>';
  }

  /* ---------- run list ---------- */
  function renderRuns(runs) {
    var el = $('runs');
    if (!runs.length) { el.innerHTML = '<div class="empty">No runs yet.</div>'; return; }
    var html = '';
    for (var i = 0; i < runs.length; i++) {
      var r = runs[i];
      var tone = STATUS_TONE[r.status] || 'idle';
      html += '<button class="run-item' + (r.runId === currentRunId ? ' active' : '') + '" data-run="' + esc(r.runId) + '">'
        + '<span class="dot bg-' + tone + '"></span>'
        + '<span class="rid">' + esc(r.runId.slice(0, 8)) + '</span>'
        + '<span class="meta">' + esc(r.status) + '<br>' + esc(relTime(r.updatedAt)) + '</span>'
        + '</button>';
    }
    el.innerHTML = html;
    var items = el.querySelectorAll('.run-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function () { watch(this.getAttribute('data-run')); });
    }
  }
  function listRuns() {
    return api('/api/runs').then(function (res) {
      if (!res.ok) return [];
      return res.json().then(function (b) { renderRuns(b.runs || []); return b.runs || []; });
    }).catch(function () { return []; });
  }

  /* ---------- stepper ---------- */
  function renderStepper(status) {
    var steps = ['Intake', 'Refine', 'Decision', 'Execute', 'Done'];
    var idx = { intake:0, refining:1, awaiting_decision:2, prepared:3, approved:3, running:3, paused:3,
                partial:4, blocked:4, succeeded:4, failed:4, cancelled:4 }[status];
    if (idx == null) idx = 0;
    var terminal = { succeeded:'done', partial:'fail', blocked:'fail', failed:'fail', cancelled:'now' }[status];
    var html = '';
    for (var i = 0; i < steps.length; i++) {
      var cls = i < idx ? 'done' : (i === idx ? (i === 4 && terminal ? terminal : 'now') : '');
      html += '<span class="step ' + cls + '"><span class="node">' + (i < idx || cls === 'done' ? '&check;' : (i + 1)) + '</span>' + steps[i] + '</span>';
      if (i < steps.length - 1) html += '<span class="step"><span class="bar"></span></span>';
    }
    $('stepper').innerHTML = html;
  }

  /* ---------- decision panel ---------- */
  function questionsFrom(body) {
    var qs = (body.policy && body.policy.unresolvedSnapshot) || [];
    if (!qs.length && body.draft && body.draft.unresolvedQuestions) qs = body.draft.unresolvedQuestions;
    return qs;
  }
  function renderDecision(body) {
    var card = $('decisioncard');
    if (!body.state || body.state.status !== 'awaiting_decision') { card.classList.add('hide'); return; }
    card.classList.remove('hide');
    var qs = questionsFrom(body);
    var html = '';
    if (!qs.length) {
      html = '<div class="empty">The policy paused this run: '
        + esc(body.state.pauseReason || 'operator approval required')
        + '. Approve to continue.</div>';
    }
    for (var i = 0; i < qs.length; i++) {
      var q = qs[i];
      var tone = q.classification === 'DESTRUCTIVE_RISK' ? 'err' : (q.classification === 'DECISION_REQUIRED' ? 'warn' : 'info');
      html += '<div class="question" data-qid="' + esc(q.id) + '">'
        + '<div class="qtext">' + esc(q.text) + ' ' + pill(q.classification, tone) + '</div>'
        + (q.context ? '<div class="qctx">' + esc(q.context) + '</div>' : '')
        + '<input type="text" class="answer" placeholder="Your answer&hellip;" value="' + esc(q.proposedAnswer || '') + '" />'
        + '</div>';
    }
    $('questions').innerHTML = html;
  }
  function collectAnswers() {
    var out = [];
    var nodes = $('questions').querySelectorAll('.question');
    for (var i = 0; i < nodes.length; i++) {
      var input = nodes[i].querySelector('.answer');
      var v = input ? input.value.trim() : '';
      if (v) out.push({ questionId: nodes[i].getAttribute('data-qid'), answer: v });
    }
    return out;
  }

  /* ---------- tasks ---------- */
  function taskTitle(body, taskId) {
    var lists = [];
    if (body.manifest && body.manifest.tasks) lists.push(body.manifest.tasks);
    if (body.draft && body.draft.tasks) lists.push(body.draft.tasks);
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        if (lists[i][j].id === taskId) return lists[i][j].title || '';
      }
    }
    return '';
  }
  function renderTasks(body) {
    var tasks = (body.state && body.state.tasks) || [];
    var el = $('tasks');
    if (!tasks.length) {
      el.innerHTML = '<div class="empty">No tasks yet &mdash; planning in progress.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      var tone = TASK_TONE[t.status] || 'idle';
      html += '<div class="task">';
      html += '<div class="task-top"><span class="tid">' + esc(t.taskId) + '</span>' + pill(t.status.replace(/_/g, ' '), tone);
      if (t.commitSha) html += '<span class="chip" title="' + esc(t.commitSha) + '">' + esc(t.commitSha.slice(0, 7)) + '</span>';
      html += '</div>';
      var title = taskTitle(body, t.taskId);
      if (title) html += '<div class="task-title">' + esc(title) + '</div>';

      if (t.tddEvidence && t.tddEvidence.length) {
        html += '<div class="phase-row">';
        for (var p = 0; p < t.tddEvidence.length; p++) {
          var ph = t.tddEvidence[p];
          html += pill(ph.phase + (ph.passed ? ' \\u2713' : ' \\u2717'), ph.passed ? 'ok' : 'err');
        }
        html += '</div>';
      }
      if (t.lastGateResults && t.lastGateResults.length) {
        html += '<div class="phase-row">';
        for (var g = 0; g < t.lastGateResults.length; g++) {
          var gate = t.lastGateResults[g];
          html += pill('gate: ' + gate.gateId + (gate.passed ? ' \\u2713' : ' \\u2717'), gate.passed ? 'ok' : 'err');
        }
        html += '</div>';
      }
      if (t.blockedReason) {
        html += '<div class="blocked-detail"><strong>' + esc(t.blockedReason) + '</strong>'
          + (t.blockedDetail ? ' &mdash; ' + esc(t.blockedDetail) : '') + '</div>';
      }
      var review = t.lastAggregateReview;
      if (review && review.acceptance && review.acceptance.length) {
        html += '<details><summary>Acceptance (' + review.acceptance.filter(function (a) { return a.satisfied; }).length
          + '/' + review.acceptance.length + ' satisfied)</summary><ul class="criteria">';
        for (var a = 0; a < review.acceptance.length; a++) {
          var c = review.acceptance[a];
          html += '<li><span class="mark ' + (c.satisfied ? 'ok' : 'bad') + '">' + (c.satisfied ? '\\u2713' : '\\u2717')
            + '</span><span><strong>' + esc(c.criterionId) + '</strong> ' + esc(c.evidence) + '</span></li>';
        }
        html += '</ul></details>';
      }
      var findings = (review && review.findings) || [];
      var advisories = t.advisories || [];
      if (findings.length || advisories.length) {
        html += '<details><summary>Findings (' + (findings.length + advisories.length) + ')</summary>';
        var all = findings.concat(advisories);
        for (var f = 0; f < all.length; f++) {
          var fd = all[f];
          html += '<div class="finding' + (fd.severity === 'ADVISORY' ? ' advisory' : '') + '">'
            + '<strong>' + esc(fd.severity) + '</strong> ' + esc(fd.criterionOrRule)
            + '<div class="floc">' + esc(fd.location) + '</div>'
            + esc(fd.remediation) + '</div>';
        }
        html += '</details>';
      }
      var report = t.lastWorkerReport;
      if (report && report.summary) {
        html += '<details><summary>Worker summary</summary><div style="font-size:.82rem">' + esc(report.summary);
        if (report.changedPaths && report.changedPaths.length) {
          html += '<div class="floc" style="margin-top:.3rem">' + esc(report.changedPaths.join(', ')) + '</div>';
        }
        html += '</div></details>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  }

  /* ---------- timeline ---------- */
  function renderTimeline(body) {
    var events = ((body.state && body.state.events) || []).slice().reverse();
    var html = '';
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      var tone = EVENT_TONE[e.type] || 'idle';
      var label = EVENT_LABEL[e.type] || e.type;
      var detail = '';
      if (e.detail && Object.keys(e.detail).length) {
        var compact = JSON.stringify(e.detail);
        if (compact.length > 160) compact = compact.slice(0, 157) + '...';
        detail = '<div class="edetail">' + esc(compact) + '</div>';
      }
      html += '<div class="evt"><time>' + esc(clock(e.at)) + '</time>'
        + '<span class="edot bg-' + tone + '"></span>'
        + '<div class="elabel">' + esc(label)
        + (e.taskId ? '<span class="etask">' + esc(e.taskId) + '</span>' : '')
        + detail + '</div></div>';
    }
    $('timeline').innerHTML = html || '<div class="empty">No events yet.</div>';
  }

  /* ---------- header ---------- */
  function renderHeader(body) {
    var st = body.state || {};
    $('h-runid').textContent = (st.runId || '').slice(0, 8) + '\\u2026';
    $('h-runid').setAttribute('data-full', st.runId || '');
    var tone = STATUS_TONE[st.status] || 'idle';
    $('h-status').className = 'pill tone-' + tone;
    $('h-status').textContent = (st.status || 'unknown').replace(/_/g, ' ');
    var branch = $('h-branch');
    if (st.branchName) { branch.classList.remove('hide'); branch.textContent = st.branchName; }
    else branch.classList.add('hide');
    var pr = $('h-pr');
    var prUrl = st.prUrl || (body.report && body.report.prUrl);
    if (prUrl) { pr.classList.remove('hide'); pr.href = prUrl; } else pr.classList.add('hide');

    var chips = '';
    if (st.cost) {
      if (st.cost.agentLaunches) chips += '<span class="chip">agents: ' + st.cost.agentLaunches + '</span>';
      if (st.cost.inputTokens || st.cost.outputTokens) {
        chips += '<span class="chip">tokens: ' + st.cost.inputTokens + ' in / ' + st.cost.outputTokens + ' out</span>';
      }
    }
    if (st.createdAt) chips += '<span class="chip">started ' + esc(relTime(st.createdAt)) + '</span>';
    $('h-chips').innerHTML = chips;

    var banner = '';
    if (st.status === 'paused' && st.pauseReason) {
      banner = '<div class="banner warn">Paused: ' + esc(st.pauseReason) + (st.resumable ? ' (resumable)' : '') + '</div>';
    }
    if (body.error) banner += '<div class="banner err">Background error: ' + esc(body.error) + '</div>';
    $('h-banner').innerHTML = banner;

    $('h-resume').classList.toggle('hide', !(st.status === 'paused' && st.resumable !== false));
    $('h-cancel').disabled = !ACTIVE[st.status];
    renderStepper(st.status);
  }

  /* ---------- detail refresh ---------- */
  function refresh() {
    if (!currentRunId) return Promise.resolve();
    return api('/api/runs/' + encodeURIComponent(currentRunId)).then(function (res) {
      if (!res.ok) return;
      return res.json().then(function (body) {
        lastDetail = body;
        $('placeholder').classList.add('hide');
        $('detail').classList.remove('hide');
        renderHeader(body);
        renderDecision(body);
        renderTasks(body);
        renderTimeline(body);
        $('raw').textContent = JSON.stringify({
          state: body.state, intake: body.intake, draft: body.draft,
          policy: body.policy, manifest: body.manifest, report: body.report
        }, null, 2);
      });
    }).catch(function () { /* transient */ });
  }

  /* ---------- live wiring ---------- */
  function connect(runId) {
    if (es) es.close();
    var url = '/api/events?token=' + encodeURIComponent(token)
      + (runId ? '&runId=' + encodeURIComponent(runId) : '');
    es = new EventSource(url);
    es.onmessage = function (msg) {
      var data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data.detail && data.detail.hello) return;
      if (!currentRunId && data.runId) watch(data.runId);
      else { refresh(); listRuns(); }
    };
  }
  function watch(runId) {
    currentRunId = runId;
    var next = new URL(location.href);
    next.searchParams.set('runId', runId);
    history.replaceState({}, '', next);
    connect(runId);
    refresh();
    listRuns();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function () { refresh(); listRuns(); }, 2000);
  }

  /* ---------- actions ---------- */
  $('start').addEventListener('click', function () {
    var idea = $('idea').value.trim();
    if (!idea) { $('idea').focus(); return; }
    $('start').disabled = true;
    post('/api/runs', { idea: idea }).then(function (res) { return res.json(); }).then(function (body) {
      $('start').disabled = false;
      if (body.runId) { $('idea').value = ''; watch(body.runId); }
    }).catch(function () { $('start').disabled = false; });
  });
  $('reload').addEventListener('click', function () { listRuns(); refresh(); });
  $('h-cancel').addEventListener('click', function () {
    if (!currentRunId) return;
    post('/api/runs/' + encodeURIComponent(currentRunId) + '/cancel').then(refresh);
  });
  $('h-resume').addEventListener('click', function () {
    if (!currentRunId) return;
    post('/api/runs/' + encodeURIComponent(currentRunId) + '/resume', { approve: true }).then(refresh);
  });
  $('approve').addEventListener('click', function () {
    if (!currentRunId) return;
    post('/api/runs/' + encodeURIComponent(currentRunId) + '/decide', {
      answers: collectAnswers(), approve: true
    }).then(refresh);
  });
  $('reject').addEventListener('click', function () {
    if (!currentRunId) return;
    post('/api/runs/' + encodeURIComponent(currentRunId) + '/decide', { approve: false }).then(refresh);
  });
  $('h-runid').addEventListener('click', function () {
    var full = this.getAttribute('data-full');
    if (full && navigator.clipboard) navigator.clipboard.writeText(full);
  });

  /* ---------- boot ---------- */
  var fromUrl = params.get('runId');
  listRuns().then(function (runs) {
    var pick = fromUrl;
    if (!pick) {
      for (var i = 0; i < runs.length; i++) { if (ACTIVE[runs[i].status]) { pick = runs[i].runId; break; } }
    }
    if (!pick && runs.length) pick = runs[0].runId;
    if (pick) watch(pick);
    else connect();
  });
})();
</script>
</body>
</html>`;

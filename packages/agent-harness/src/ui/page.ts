export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Harness</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Bahnschrift, "Trebuchet MS", sans-serif;
      --ink: #17201d;
      --muted: #67736e;
      --faint: #8e9994;
      --line: #d9e0dc;
      --line-strong: #bcc8c2;
      --paper: #f7faf8;
      --surface: #ffffff;
      --rail: #edf3ef;
      --accent: #17684f;
      --accent-soft: #dceee6;
      --attention: #a75c12;
      --attention-soft: #faead8;
      --danger: #a33b36;
      --danger-soft: #f8e5e2;
      --info: #315f7d;
      --shadow: 0 14px 38px rgba(24, 48, 39, .08);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(110deg, rgba(29, 105, 80, .035) 1px, transparent 1px) 0 0 / 32px 32px,
        linear-gradient(20deg, #f8fbf9 0%, #f3f7f5 56%, #eef4f1 100%);
    }
    button, input, textarea, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .shell { display: grid; grid-template-columns: 312px minmax(0, 1fr); min-height: 100%; }
    .sidebar {
      position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column;
      border-right: 1px solid var(--line); background: rgba(237, 243, 239, .94);
      backdrop-filter: blur(14px); overflow: hidden;
    }
    .brand { padding: 25px 22px 18px; border-bottom: 1px solid var(--line); }
    .brand-mark { display: flex; align-items: center; gap: 11px; }
    .waypoint { width: 16px; height: 16px; border: 2px solid var(--accent); transform: rotate(45deg); position: relative; }
    .waypoint::after { content: ""; position: absolute; width: 4px; height: 4px; background: var(--accent); top: 4px; left: 4px; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: .02em; }
    .brand p { margin: 6px 0 0 27px; color: var(--muted); font-size: 12px; }
    .new-run-toggle {
      margin: 16px; min-height: 42px; border: 1px solid var(--line-strong); border-radius: 9px;
      background: var(--surface); color: var(--ink); font-weight: 600;
    }
    .new-run-toggle:hover { border-color: var(--accent); color: var(--accent); }
    .start-panel { display: none; margin: 0 16px 16px; padding: 15px; border: 1px solid var(--line); background: var(--surface); }
    .start-panel.open { display: block; }
    label { display: block; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
    input, textarea, select {
      width: 100%; margin-top: 6px; border: 1px solid var(--line-strong); border-radius: 7px;
      background: #fbfdfc; color: var(--ink); padding: 9px 10px; outline: none;
    }
    textarea { resize: vertical; min-height: 76px; line-height: 1.45; }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23, 104, 79, .1); }
    .field { margin-top: 11px; }
    .field-row { display: grid; grid-template-columns: 1fr 100px; gap: 9px; margin-top: 11px; }
    .primary, .secondary, .danger, .quiet {
      min-height: 36px; padding: 7px 13px; border-radius: 7px; font-weight: 600; border: 1px solid transparent;
    }
    .primary { background: var(--accent); color: white; }
    .primary:hover { background: #105740; }
    .secondary { background: var(--surface); border-color: var(--line-strong); color: var(--ink); }
    .secondary:hover { border-color: var(--accent); color: var(--accent); }
    .danger { background: var(--surface); border-color: #deb3af; color: var(--danger); }
    .danger:hover { background: var(--danger-soft); }
    .quiet { background: transparent; color: var(--muted); }
    .quiet:hover { background: rgba(23, 104, 79, .07); color: var(--accent); }
    .full { width: 100%; margin-top: 12px; }
    .sidebar-section { min-height: 0; display: flex; flex: 1; flex-direction: column; }
    .section-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 20px 8px; }
    .section-head h2 { margin: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .run-list { min-height: 0; overflow-y: auto; padding: 0 9px 18px; }
    .run-row {
      width: 100%; display: grid; grid-template-columns: 4px minmax(0, 1fr); gap: 10px;
      border: 0; border-radius: 8px; padding: 11px 10px; background: transparent; text-align: left; color: inherit;
    }
    .run-row:hover { background: rgba(255,255,255,.7); }
    .run-row.selected { background: var(--surface); box-shadow: 0 1px 0 rgba(24,48,39,.06); }
    .status-bar { width: 4px; border-radius: 2px; background: var(--info); }
    .status-bar.awaiting_input { background: var(--attention); }
    .status-bar.blocked, .status-bar.cancelled { background: var(--danger); }
    .status-bar.completed { background: var(--accent); }
    .run-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; font-weight: 600; }
    .run-meta { display: flex; justify-content: space-between; gap: 6px; margin-top: 5px; color: var(--muted); font-size: 11px; }
    .sidebar-foot { padding: 12px 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
    .workspace { min-width: 0; padding: 26px clamp(20px, 4vw, 58px) 48px; }
    .empty-state { min-height: calc(100vh - 74px); display: grid; place-items: center; }
    .empty-copy { max-width: 510px; text-align: center; }
    .empty-copy .waypoint { margin: 0 auto 22px; width: 28px; height: 28px; }
    .empty-copy .waypoint::after { width: 8px; height: 8px; top: 8px; left: 8px; }
    .empty-copy h2 { margin: 0; font-size: clamp(25px, 4vw, 40px); font-weight: 570; letter-spacing: -.025em; }
    .empty-copy p { color: var(--muted); line-height: 1.65; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; margin-bottom: 22px; }
    .eyebrow { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
    .run-heading { margin: 5px 0 0; max-width: 820px; font-size: clamp(22px, 3vw, 34px); font-weight: 570; line-height: 1.15; letter-spacing: -.02em; }
    .top-meta { display: flex; align-items: center; gap: 9px; margin-top: 11px; color: var(--muted); font-size: 12px; }
    .status {
      display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px;
      border: 1px solid var(--line); border-radius: 6px; background: rgba(255,255,255,.62); font-weight: 650;
    }
    .status::before { content: ""; width: 7px; height: 7px; background: var(--info); }
    .status.awaiting_input { color: var(--attention); border-color: #ebcba8; background: var(--attention-soft); }
    .status.awaiting_input::before { background: var(--attention); }
    .status.blocked, .status.cancelled { color: var(--danger); border-color: #e5bdb8; background: var(--danger-soft); }
    .status.blocked::before, .status.cancelled::before { background: var(--danger); }
    .status.completed { color: var(--accent); background: var(--accent-soft); }
    .status.completed::before { background: var(--accent); }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .phase-track {
      display: flex; gap: 0; overflow-x: auto; margin: 0 0 24px; padding: 0 0 12px;
      border-bottom: 1px solid var(--line);
    }
    .phase-step { display: flex; align-items: center; flex: 0 0 auto; color: var(--faint); font-size: 11px; }
    .phase-step::after { content: ""; width: 22px; height: 1px; margin: 0 8px; background: var(--line-strong); }
    .phase-step:last-child::after { display: none; }
    .phase-step.current { color: var(--accent); font-weight: 700; }
    .phase-step.done { color: var(--muted); }
    .gate {
      margin-bottom: 24px; border: 1px solid #e8c497; border-left: 4px solid var(--attention);
      background: linear-gradient(100deg, #fff9f0, #fffdf9); box-shadow: var(--shadow);
    }
    .gate-head { padding: 18px 20px 15px; border-bottom: 1px solid #f0dcc2; }
    .gate-head .eyebrow { color: var(--attention); }
    .gate h3 { margin: 5px 0 0; font-size: 18px; }
    .questions { padding: 4px 20px 18px; }
    .question { padding: 15px 0; border-bottom: 1px solid #efe5d8; }
    .question:last-child { border-bottom: 0; }
    .question-title { display: flex; justify-content: space-between; gap: 16px; color: var(--ink); font-size: 14px; line-height: 1.45; }
    .park { width: auto; margin: 1px 5px 0 0; accent-color: var(--attention); }
    .park-label { display: flex; align-items: center; flex: 0 0 auto; color: var(--muted); font-size: 11px; font-weight: 500; }
    .choice-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .choice {
      border: 1px solid var(--line-strong); border-radius: 6px; background: white; padding: 7px 10px; color: var(--ink);
    }
    .choice.selected { border-color: var(--attention); background: var(--attention-soft); color: #7d430d; }
    .gate-footer { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: 14px; padding: 0 20px 20px; }
    .gate-footer textarea { min-height: 52px; }
    .block {
      margin-bottom: 24px; padding: 16px 18px; border-left: 4px solid var(--danger);
      background: var(--danger-soft); color: #702d29;
    }
    .content-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(260px, .8fr); gap: 22px; align-items: start; }
    .stack { display: grid; gap: 22px; }
    .panel { border-top: 2px solid var(--ink); padding-top: 13px; }
    .panel-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .panel h3 { margin: 0; font-size: 15px; letter-spacing: .02em; }
    .count { color: var(--faint); font: 11px "Cascadia Mono", Consolas, monospace; }
    .artifact { padding: 15px 0; border-top: 1px solid var(--line); }
    .artifact:first-child { border-top: 0; padding-top: 0; }
    .artifact h4 { margin: 0 0 8px; color: var(--accent); font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .artifact-body { color: #34413c; font-size: 13px; line-height: 1.58; overflow-wrap: anywhere; }
    pre.artifact-body {
      margin: 0; padding: 12px; border: 1px solid var(--line); background: rgba(255,255,255,.58);
      font: 12px/1.55 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap;
    }
    .item-list { list-style: none; padding: 0; margin: 0; }
    .item { padding: 11px 0; border-top: 1px solid var(--line); }
    .item:first-child { border-top: 0; padding-top: 0; }
    .item-line { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .item-title { font-size: 13px; font-weight: 600; line-height: 1.4; }
    .item-state { flex: 0 0 auto; color: var(--muted); font: 10px "Cascadia Mono", Consolas, monospace; text-transform: uppercase; }
    .item-copy { margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .activity { position: relative; padding-left: 18px; }
    .activity::before { content: ""; position: absolute; left: 3px; top: 5px; bottom: 6px; width: 1px; background: var(--line-strong); }
    .event { position: relative; padding: 0 0 15px; }
    .event::before { content: ""; position: absolute; left: -18px; top: 4px; width: 7px; height: 7px; background: var(--surface); border: 2px solid var(--accent); }
    .event-main { font-size: 12px; font-weight: 600; }
    .event-time { margin-top: 3px; color: var(--faint); font: 10px "Cascadia Mono", Consolas, monospace; }
    .empty-inline { color: var(--faint); font-size: 12px; line-height: 1.5; }
    .project-box { margin: 0 16px 13px; padding-top: 12px; border-top: 1px solid var(--line); }
    .project-box summary { color: var(--muted); cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .project-list { margin: 9px 0; color: var(--muted); font-size: 11px; }
    .project-entry { overflow: hidden; padding: 4px 0; text-overflow: ellipsis; white-space: nowrap; }
    .toast {
      position: fixed; right: 22px; bottom: 22px; z-index: 20; max-width: min(420px, calc(100vw - 44px));
      padding: 12px 15px; border: 1px solid var(--line-strong); background: var(--surface); box-shadow: var(--shadow);
      color: var(--ink); font-size: 12px; transform: translateY(20px); opacity: 0; pointer-events: none; transition: .18s ease;
    }
    .toast.show { transform: translateY(0); opacity: 1; }
    .toast.error { border-color: #dda8a3; color: var(--danger); }
    .mobile-head { display: none; }
    @media (max-width: 820px) {
      .shell { display: block; }
      .sidebar { position: fixed; z-index: 12; width: min(88vw, 330px); transform: translateX(-102%); transition: transform .2s ease; box-shadow: var(--shadow); }
      body.nav-open .sidebar { transform: translateX(0); }
      .mobile-head {
        position: sticky; top: 0; z-index: 8; display: flex; align-items: center; justify-content: space-between;
        padding: 11px 14px; border-bottom: 1px solid var(--line); background: rgba(247,250,248,.92); backdrop-filter: blur(12px);
      }
      .mobile-head button { border: 1px solid var(--line); background: white; border-radius: 6px; padding: 7px 10px; }
      .workspace { padding: 20px 16px 38px; }
      .content-grid { grid-template-columns: 1fr; }
      .topbar { display: block; }
      .actions { justify-content: flex-start; margin-top: 16px; }
      .gate-footer { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .field-row { grid-template-columns: 1fr; }
      .run-heading { font-size: 23px; }
      .actions button { flex: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="mobile-head"><strong>Agent Harness</strong><button id="nav-toggle" type="button">Runs</button></div>
  <div class="shell">
    <aside class="sidebar">
      <header class="brand">
        <div class="brand-mark"><span class="waypoint"></span><h1>Agent Harness</h1></div>
        <p>Durable wayfinder operations</p>
      </header>
      <button class="new-run-toggle" id="new-run-toggle" type="button">Start a new run</button>
      <form class="start-panel" id="start-form">
        <label>Idea<textarea id="idea" required placeholder="Describe the outcome, constraint, or ticket…"></textarea></label>
        <div class="field-row">
          <label>Project<select id="project"></select></label>
          <label>Workflow<select id="workflow"><option value="default">Default</option><option value="ticket">Ticket</option></select></label>
        </div>
        <button class="primary full" type="submit">Begin wayfinding</button>
      </form>
      <details class="project-box">
        <summary>Registered projects</summary>
        <div id="projects" class="project-list"></div>
        <form id="project-form">
          <label>Local repository path<input id="project-path" placeholder="D:\\Dev\\project" /></label>
          <button class="secondary full" type="submit">Register project</button>
        </form>
      </details>
      <section class="sidebar-section">
        <div class="section-head"><h2>Runs</h2><button class="quiet" id="refresh" type="button">Refresh</button></div>
        <div class="run-list" id="runs"></div>
      </section>
      <footer class="sidebar-foot">Loopback only · token authenticated</footer>
    </aside>
    <main class="workspace" id="detail">
      <div class="empty-state"><div class="empty-copy"><span class="waypoint"></span><h2>Choose a run or chart a new one.</h2><p>The dashboard follows the host lifecycle. Gates, fog, evidence, and task progress remain durable between visits.</p></div></div>
    </main>
  </div>
  <div class="toast" id="toast" role="status"></div>
  <script>
    const token = new URLSearchParams(location.search).get("token") || "";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const app = { runs: [], projects: [], selectedId: null, run: null, activity: [], sessions: [], signature: "", drafts: {} };
    const phases = ["reflect","grill","glossary","verification-settings","plan","prd","scenarios","operator-gate","slice","implement","scenario-test","crystallize","final-review","publish"];
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
    const words = (value) => String(value || "").replace(/[-_]/g, " ");
    const shortId = (value) => String(value || "").slice(0, 8);
    const relative = (value) => {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return "just now";
      if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
      return Math.floor(seconds / 86400) + "d ago";
    };
    const toast = (message, error) => {
      el("toast").textContent = message;
      el("toast").className = "toast show" + (error ? " error" : "");
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => { el("toast").className = "toast"; }, 3200);
    };
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }
    function runLabel(run) {
      const idea = String(run.state.idea || "").trim();
      return idea || "Untitled run " + shortId(run.identity.runId);
    }
    function renderRuns() {
      const sorted = [...app.runs].sort((a, b) => String(b.state.updatedAt).localeCompare(String(a.state.updatedAt)));
      el("runs").innerHTML = sorted.length ? sorted.map((run) =>
        '<button type="button" class="run-row' + (app.selectedId === run.identity.runId ? ' selected' : '') + '" data-run="' + esc(run.identity.runId) + '">' +
          '<span class="status-bar ' + esc(run.state.status) + '"></span><span><span class="run-title">' + esc(runLabel(run)) + '</span>' +
          '<span class="run-meta"><span>' + esc(words(run.state.phase)) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></span></span></button>'
      ).join("") : '<div class="empty-inline" style="padding:14px 11px">No runs yet.</div>';
    }
    function renderProjects() {
      el("projects").innerHTML = app.projects.length ? app.projects.map((project) =>
        '<div class="project-entry" title="' + esc(project.controlRoot) + '">' + esc(project.controlRoot) + '</div>'
      ).join("") : '<div class="empty-inline">No registered projects.</div>';
      const current = el("project").value;
      el("project").innerHTML = app.projects.length ? app.projects.map((project) =>
        '<option value="' + esc(project.projectKey) + '">' + esc(project.controlRoot.split(/[\\\\/]/).filter(Boolean).pop() || project.projectKey) + '</option>'
      ).join("") : '<option value="">Register a project first</option>';
      if (app.projects.some((project) => project.projectKey === current)) el("project").value = current;
    }
    function renderPhases(run) {
      const bundle = run.identity.workflowBundleId === "ticket" ? ["implement","scenario-test","publish"] : phases;
      const current = bundle.indexOf(run.state.phase);
      return bundle.map((phase, index) =>
        '<span class="phase-step ' + (index === current ? 'current' : index < current ? 'done' : '') + '">' + esc(words(phase)) + '</span>'
      ).join("");
    }
    function answerControl(q, draft) {
      const value = draft.answers[q.id] != null ? draft.answers[q.id] : (q.recommended || "");
      if (q.kind === "choice" || q.kind === "confirm") {
        const choices = q.choices && q.choices.length ? q.choices : ["yes", "no"];
        return '<div class="choice-row">' + choices.map((choice) =>
          '<button type="button" class="choice' + (String(value) === String(choice) ? ' selected' : '') + '" data-choice="' + esc(q.id) + '" data-value="' + esc(choice) + '">' + esc(choice) + '</button>'
        ).join("") + '</div>';
      }
      return '<textarea data-answer="' + esc(q.id) + '" placeholder="Operator response">' + esc(value) + '</textarea>';
    }
    function renderGate(run) {
      const gate = run.state.gate;
      if (!gate) return "";
      const draft = app.drafts[run.identity.runId] || { answers: {}, parked: {}, notes: "" };
      app.drafts[run.identity.runId] = draft;
      return '<section class="gate"><header class="gate-head"><div class="eyebrow">Operator input required</div><h3>' + esc(gate.title) + '</h3></header>' +
        '<div class="questions">' + gate.questions.map((q) =>
          '<div class="question"><div class="question-title"><span>' + esc(q.prompt) + '</span>' +
          '<label class="park-label"><input class="park" type="checkbox" data-park="' + esc(q.id) + '"' + (draft.parked[q.id] ? ' checked' : '') + '>Park</label></div>' +
          answerControl(q, draft) + '</div>'
        ).join("") + '</div><div class="gate-footer"><label>Batch notes<textarea id="gate-notes" placeholder="Context that applies to the whole batch">' + esc(draft.notes || "") + '</textarea></label>' +
        '<button class="primary" type="button" data-action="answer">Submit batch</button></div></section>';
    }
    function artifactBody(value) {
      if (typeof value === "string") return '<div class="artifact-body">' + esc(value).replace(/\\n/g, "<br>") + '</div>';
      return '<pre class="artifact-body">' + esc(JSON.stringify(value, null, 2)) + '</pre>';
    }
    function renderArtifacts(artifacts) {
      const entries = Object.entries(artifacts || {});
      const priority = ["brief","prd","plan","scenario","scenarios","summary"];
      entries.sort((a, b) => {
        const ai = priority.indexOf(a[0]); const bi = priority.indexOf(b[0]);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
      return entries.length ? entries.map(([name, value]) =>
        '<article class="artifact"><h4>' + esc(words(name)) + '</h4>' + artifactBody(value) + '</article>'
      ).join("") : '<div class="empty-inline">The brief and planning artifacts will appear as phases complete.</div>';
    }
    function renderFog(fog) {
      return fog.length ? '<ul class="item-list">' + fog.map((item) =>
        '<li class="item"><div class="item-line"><span class="item-title">' + esc(item.text) + '</span><span class="item-state">' + esc(item.status) + '</span></div></li>'
      ).join("") + '</ul>' : '<div class="empty-inline">No unresolved fog recorded.</div>';
    }
    function renderTasks(tasks) {
      return tasks.length ? '<ul class="item-list">' + tasks.map((task) =>
        '<li class="item"><div class="item-line"><span class="item-title">' + esc(task.title) + '</span><span class="item-state">' + esc(words(task.status)) + '</span></div>' +
        (task.description ? '<div class="item-copy">' + esc(task.description) + '</div>' : '') + '</li>'
      ).join("") + '</ul>' : '<div class="empty-inline">Tasks will arrive after slicing.</div>';
    }
    function renderActivity(activity) {
      const recent = [...activity].reverse().slice(0, 12);
      return recent.length ? '<div class="activity">' + recent.map((event) =>
        '<div class="event"><div class="event-main">' + esc(words(event.phase || "run")) + ' · ' + esc(words(event.status || "updated")) + '</div>' +
        '<div class="event-time">' + esc(relative(event.at)) + (event.revision != null ? ' · revision ' + esc(event.revision) : '') + '</div></div>'
      ).join("") + '</div>' : '<div class="empty-inline">No lifecycle activity recorded yet.</div>';
    }
    function renderSessions(sessions) {
      const recent = [...sessions].reverse().slice(0, 6);
      return recent.length ? '<ul class="item-list">' + recent.map((session) =>
        '<li class="item"><div class="item-line"><span class="item-title">' + esc(words(session.role || "agent session")) + '</span>' +
        '<span class="item-state">' + esc(session.at ? relative(session.at) : "recorded") + '</span></div>' +
        (session.packet && session.packet.phase ? '<div class="item-copy">' + esc(words(session.packet.phase)) + ' phase</div>' : '') + '</li>'
      ).join("") + '</ul>' : '<div class="empty-inline">No agent sessions recorded yet.</div>';
    }
    function renderDetail() {
      const run = app.run;
      if (!run) return;
      const terminal = run.state.status === "completed" || run.state.status === "cancelled";
      const blocked = run.state.status === "blocked";
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">' + esc(run.identity.projectKey) + ' · ' + esc(run.identity.workflowBundleId) + ' workflow</div>' +
        '<h2 class="run-heading">' + esc(runLabel(run)) + '</h2><div class="top-meta"><span class="status ' + esc(run.state.status) + '">' + esc(words(run.state.status)) + '</span>' +
        '<span>' + esc(words(run.state.phase)) + '</span><span>rev ' + esc(run.state.revision) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></div></div>' +
        '<div class="actions"><button class="secondary" data-action="continue" type="button"' + (terminal || run.state.status === "awaiting_input" ? ' disabled' : '') + '>Continue</button>' +
        '<button class="secondary" data-action="retry" type="button"' + (!blocked || run.state.block && !run.state.block.retriable ? ' disabled' : '') + '>Retry</button>' +
        '<button class="danger" data-action="cancel" type="button"' + (terminal ? ' disabled' : '') + '>Cancel</button></div></header>' +
        '<nav class="phase-track" aria-label="Run phases">' + renderPhases(run) + '</nav>' +
        (run.state.block ? '<div class="block"><strong>Run blocked.</strong> ' + esc(run.state.block.reason) + '</div>' : '') +
        renderGate(run) +
        '<div class="content-grid"><div class="stack"><section class="panel"><div class="panel-title"><h3>Brief & evidence</h3><span class="count">' + Object.keys(run.state.artifacts || {}).length + ' artifacts</span></div>' +
        renderArtifacts(run.state.artifacts) + '</section><section class="panel"><div class="panel-title"><h3>Tasks</h3><span class="count">' + run.state.tasks.length + '</span></div>' +
        renderTasks(run.state.tasks) + '</section></div><aside class="stack"><section class="panel"><div class="panel-title"><h3>Unknowns & fog</h3><span class="count">' + run.state.fog.length + '</span></div>' +
        renderFog(run.state.fog) + '</section><section class="panel"><div class="panel-title"><h3>Recent activity</h3><span class="count">' + app.activity.length + ' events</span></div>' +
        renderActivity(app.activity) + '</section><section class="panel"><div class="panel-title"><h3>Agent sessions</h3><span class="count">' + app.sessions.length + '</span></div>' +
        renderSessions(app.sessions) + '</section><section class="panel"><div class="panel-title"><h3>Run identity</h3></div>' +
        '<div class="item-copy"><strong>ID</strong><br>' + esc(run.identity.runId) + '<br><br><strong>Worktree</strong><br>' + esc(run.identity.worktreePath) + '</div></section></aside></div>';
    }
    async function loadProjects() {
      app.projects = await api("/api/projects");
      renderProjects();
    }
    async function refresh(options = {}) {
      const runs = await api("/api/runs");
      app.runs = runs;
      renderRuns();
      if (!app.selectedId && options.selectFirst && runs[0]) app.selectedId = runs[0].identity.runId;
      if (app.selectedId) await openRun(app.selectedId, Boolean(options.force));
    }
    async function openRun(id, force) {
      app.selectedId = id;
      const [run, activity, sessions] = await Promise.all([
        api("/api/runs/" + encodeURIComponent(id)),
        api("/api/runs/" + encodeURIComponent(id) + "/activity"),
        api("/api/runs/" + encodeURIComponent(id) + "/sessions"),
      ]);
      const signature = id + ":" + run.state.revision + ":" + run.state.status + ":" + run.state.phase + ":" + activity.length + ":" + sessions.length;
      app.run = run; app.activity = activity; app.sessions = sessions;
      renderRuns();
      if (force || signature !== app.signature) {
        app.signature = signature;
        renderDetail();
      }
    }
    async function mutate(action, payload) {
      if (!app.selectedId) return;
      try {
        await api("/api/runs/" + encodeURIComponent(app.selectedId) + "/" + action, { method: "POST", body: JSON.stringify(payload || {}) });
        if (action === "answer") delete app.drafts[app.selectedId];
        await refresh({ force: true });
      } catch (error) { toast(error.message, true); }
    }
    el("new-run-toggle").onclick = () => el("start-form").classList.toggle("open");
    el("nav-toggle").onclick = () => document.body.classList.toggle("nav-open");
    el("refresh").onclick = () => refresh({ force: true }).catch((error) => toast(error.message, true));
    el("runs").onclick = (event) => {
      const button = event.target.closest("[data-run]");
      if (!button) return;
      document.body.classList.remove("nav-open");
      openRun(button.dataset.run, true).catch((error) => toast(error.message, true));
    };
    el("project-form").onsubmit = async (event) => {
      event.preventDefault();
      const controlRoot = el("project-path").value.trim();
      if (!controlRoot) return;
      try {
        await api("/api/projects", { method: "POST", body: JSON.stringify({ controlRoot }) });
        el("project-path").value = "";
        await loadProjects();
        toast("Project registered");
      } catch (error) { toast(error.message, true); }
    };
    el("start-form").onsubmit = async (event) => {
      event.preventDefault();
      const idea = el("idea").value.trim();
      const projectKey = el("project").value;
      if (!idea || !projectKey) return toast("Choose a project and enter an idea.", true);
      const button = event.submitter;
      button.disabled = true;
      try {
        const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ idea, projectKey, workflowBundleId: el("workflow").value }) });
        el("idea").value = "";
        el("start-form").classList.remove("open");
        app.selectedId = run.identity.runId;
        await refresh({ force: true });
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
    };
    el("detail").addEventListener("input", (event) => {
      if (!app.selectedId || !app.run || !app.run.state.gate) return;
      const draft = app.drafts[app.selectedId] || { answers: {}, parked: {}, notes: "" };
      app.drafts[app.selectedId] = draft;
      if (event.target.dataset.answer) draft.answers[event.target.dataset.answer] = event.target.value;
      if (event.target.dataset.park) draft.parked[event.target.dataset.park] = event.target.checked;
      if (event.target.id === "gate-notes") draft.notes = event.target.value;
    });
    el("detail").addEventListener("click", (event) => {
      const choice = event.target.closest("[data-choice]");
      if (choice && app.selectedId) {
        const draft = app.drafts[app.selectedId] || { answers: {}, parked: {}, notes: "" };
        app.drafts[app.selectedId] = draft;
        draft.answers[choice.dataset.choice] = choice.dataset.value;
        document.querySelectorAll('[data-choice="' + CSS.escape(choice.dataset.choice) + '"]').forEach((node) => node.classList.toggle("selected", node === choice));
        return;
      }
      const action = event.target.closest("[data-action]");
      if (!action || action.disabled) return;
      if (action.dataset.action === "cancel" && !confirm("Cancel this run and destroy its sandbox?")) return;
      if (action.dataset.action === "answer") {
        const draft = app.drafts[app.selectedId] || { answers: {}, parked: {}, notes: "" };
        const parked = Object.keys(draft.parked).filter((key) => draft.parked[key]);
        mutate("answer", { answers: draft.answers, parked, notes: draft.notes });
        return;
      }
      mutate(action.dataset.action);
    });
    Promise.all([loadProjects(), refresh({ selectFirst: true, force: true })]).catch((error) => toast(error.message, true));
    setInterval(() => refresh().catch(() => {}), 4000);
  </script>
</body>
</html>`;
}

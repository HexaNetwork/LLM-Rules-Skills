import { RUN_TITLE_MAX_LEN, RUN_TITLE_PLACEHOLDER } from "../domain/run-title.js";

export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>HexAgent Harness</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Bahnschrift, "Trebuchet MS", sans-serif;
      --ink: #e8eaed;
      --muted: #9aa0a8;
      --faint: #6f7580;
      --line: #2a2e35;
      --line-strong: #3d434d;
      --paper: #111318;
      --surface: #181b21;
      --rail: #14161b;
      --field: #0f1115;
      --accent: #b6f236;
      --accent-hover: #c9ff55;
      --accent-soft: #1f2a14;
      --on-accent: #12141a;
      --accent-ring: rgba(182, 242, 54, .22);
      --attention: #e9a24a;
      --attention-soft: #2a2012;
      --attention-line: #5a4220;
      --danger: #e0746c;
      --danger-soft: #2c1715;
      --danger-line: #6a3a36;
      --info: #7eb8d4;
      --shadow: 0 14px 38px rgba(0, 0, 0, .48);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        linear-gradient(110deg, rgba(255, 255, 255, .03) 1px, transparent 1px) 0 0 / 32px 32px,
        linear-gradient(20deg, #111318 0%, #13161c 56%, #0e1014 100%);
    }
    button, input, textarea, select { font: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .shell { display: grid; grid-template-columns: 312px minmax(0, 1fr); min-height: 100%; }
    .sidebar {
      position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column;
      border-right: 1px solid var(--line); background: color-mix(in srgb, var(--rail) 94%, transparent);
      backdrop-filter: blur(14px); overflow: hidden;
    }
    .brand { padding: 25px 22px 18px; border-bottom: 1px solid var(--line); }
    .brand-mark { display: flex; align-items: center; gap: 11px; }
    .waypoint {
      width: 16px; height: 18px; display: block; flex: 0 0 auto; color: var(--accent);
    }
    .waypoint polygon { fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linejoin: round; }
    .waypoint .hex-core { fill: currentColor; stroke: none; }
    h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: .02em; }
    .brand p { margin: 6px 0 0 27px; color: var(--muted); font-size: 12px; }
    .new-run-toggle {
      margin: 16px; min-height: 42px; border: 1px solid var(--line-strong); border-radius: 9px;
      background: var(--surface); color: var(--ink); font-weight: 600;
    }
    .new-run-toggle:hover { border-color: var(--accent); color: var(--accent); }
    .new-run-toggle.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    label { display: block; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .02em; }
    input, textarea, select {
      width: 100%; margin-top: 6px; border: 1px solid var(--line-strong); border-radius: 7px;
      background: var(--field); color: var(--ink); padding: 9px 10px; outline: none;
    }
    textarea { resize: vertical; min-height: 76px; line-height: 1.45; }
    .reflect-fields { padding: 16px 20px 0; }
    .reflect-fields textarea { min-height: 52px; }
    input:focus, textarea:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .field { margin-top: 11px; }
    .lede { margin: 10px 0 0; max-width: 34rem; color: var(--muted); font-size: 15px; line-height: 1.65; }
    .compose { max-width: 720px; }
    .compose textarea { min-height: 168px; }
    .compose-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(180px, .65fr); gap: 14px; margin-top: 16px; }
    .compose .primary { margin-top: 18px; min-width: 196px; }
    .empty-copy .primary { margin-top: 22px; }
    .primary, .secondary, .danger, .quiet {
      min-height: 36px; padding: 7px 13px; border-radius: 7px; font-weight: 600; border: 1px solid transparent;
    }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover { background: var(--accent-hover); }
    .secondary { background: var(--surface); border-color: var(--line-strong); color: var(--ink); }
    .secondary:hover { border-color: var(--accent); color: var(--accent); }
    .danger { background: var(--surface); border-color: var(--danger-line); color: var(--danger); }
    .danger:hover { background: var(--danger-soft); }
    .quiet { background: transparent; color: var(--muted); }
    .quiet:hover { background: var(--accent-soft); color: var(--accent); }
    .full { width: 100%; margin-top: 12px; }
    .sidebar-section { min-height: 0; display: flex; flex: 1; flex-direction: column; }
    .section-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 20px 8px; }
    .section-head h2 { margin: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
    .run-list { min-height: 0; overflow-y: auto; padding: 0 9px 18px; }
    .run-row {
      width: 100%; display: grid; grid-template-columns: 4px minmax(0, 1fr); gap: 10px;
      border: 0; border-radius: 8px; padding: 11px 10px; background: transparent; text-align: left; color: inherit;
    }
    .run-row:hover { background: rgba(255, 255, 255, .04); }
    .run-row.selected { background: var(--surface); box-shadow: inset 3px 0 0 var(--accent); }
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
    .empty-copy .waypoint { margin: 0 auto 22px; width: 28px; height: 32px; }
    .empty-copy h2 { margin: 0; font-size: clamp(25px, 4vw, 40px); font-weight: 570; letter-spacing: -.025em; }
    .empty-copy p { color: var(--muted); line-height: 1.65; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; margin-bottom: 22px; }
    .eyebrow { color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
    .run-heading { margin: 5px 0 0; max-width: 820px; font-size: clamp(22px, 3vw, 34px); font-weight: 570; line-height: 1.15; letter-spacing: -.02em; }
    .top-meta { display: flex; align-items: center; gap: 9px; margin-top: 11px; color: var(--muted); font-size: 12px; }
    .status {
      display: inline-flex; align-items: center; gap: 7px; padding: 5px 8px;
      border: 1px solid var(--line); border-radius: 6px; background: rgba(255,255,255,.06); font-weight: 650;
    }
    .status::before { content: ""; width: 7px; height: 7px; background: var(--info); }
    .status.awaiting_input { color: var(--attention); border-color: var(--attention-line); background: var(--attention-soft); }
    .status.awaiting_input::before { background: var(--attention); }
    .status.blocked, .status.cancelled { color: var(--danger); border-color: var(--danger-line); background: var(--danger-soft); }
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
      margin-bottom: 24px; border: 1px solid var(--attention-line); border-left: 4px solid var(--attention);
      background: linear-gradient(100deg, #241c12, #1c1812); box-shadow: var(--shadow);
    }
    .gate-head { padding: 18px 20px 15px; border-bottom: 1px solid var(--attention-line); }
    .gate-head .eyebrow { color: var(--attention); }
    .gate h3 { margin: 5px 0 0; font-size: 18px; }
    .questions { padding: 4px 20px 18px; }
    .question { padding: 15px 0; border-bottom: 1px solid var(--attention-line); }
    .question:last-child { border-bottom: 0; }
    .question-title { display: flex; justify-content: space-between; gap: 16px; color: var(--ink); font-size: 14px; line-height: 1.45; }
    .park { width: auto; margin: 1px 5px 0 0; accent-color: var(--attention); }
    .park-label { display: flex; align-items: center; flex: 0 0 auto; color: var(--muted); font-size: 11px; font-weight: 500; }
    .choice-row { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
    .choice {
      border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); padding: 7px 10px; color: var(--ink);
    }
    .choice.selected { border-color: var(--attention); background: var(--attention-soft); color: #f0c48a; }
    .gate-footer { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: end; gap: 14px; padding: 0 20px 20px; }
    .gate-footer textarea { min-height: 52px; }
    .block {
      margin-bottom: 24px; padding: 16px 18px; border-left: 4px solid var(--danger);
      background: var(--danger-soft); color: #f0b4ae;
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
    .artifact-body { color: #c4c8d0; font-size: 13px; line-height: 1.58; overflow-wrap: anywhere; }
    pre.artifact-body {
      margin: 0; padding: 12px; border: 1px solid var(--line); background: rgba(0, 0, 0, .28);
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
      position: fixed; top: 16px; left: 50%; right: auto; bottom: auto; z-index: 20; max-width: min(520px, calc(100vw - 44px));
      display: flex; align-items: flex-start; gap: 12px;
      padding: 12px 15px; border: 1px solid var(--line-strong); background: var(--surface); box-shadow: var(--shadow);
      color: var(--ink); font-size: 12px; transform: translate(-50%, -12px); opacity: 0; pointer-events: none; transition: .18s ease;
    }
    .toast.show { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
    .toast.error { border-color: var(--danger-line); color: var(--danger); }
    .toast.busy { border-color: var(--attention-line); color: var(--attention); }
    .toast-msg { flex: 1; min-width: 0; }
    .toast-close { flex: 0 0 auto; margin: -4px -4px 0 0; border: 0; background: transparent; color: inherit; cursor: pointer; font: 16px/1 inherit; }
    .busy-pulse { animation: busy-pulse 1s ease-in-out infinite; }
    @keyframes busy-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .mobile-head { display: none; }
    @media (max-width: 820px) {
      .shell { display: block; }
      .sidebar { position: fixed; z-index: 12; width: min(88vw, 330px); transform: translateX(-102%); transition: transform .2s ease; box-shadow: var(--shadow); }
      body.nav-open .sidebar { transform: translateX(0); }
      .mobile-head {
        position: sticky; top: 0; z-index: 8; display: flex; align-items: center; justify-content: space-between;
        padding: 11px 14px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--paper) 92%, transparent); backdrop-filter: blur(12px);
      }
      .mobile-head button { border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 6px; padding: 7px 10px; }
      .workspace { padding: 20px 16px 38px; }
      .content-grid { grid-template-columns: 1fr; }
      .topbar { display: block; }
      .actions { justify-content: flex-start; margin-top: 16px; }
      .gate-footer { grid-template-columns: 1fr; }
    }
    @media (max-width: 520px) {
      .compose-grid { grid-template-columns: 1fr; }
      .run-heading { font-size: 23px; }
      .actions button { flex: 1; }
      .compose .primary { width: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="mobile-head"><strong>HexAgent Harness</strong><button id="nav-toggle" type="button">Runs</button></div>
  <div class="shell">
    <aside class="sidebar">
      <header class="brand">
        <div class="brand-mark"><svg class="waypoint" viewBox="0 0 16 18" aria-hidden="true"><polygon points="8,1 15,4.5 15,13.5 8,17 1,13.5 1,4.5"/><polygon class="hex-core" points="8,6.5 10.5,7.75 10.5,10.25 8,11.5 5.5,10.25 5.5,7.75"/></svg><h1>HexAgent Harness</h1></div>
        <p>Hexa durable operations</p>
      </header>
      <button class="new-run-toggle" id="new-run-toggle" type="button" aria-pressed="false">Start a new run</button>
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
      <div class="empty-state"><div class="empty-copy"><svg class="waypoint" viewBox="0 0 16 18" aria-hidden="true"><polygon points="8,1 15,4.5 15,13.5 8,17 1,13.5 1,4.5"/><polygon class="hex-core" points="8,6.5 10.5,7.75 10.5,10.25 8,11.5 5.5,10.25 5.5,7.75"/></svg><h2>Choose a run or chart a new one.</h2><p>The dashboard follows the host lifecycle. Gates, fog, evidence, and task progress remain durable between visits.</p><button class="primary" data-action="compose" type="button">Start a new run</button></div></div>
    </main>
  </div>
  <div class="toast" id="toast" role="status"><span class="toast-msg" id="toast-msg"></span><button class="toast-close" id="toast-close" type="button" aria-label="Dismiss">X</button></div>
  <script>
    const token = new URLSearchParams(location.search).get("token") || "";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const app = { runs: [], projects: [], selectedId: null, run: null, activity: [], sessions: [], signature: "", drafts: {}, view: "empty", compose: { idea: "", projectKey: "", workflow: "default" }, busy: null };
    const phases = ["reflect","grill","glossary","verification-settings","plan","prd","scenarios","operator-gate","slice","implement","scenario-test","crystallize","final-review","publish"];
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
    const words = (value) => String(value || "").replace(/[-_]/g, " ");
    const relative = (value) => {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
      if (seconds < 60) return "just now";
      if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
      if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
      return Math.floor(seconds / 86400) + "d ago";
    };
    const toast = (message, error) => {
      el("toast-msg").textContent = message;
      el("toast").className = "toast show" + (error ? " error" : "");
    };
    const toastBusy = (message) => {
      el("toast-msg").textContent = message;
      el("toast").className = "toast show busy";
    };
    function setActionBusy(busy) {
      app.busy = busy;
      const actions = document.querySelector(".actions");
      if (!actions) return;
      actions.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
        if (busy && button.dataset.action === busy.action) {
          button.textContent = busy.label;
          button.classList.add("busy-pulse");
        }
      });
    }
    function clearActionBusy() {
      app.busy = null;
    }
    el("toast-close").onclick = () => { el("toast").className = "toast"; };
    async function api(path, options = {}) {
      const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }
    function runLabel(run) {
      const artifacts = run.state && run.state.artifacts ? run.state.artifacts : {};
      const reflect = artifacts.reflect && typeof artifacts.reflect === "object" ? artifacts.reflect : {};
      const compact = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
      const shorten = (value) => value.length <= ${RUN_TITLE_MAX_LEN} ? value : value.slice(0, ${RUN_TITLE_MAX_LEN - 3}).trimEnd() + "...";
      const title = compact(reflect.proposedTitle) || compact(reflect.title);
      if (title) return shorten(title);
      const restatement = compact(reflect.restatement);
      if (restatement) return shorten(restatement);
      return ${JSON.stringify(RUN_TITLE_PLACEHOLDER)};
    }
    function runIdea(run) {
      return String(run.state && run.state.idea || "").trim();
    }
    function renderRuns() {
      const sorted = [...app.runs].sort((a, b) => String(b.state.updatedAt).localeCompare(String(a.state.updatedAt)));
      el("runs").innerHTML = sorted.length ? sorted.map((run) =>
        '<button type="button" class="run-row' + (app.selectedId === run.identity.runId ? ' selected' : '') + '" data-run="' + esc(run.identity.runId) + '">' +
          '<span class="status-bar ' + esc(run.state.status) + '"></span><span><span class="run-title">' + esc(runLabel(run)) + '</span>' +
          '<span class="run-meta"><span>' + esc(words(run.state.phase)) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></span></span></button>'
      ).join("") : '<div class="empty-inline" style="padding:14px 11px">No runs yet.</div>';
    }
    function setComposeActive(active) {
      el("new-run-toggle").classList.toggle("active", active);
      el("new-run-toggle").setAttribute("aria-pressed", active ? "true" : "false");
    }
    function renderProjects() {
      el("projects").innerHTML = app.projects.length ? app.projects.map((project) =>
        '<div class="project-entry" title="' + esc(project.controlRoot) + '">' + esc(project.controlRoot) + '</div>'
      ).join("") : '<div class="empty-inline">No registered projects.</div>';
      const select = el("project");
      if (!select) return;
      const current = select.value || app.compose.projectKey;
      select.innerHTML = app.projects.length ? app.projects.map((project) =>
        '<option value="' + esc(project.projectKey) + '">' + esc(project.controlRoot.split(/[\\\\/]/).filter(Boolean).pop() || project.projectKey) + '</option>'
      ).join("") : '<option value="">Register a project first</option>';
      if (app.projects.some((project) => project.projectKey === current)) select.value = current;
    }
    function renderEmpty() {
      app.view = "empty";
      setComposeActive(false);
      el("detail").innerHTML = '<div class="empty-state"><div class="empty-copy"><svg class="waypoint" viewBox="0 0 16 18" aria-hidden="true"><polygon points="8,1 15,4.5 15,13.5 8,17 1,13.5 1,4.5"/><polygon class="hex-core" points="8,6.5 10.5,7.75 10.5,10.25 8,11.5 5.5,10.25 5.5,7.75"/></svg><h2>Choose a run or chart a new one.</h2><p>The dashboard follows the host lifecycle. Gates, fog, evidence, and task progress remain durable between visits.</p><button class="primary" data-action="compose" type="button">Start a new run</button></div></div>';
    }
    function renderCompose() {
      const draft = app.compose;
      const hasProjects = app.projects.length > 0;
      setComposeActive(true);
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">New run</div>' +
        '<h2 class="run-heading">Chart a new run</h2>' +
        '<p class="lede">Describe the outcome, pick a registered project, and begin wayfinding.</p></div></header>' +
        '<form class="compose" id="start-form">' +
        '<label>Idea<textarea id="idea" required placeholder="Describe the outcome, constraint, or ticket…">' + esc(draft.idea) + '</textarea></label>' +
        '<div class="compose-grid"><label>Project<select id="project"></select></label>' +
        '<label>Workflow<select id="workflow"><option value="default">Default</option><option value="ticket">Ticket</option></select></label></div>' +
        (hasProjects ? "" : '<p class="empty-inline">Register a local repository in the sidebar first.</p>') +
        '<button class="primary" type="submit"' + (hasProjects ? "" : " disabled") + '>Begin wayfinding</button></form>';
      renderProjects();
      if (draft.workflow) el("workflow").value = draft.workflow;
    }
    function showCompose() {
      app.view = "compose";
      app.selectedId = null;
      app.run = null;
      app.signature = "";
      document.body.classList.remove("nav-open");
      renderRuns();
      renderCompose();
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
    function reflectFieldValue(reflect, draft, id) {
      if (draft.answers[id] != null) return draft.answers[id];
      const raw = reflect[id];
      if (Array.isArray(raw)) return raw.join("\\n");
      return raw == null ? "" : String(raw);
    }
    function renderReflectGate(run, gate, draft) {
      const reflect = run.state.artifacts && run.state.artifacts.reflect && typeof run.state.artifacts.reflect === "object" ? run.state.artifacts.reflect : {};
      const fields = [
        { id: "proposedTitle", label: "Feature title", single: true },
        { id: "restatement", label: "Restatement" },
        { id: "goal", label: "Goal" },
        { id: "users", label: "Users" },
        { id: "inScope", label: "In scope" },
        { id: "outOfScope", label: "Out of scope" },
        { id: "assumptions", label: "Assumptions" },
        { id: "unknowns", label: "Unknowns" }
      ];
      fields.forEach((field) => {
        if (draft.answers[field.id] == null) draft.answers[field.id] = reflectFieldValue(reflect, draft, field.id);
      });
      return '<section class="gate"><header class="gate-head"><div class="eyebrow">Operator input required</div><h3>' + esc(gate.title) + '</h3></header>' +
        '<form class="reflect-fields" id="reflectFields">' + fields.map((field) =>
          '<div class="field"><label>' + esc(field.label) + (field.single
            ? '<input type="text" data-reflect-field="' + esc(field.id) + '" data-answer="' + esc(field.id) + '" value="' + esc(draft.answers[field.id] || "") + '" placeholder="Short imperative run label">'
            : '<textarea data-reflect-field="' + esc(field.id) + '" data-answer="' + esc(field.id) + '">' + esc(draft.answers[field.id] || "") + '</textarea>') + '</label></div>'
        ).join("") + '</form><div class="gate-footer"><label>Batch notes<textarea id="gate-notes" placeholder="Context that applies to the whole batch">' + esc(draft.notes || "") + '</textarea></label>' +
        '<button class="primary" type="button" data-action="answer">Confirm brief</button></div></section>';
    }
    function renderGate(run) {
      const gate = run.state.gate;
      if (!gate) return "";
      const draft = app.drafts[run.identity.runId] || { answers: {}, parked: {}, notes: "" };
      app.drafts[run.identity.runId] = draft;
      if (gate.id === "reflect-confirm") return renderReflectGate(run, gate, draft);
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
      setComposeActive(false);
      const terminal = run.state.status === "completed" || run.state.status === "cancelled";
      const blocked = run.state.status === "blocked";
      const deleting = app.busy && app.busy.action === "delete" && app.busy.runId === run.identity.runId;
      const busyLocked = Boolean(app.busy && app.busy.runId === run.identity.runId);
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">' + esc(run.identity.projectKey) + ' · ' + esc(run.identity.workflowBundleId) + ' workflow</div>' +
        '<h2 class="run-heading">' + esc(runLabel(run)) + '</h2>' + (runIdea(run) ? '<p class="lede">' + esc(runIdea(run)) + '</p>' : '') + '<div class="top-meta"><span class="status ' + esc(deleting ? "blocked" : run.state.status) + (deleting ? " busy-pulse" : "") + '">' + esc(deleting ? "Deleting" : words(run.state.status)) + '</span>' +
        '<span>' + esc(words(run.state.phase)) + '</span><span>rev ' + esc(run.state.revision) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></div></div>' +
        '<div class="actions"><button class="secondary" data-action="continue" type="button"' + (busyLocked || terminal || run.state.status === "awaiting_input" ? ' disabled' : '') + '>Continue</button>' +
        '<button class="secondary" data-action="retry" type="button"' + (busyLocked || !blocked || run.state.block && !run.state.block.retriable ? ' disabled' : '') + '>Retry</button>' +
        '<button class="danger" data-action="cancel" type="button"' + (busyLocked || terminal ? ' disabled' : '') + '>Cancel</button>' +
        '<button class="danger' + (deleting ? ' busy-pulse' : '') + '" data-action="delete" type="button"' + (busyLocked ? ' disabled' : '') + '>' + (deleting ? 'Deleting…' : 'Delete') + '</button></div></header>' +
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
      if (app.view === "compose") renderCompose();
      else renderProjects();
    }
    async function refresh(options = {}) {
      if (app.busy && !options.force) return;
      const runs = await api("/api/runs");
      app.runs = runs;
      renderRuns();
      if (app.view === "compose" && !app.selectedId) return;
      if (!app.selectedId && options.selectFirst && runs[0]) app.selectedId = runs[0].identity.runId;
      if (app.selectedId) await openRun(app.selectedId, Boolean(options.force));
      else if (options.selectFirst) showCompose();
      else if (app.view !== "compose") renderEmpty();
    }
    async function openRun(id, force) {
      if (app.busy && app.busy.runId === id && !force) return;
      app.selectedId = id;
      const [run, activity, sessions] = await Promise.all([
        api("/api/runs/" + encodeURIComponent(id)),
        api("/api/runs/" + encodeURIComponent(id) + "/activity"),
        api("/api/runs/" + encodeURIComponent(id) + "/sessions"),
      ]);
      if (app.selectedId !== id) return;
      app.view = "run";
      const signature = id + ":" + run.state.revision + ":" + run.state.status + ":" + run.state.phase + ":" + activity.length + ":" + sessions.length + ":" + (app.busy ? app.busy.action : "");
      app.run = run; app.activity = activity; app.sessions = sessions;
      renderRuns();
      if (force || signature !== app.signature) {
        app.signature = signature;
        renderDetail();
      }
    }
    async function mutate(action, payload) {
      if (!app.selectedId || app.busy) return;
      const runId = app.selectedId;
      const pending = action === "delete"
        ? { action: "delete", runId, message: "Deleting run… removing sandbox, worktree, and artifacts", label: "Deleting…" }
        : action === "cancel"
          ? { action: "cancel", runId, message: "Cancelling run…", label: "Cancelling…" }
          : null;
      try {
        if (pending) {
          toastBusy(pending.message);
          setActionBusy(pending);
          if (app.run) renderDetail();
        }
        await api("/api/runs/" + encodeURIComponent(runId) + "/" + action, { method: "POST", body: JSON.stringify(payload || {}) });
        if (action === "answer") delete app.drafts[runId];
        if (action === "delete") {
          delete app.drafts[runId];
          clearActionBusy();
          app.selectedId = null;
          app.run = null;
          app.activity = [];
          app.sessions = [];
          app.signature = "";
          await refresh({ selectFirst: true, force: true });
          toast("Run deleted");
          return;
        }
        clearActionBusy();
        await refresh({ force: true });
      } catch (error) {
        clearActionBusy();
        if (app.run) renderDetail();
        toast(error.message, true);
      }
    }
    el("new-run-toggle").onclick = () => { if (!app.busy) showCompose(); };
    el("nav-toggle").onclick = () => document.body.classList.toggle("nav-open");
    el("refresh").onclick = () => {
      if (app.busy) return;
      refresh({ force: true }).catch((error) => toast(error.message, true));
    };
    el("runs").onclick = (event) => {
      if (app.busy) return;
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
    function saveComposeDraft(target) {
      if (!target || (target.id !== "idea" && target.id !== "project" && target.id !== "workflow")) return false;
      if (target.id === "idea") app.compose.idea = target.value;
      if (target.id === "project") app.compose.projectKey = target.value;
      if (target.id === "workflow") app.compose.workflow = target.value;
      return true;
    }
    el("detail").addEventListener("submit", async (event) => {
      if (event.target.id !== "start-form") return;
      event.preventDefault();
      const idea = el("idea").value.trim();
      const projectKey = el("project").value;
      if (!idea || !projectKey) return toast("Choose a project and enter an idea.", true);
      const button = event.submitter || event.target.querySelector("button[type=submit]");
      if (button) button.disabled = true;
      try {
        const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ idea, projectKey, workflowBundleId: el("workflow").value }) });
        app.compose.idea = "";
        app.compose.projectKey = projectKey;
        app.compose.workflow = el("workflow").value;
        app.view = "run";
        app.selectedId = run.identity.runId;
        await refresh({ force: true });
      } catch (error) { toast(error.message, true); }
      finally { if (button) button.disabled = false; }
    });
    el("detail").addEventListener("input", (event) => {
      if (saveComposeDraft(event.target)) return;
      if (!app.selectedId || !app.run || !app.run.state.gate) return;
      const draft = app.drafts[app.selectedId] || { answers: {}, parked: {}, notes: "" };
      app.drafts[app.selectedId] = draft;
      if (event.target.dataset.answer) draft.answers[event.target.dataset.answer] = event.target.value;
      if (event.target.dataset.park) draft.parked[event.target.dataset.park] = event.target.checked;
      if (event.target.id === "gate-notes") draft.notes = event.target.value;
    });
    el("detail").addEventListener("change", (event) => { saveComposeDraft(event.target); });
    el("detail").addEventListener("click", (event) => {
      const composeAction = event.target.closest('[data-action="compose"]');
      if (composeAction) {
        showCompose();
        return;
      }
      const choice = event.target.closest("[data-choice]");
      if (choice && app.selectedId) {
        const draft = app.drafts[app.selectedId] || { answers: {}, parked: {}, notes: "" };
        app.drafts[app.selectedId] = draft;
        draft.answers[choice.dataset.choice] = choice.dataset.value;
        document.querySelectorAll('[data-choice="' + CSS.escape(choice.dataset.choice) + '"]').forEach((node) => node.classList.toggle("selected", node === choice));
        return;
      }
      const action = event.target.closest("[data-action]");
      if (!action || action.disabled || app.busy) return;
      if (action.dataset.action === "cancel" && !confirm("Cancel this run and destroy its sandbox?")) return;
      if (action.dataset.action === "delete" && !confirm("Permanently delete this run, its sandbox, worktree, and stored artifacts?")) return;
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

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
    .reflect-fields textarea {
      min-height: 52px; overflow-y: hidden; resize: none; field-sizing: content;
    }
    .reflect-list { display: grid; gap: 8px; margin-top: 6px; }
    .reflect-list-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
    .reflect-list-row input { margin-top: 0; }
    .reflect-list-row .quiet { min-height: 36px; padding: 7px 10px; }
    .reflect-list-add { justify-self: start; margin-top: 2px; }
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
    .sidebar-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
    .sound-toggle { border: 0; background: transparent; color: var(--muted); padding: 0; font-size: 12px; }
    .sound-toggle:hover { color: var(--accent); }
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
    .working-line {
      display: flex; align-items: baseline; gap: 8px; margin-top: 12px; max-width: 820px;
      padding: 10px 12px; border: 1px solid var(--attention-line); border-radius: 8px;
      background: var(--attention-soft); color: #f0c48a; font-size: 13px; line-height: 1.45;
    }
    .working-line strong { flex: 0 0 auto; color: var(--attention); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .working-line span { min-width: 0; }
    .run-working { margin-top: 4px; color: #f0c48a; font-size: 11px; line-height: 1.35; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
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
      display: flex; gap: 0; overflow-x: auto; margin: 0 0 8px; padding: 0 0 12px;
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
    .batch-card {
      border: 0; border-left: 3px solid var(--attention); background: transparent; box-shadow: none;
    }
    .batch-card .gate-head { margin-bottom: 0; padding: 4px 20px 14px; border-bottom: 0; }
    .keyboard-hint {
      margin: 0 20px; padding: 0 0 14px; border-bottom: 1px solid var(--attention-line);
      color: var(--faint); font-size: 12px;
    }
    .batch-question {
      border: 0; border-bottom: 1px solid var(--attention-line); border-radius: 0; background: transparent;
      padding: 20px 0; margin: 0 20px;
    }
    .batch-question:focus { outline: 2px solid var(--attention); outline-offset: 6px; }
    .batch-question.parked { opacity: .55; }
    .batch-question.clarifying { opacity: 1; }
    .batch-question .item-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .batch-question .card-label { color: var(--faint); font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .batch-question .tag {
      border: 1px solid var(--line); color: var(--muted); border-radius: 999px; font-size: 10px;
      padding: 3px 7px; text-transform: uppercase; letter-spacing: .06em;
    }
    .batch-question .tag.hitl { color: var(--attention); border-color: var(--attention-line); }
    .batch-question .prompt { margin: 10px 0 6px; color: var(--ink); font-size: 16px; line-height: 1.4; letter-spacing: -.01em; }
    .question-context { color: var(--muted); max-width: 850px; margin: 0 0 14px; font-size: 13px; line-height: 1.5; }
    .question-options {
      display: grid; grid-template-columns: 1fr; gap: 0; margin: 0 0 14px;
      border-top: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong);
    }
    .question-option {
      position: relative; display: block; width: 100%; min-height: 64px; text-align: left;
      border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent;
      color: var(--ink); padding: 12px 14px;
    }
    .question-option:last-child { border-bottom: 0; }
    .question-option:hover { background: rgba(233, 162, 74, .08); }
    .question-option.recommended { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent); }
    .question-option.selected {
      background: var(--accent-soft); box-shadow: inset 3px 0 0 var(--accent);
    }
    .question-option strong { display: block; padding-right: 88px; }
    .question-option small { display: block; color: var(--muted); margin-top: 5px; line-height: 1.4; }
    .recommendation-badge, .selected-badge {
      position: absolute; top: 11px; right: 11px; color: var(--accent); font-size: 9px;
      font-weight: 800; letter-spacing: .08em; text-transform: uppercase;
    }
    .recommendation {
      border-left: 2px solid var(--accent); background: transparent; color: #dce9c3;
      padding: 4px 0 4px 12px; margin: 0 0 14px; font-size: 13px; line-height: 1.45;
    }
    .recommendation strong { margin-right: 5px; }
    .batch-question textarea { min-height: 64px; margin-top: 8px; }
    .batch-clarify-box { margin-top: 8px; }
    .batch-clarify-box textarea { min-height: 72px; }
    .batch-question-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
    .batch-footer {
      position: sticky; bottom: 0; margin: 0; padding: 14px 20px;
      background: color-mix(in srgb, var(--paper) 94%, transparent); backdrop-filter: blur(10px);
      border-top: 1px solid var(--attention-line); display: flex; align-items: center;
      justify-content: space-between; gap: 12px; flex-wrap: wrap;
    }
    .batch-footer .muted { color: var(--muted); font-size: 13px; }
    .batch-footer-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .batch-feedback {
      margin: 0 20px 16px; padding: 10px 12px; border-radius: 8px;
      border: 1px solid var(--danger-line); background: var(--danger-soft); color: #f0b4ae; font-size: 13px;
    }
    .batch-feedback[hidden] { display: none; }
    .block {
      margin-bottom: 24px; padding: 16px 18px; border-left: 4px solid var(--danger);
      background: var(--danger-soft); color: #f0b4ae;
    }
    .content-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(260px, .8fr); gap: 22px; align-items: start; }
    .stack { display: grid; gap: 22px; }
    .run-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 22px; border-bottom: 1px solid var(--line); }
    .run-tab {
      border: 0; border-bottom: 2px solid transparent; border-radius: 7px 7px 0 0;
      background: transparent; color: var(--muted); padding: 8px 12px; font-size: 13px; font-weight: 600;
    }
    .run-tab:hover { color: var(--ink); background: rgba(255, 255, 255, .04); }
    .run-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .run-tab .count { margin-left: 6px; }
    .sandbox-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 0 0 6px; }
    .sandbox-meta dt { color: var(--faint); font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .sandbox-meta dd { margin: 3px 0 0; font: 12px "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
    .sandbox-subhead { margin: 18px 0 8px; color: var(--muted); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; }
    .sandbox-table { width: 100%; border-collapse: collapse; font: 12px "Cascadia Mono", Consolas, monospace; }
    .sandbox-table th { padding: 6px 8px; border-bottom: 1px solid var(--line-strong); color: var(--faint); font-size: 10px; letter-spacing: .08em; text-align: left; text-transform: uppercase; }
    .sandbox-table td { padding: 6px 8px; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    .sandbox-env { list-style: none; margin: 0; padding: 0; font: 12px "Cascadia Mono", Consolas, monospace; }
    .sandbox-env li { padding: 4px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
    .panel { border-top: 2px solid var(--ink); padding-top: 13px; }
    .panel-title { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .panel h3 { margin: 0; font-size: 15px; letter-spacing: .02em; }
    .count { color: var(--faint); font: 11px "Cascadia Mono", Consolas, monospace; }
    .artifact { padding: 15px 0; border-top: 1px solid var(--line); }
    .artifact:first-child { border-top: 0; padding-top: 0; }
    .artifact > summary {
      list-style: none; cursor: pointer; user-select: none;
      color: var(--accent); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
      display: flex; align-items: center; gap: 8px;
    }
    .artifact > summary::-webkit-details-marker { display: none; }
    .artifact > summary::before {
      content: ""; flex: 0 0 auto; width: 0; height: 0;
      border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 6px solid var(--accent);
      opacity: .7; transition: transform .12s ease;
    }
    .artifact[open] > summary { margin-bottom: 8px; }
    .artifact[open] > summary::before { transform: rotate(90deg); }
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
    .repo-label { display: inline-flex; align-items: center; gap: 6px; }
    .copy-path-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; padding: 0; border: 0; border-radius: 6px;
      background: transparent; color: var(--faint); cursor: pointer;
    }
    .copy-path-btn:hover { color: var(--ink); background: rgba(255, 255, 255, .06); }
    .copy-path-btn svg { display: block; }
    .activity { position: relative; padding-left: 18px; }
    .activity::before { content: ""; position: absolute; left: 3px; top: 5px; bottom: 6px; width: 1px; background: var(--line-strong); }
    .event { position: relative; padding: 0 0 15px; }
    .event::before { content: ""; position: absolute; left: -18px; top: 4px; width: 7px; height: 7px; background: var(--surface); border: 2px solid var(--accent); }
    .event.agent::before { border-color: var(--info); }
    .event.failed::before { border-color: var(--danger); }
    .event.failed .event-main { color: var(--danger); }
    .event-main { font-size: 12px; font-weight: 600; }
    .event-time { margin-top: 3px; color: var(--faint); font: 10px "Cascadia Mono", Consolas, monospace; }
    .session { margin: 0 0 10px; border: 1px solid var(--line); background: rgba(0, 0, 0, .16); }
    .session > summary {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      cursor: pointer; list-style: none; padding: 11px 12px; color: var(--ink);
    }
    .session > summary::-webkit-details-marker { display: none; }
    .session > summary::before {
      content: ""; width: 0; height: 0; border-top: 5px solid transparent; border-bottom: 5px solid transparent;
      border-left: 6px solid var(--faint); flex: 0 0 auto;
    }
    .session[open] > summary::before { transform: rotate(90deg); }
    .session-title { font-size: 13px; font-weight: 600; }
    .session-meta { margin-left: auto; color: var(--muted); font: 10px "Cascadia Mono", Consolas, monospace; text-transform: uppercase; }
    .session-status {
      display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border: 1px solid var(--line-strong);
      border-radius: 999px; font: 10px "Cascadia Mono", Consolas, monospace; text-transform: uppercase; color: var(--muted);
    }
    .session-status.completed { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, var(--line-strong)); background: var(--accent-soft); }
    .session-status.failed { color: var(--danger); border-color: var(--danger-line); background: var(--danger-soft); }
    .session-body { padding: 0 12px 12px; display: grid; gap: 12px; }
    .session-section h4 {
      margin: 0 0 6px; color: var(--muted); font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    }
    .session-section pre {
      margin: 0; padding: 12px; border: 1px solid var(--line); background: rgba(0, 0, 0, .28);
      font: 12px/1.55 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .session-error pre { border-color: var(--danger-line); color: #f0b4ae; background: var(--danger-soft); }
    .empty-inline { color: var(--faint); font-size: 12px; line-height: 1.5; }
    .project-box { margin: 0 16px 13px; padding-top: 12px; border-top: 1px solid var(--line); }
    .project-box summary { color: var(--muted); cursor: pointer; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .project-list { margin: 9px 0; color: var(--muted); font-size: 11px; }
    .project-entry { overflow: hidden; padding: 4px 0; text-overflow: ellipsis; white-space: nowrap; }
    .nav-link {
      margin: 0 16px 10px; min-height: 36px; width: calc(100% - 32px); border: 1px solid var(--line-strong); border-radius: 8px;
      background: transparent; color: var(--muted); font-weight: 600;
    }
    .nav-link:hover, .nav-link.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .guidance-layout { display: grid; grid-template-columns: minmax(180px, 220px) minmax(0, 1fr); gap: 22px; align-items: start; }
    .guidance-roles { display: grid; gap: 6px; }
    .guidance-role {
      width: 100%; text-align: left; border: 1px solid transparent; border-radius: 7px;
      background: transparent; color: var(--ink); padding: 9px 10px; font-weight: 600;
    }
    .guidance-role:hover { background: rgba(255,255,255,.04); }
    .guidance-role.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
    .guidance-meta { display: grid; gap: 12px; margin: 14px 0 18px; }
    .guidance-meta .faint { color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
    .guidance-warnings { margin: 0 0 16px; padding: 10px 12px; border: 1px solid var(--attention-line); background: var(--attention-soft); color: #f0c48a; font-size: 12px; }
    .guidance-section { margin-top: 18px; }
    .guidance-section h2 { margin: 0 0 8px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
    .guidance-source { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
    .guidance-role.active .guidance-source { color: var(--accent); }
    #guidance-editor {
      width: 100%; min-height: 320px; resize: vertical;
      background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);
      border-radius: 8px; padding: 12px 14px; font-family: "Cascadia Code", Consolas, monospace;
      font-size: 12.5px; line-height: 1.55;
    }
    #guidance-editor:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-ring); }
    .guidance-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .guidance-scope-label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
    .guidance-scope-label select {
      background: var(--field); color: var(--ink); border: 1px solid var(--line-strong);
      border-radius: 6px; padding: 6px 8px;
    }
    .guidance-section pre, .guidance-preview pre {
      margin: 0; padding: 12px; border: 1px solid var(--line); background: rgba(0,0,0,.28);
      font: 12px/1.55 "Cascadia Mono", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .guidance-preview { margin-top: 16px; }
    .guidance-preview summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    @media (max-width: 820px) {
      .guidance-layout { grid-template-columns: 1fr; }
    }
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
      <button class="nav-link" id="guidance-toggle" type="button" aria-pressed="false">Agent contexts</button>
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
      <footer class="sidebar-foot"><span>Loopback only · token authenticated</span><button type="button" class="sound-toggle" id="soundMuteBtn" title="Toggle notification sounds">Sound on</button></footer>
    </aside>
    <main class="workspace" id="detail">
      <div class="empty-state"><div class="empty-copy"><svg class="waypoint" viewBox="0 0 16 18" aria-hidden="true"><polygon points="8,1 15,4.5 15,13.5 8,17 1,13.5 1,4.5"/><polygon class="hex-core" points="8,6.5 10.5,7.75 10.5,10.25 8,11.5 5.5,10.25 5.5,7.75"/></svg><h2>Choose a run or chart a new one.</h2><p>The dashboard follows the host lifecycle. Gates, fog, evidence, and task progress remain durable between visits.</p><button class="primary" data-action="compose" type="button">Start a new run</button></div></div>
    </main>
  </div>
  <div class="toast" id="toast" role="status"><span class="toast-msg" id="toast-msg"></span><button class="toast-close" id="toast-close" type="button" aria-label="Dismiss">X</button></div>
  <script>
    const token = new URLSearchParams(location.search).get("token") || "";
    const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const app = { runs: [], projects: [], selectedId: null, run: null, activity: [], sessions: [], signature: "", drafts: {}, artifactOpen: {}, sessionOpen: {}, view: "empty", runTab: "overview", sandbox: {}, sandboxPending: {}, compose: { idea: "", projectKey: "", workflow: "default", baseBranch: "" }, busy: null, guidanceRoles: [], guidanceRole: null, guidanceDoc: null, guidanceScope: "home", lastSoundStatus: null };
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
    function workingSummary(run) {
      const working = run && run.state && run.state.working;
      if (!working || !working.summary) return "";
      const bits = [String(working.summary)];
      if (working.role) bits.push(String(working.role));
      return bits.join(" · ");
    }
    function soundsMuted() {
      try { return localStorage.getItem("harnessSoundsMuted") === "1"; } catch (error) { return false; }
    }
    function setSoundsMuted(muted) {
      try { localStorage.setItem("harnessSoundsMuted", muted ? "1" : "0"); } catch (error) { /* ignore */ }
      const btn = el("soundMuteBtn");
      if (btn) btn.textContent = muted ? "Sound off" : "Sound on";
    }
    function playTone(kind) {
      if (soundsMuted()) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!playTone.ctx) playTone.ctx = new Ctx();
        const ctx = playTone.ctx;
        if (ctx.state === "suspended") ctx.resume();
        const now = ctx.currentTime;
        const specs = {
          awaiting_input: [523.25, 659.25, 0.08, 0.12],
          error: [220, 164.81, 0.12, 0.18],
          completed: [392, 523.25, 0.1, 0.16]
        };
        const spec = specs[kind] || specs.awaiting_input;
        [spec[0], spec[1]].forEach((freq, index) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
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
    function maybePlayStatusSound(status) {
      if (!status || status === app.lastSoundStatus) return;
      const previous = app.lastSoundStatus;
      app.lastSoundStatus = status;
      if (previous == null) return;
      if (status === "awaiting_input") playTone("awaiting_input");
      else if (status === "blocked") playTone("error");
      else if (status === "completed") playTone("completed");
    }
    function renderRuns() {
      const sorted = [...app.runs].sort((a, b) => String(b.state.updatedAt).localeCompare(String(a.state.updatedAt)));
      el("runs").innerHTML = sorted.length ? sorted.map((run) =>
        '<button type="button" class="run-row' + (app.selectedId === run.identity.runId ? ' selected' : '') + '" data-run="' + esc(run.identity.runId) + '">' +
          '<span class="status-bar ' + esc(run.state.status) + '"></span><span><span class="run-title">' + esc(runLabel(run)) + '</span>' +
          (workingSummary(run) ? '<div class="run-working busy-pulse">' + esc(workingSummary(run)) + '</div>' : '') +
          '<span class="run-meta"><span>' + esc(words(run.state.phase)) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></span></span></button>'
      ).join("") : '<div class="empty-inline" style="padding:14px 11px">No runs yet.</div>';
    }
    function setComposeActive(active) {
      el("new-run-toggle").classList.toggle("active", active);
      el("new-run-toggle").setAttribute("aria-pressed", active ? "true" : "false");
      el("guidance-toggle").classList.toggle("active", app.view === "guidance");
      el("guidance-toggle").setAttribute("aria-pressed", app.view === "guidance" ? "true" : "false");
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
      const starting = app.busy && app.busy.action === "start";
      setComposeActive(true);
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">New run</div>' +
        '<h2 class="run-heading">Chart a new run</h2>' +
        '<p class="lede">Describe the outcome, pick a registered project, and begin wayfinding.</p></div></header>' +
        '<form class="compose" id="start-form">' +
        '<label>Idea<textarea id="idea" required placeholder="Describe the outcome, constraint, or ticket…"' + (starting ? " disabled" : "") + '>' + esc(draft.idea) + '</textarea></label>' +
        '<div class="compose-grid"><label>Project<select id="project"' + (starting ? " disabled" : "") + '></select></label>' +
        '<label>Workflow<select id="workflow"' + (starting ? " disabled" : "") + '><option value="default">Default</option><option value="ticket">Ticket</option></select></label></div>' +
        '<div class="field"><label>Base branch<select id="base-branch"' + (starting ? " disabled" : "") + '><option value="">Select a project first</option></select></label></div>' +
        (hasProjects ? "" : '<p class="empty-inline">Register a local repository in the sidebar first.</p>') +
        '<button class="primary' + (starting ? " busy-pulse" : "") + '" type="submit"' + (hasProjects && !starting ? "" : " disabled") + '>' + (starting ? esc(app.busy.label) : "Begin wayfinding") + '</button></form>';
      renderProjects();
      if (draft.workflow) el("workflow").value = draft.workflow;
      void loadBranches(el("project").value || draft.projectKey);
    }
    async function loadBranches(projectKey) {
      const select = el("base-branch");
      if (!select) return;
      const preferred = app.compose.baseBranch;
      if (!projectKey) {
        select.innerHTML = '<option value="">Select a project first</option>';
        return;
      }
      try {
        const listed = await api("/api/projects/" + encodeURIComponent(projectKey) + "/branches");
        const branches = listed.branches || [];
        select.innerHTML = branches.length
          ? branches.map((name) => '<option value="' + esc(name) + '">' + esc(name) + '</option>').join("")
          : '<option value="">No local branches</option>';
        const pick = (preferred && branches.includes(preferred))
          ? preferred
          : (listed.current && branches.includes(listed.current) ? listed.current : branches[0] || "");
        if (pick) {
          select.value = pick;
          app.compose.baseBranch = pick;
        }
      } catch (error) {
        select.innerHTML = '<option value="">Failed to load branches</option>';
        toast(error.message, true);
      }
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
    function guidanceSourceLabel(source) {
      if (source === "project") return "project override";
      if (source === "home") return "home override";
      return "packaged";
    }
    function renderGuidanceRoles() {
      const roles = app.guidanceRoles || [];
      const host = el("guidanceRoles");
      if (!host) return;
      host.innerHTML = roles.length
        ? roles.map((entry) => {
            const active = entry.role === app.guidanceRole ? " active" : "";
            return '<button type="button" class="guidance-role' + active + '" data-guidance-role="' + esc(entry.role) + '">' +
              '<span>' + esc(entry.role) + '</span><span class="guidance-source">' + esc(guidanceSourceLabel(entry.source)) + '</span></button>';
          }).join("")
        : '<div class="empty-inline">No roles configured.</div>';
    }
    function renderGuidanceDetail() {
      const host = el("guidanceDetail");
      if (!host) return;
      const doc = app.guidanceDoc;
      if (!doc || doc.role !== app.guidanceRole) {
        host.innerHTML = '<div class="empty-inline">Select a role to edit its guidance.</div>';
        return;
      }
      const scopeOptions =
        '<option value="home"' + (app.guidanceScope === "home" ? " selected" : "") + '>Harness home</option>' +
        (app.compose.projectKey
          ? '<option value="project"' + (app.guidanceScope === "project" ? " selected" : "") + '>Selected project</option>'
          : "");
      host.innerHTML =
        '<div class="panel-title"><h3>' + esc(doc.role) + '</h3><span class="count">' + esc(guidanceSourceLabel(doc.source)) + '</span></div>' +
        '<div class="guidance-meta">' +
          '<div><div class="eyebrow">Effective source</div><div class="faint">' + esc(doc.path || "") + '</div></div>' +
          '<div><div class="eyebrow">Overrides</div><div class="faint">' +
            (doc.hasHomeOverride ? "home override present" : "no home override") + " · " +
            (doc.hasProjectOverride ? "project override present" : "no project override") + '</div></div>' +
        '</div>' +
        '<div class="guidance-section"><h2>Guidance body</h2>' +
        '<textarea id="guidance-editor" spellcheck="false">' + esc(doc.body || "") + '</textarea></div>' +
        '<div class="guidance-actions">' +
          '<label class="guidance-scope-label">Save to <select id="guidance-scope">' + scopeOptions + '</select></label>' +
          '<button class="primary" type="button" data-guidance-save>Save override</button>' +
          '<button class="secondary" type="button" data-guidance-reset>Reset to packaged default</button>' +
        '</div>' +
        '<div class="guidance-section"><h2>Role rules</h2><pre>' + esc((doc.roleRules || []).map((rule) => "- " + rule).join("\\n") || "(none)") + '</pre></div>' +
        (doc.contract ? '<div class="guidance-section"><h2>Expected output</h2><pre>' + esc(doc.contract) + '</pre></div>' : "") +
        '<details class="guidance-preview"><summary>Full prompt preview</summary><pre>' + esc(doc.promptPreview || "") + '</pre></details>';
    }
    function guidanceProjectQuery() {
      return app.compose.projectKey ? "?projectKey=" + encodeURIComponent(app.compose.projectKey) : "";
    }
    async function loadGuidanceRoles() {
      const data = await api("/api/guidance/roles" + guidanceProjectQuery());
      app.guidanceRoles = data.roles || [];
      if (!app.guidanceRole && app.guidanceRoles.length) app.guidanceRole = app.guidanceRoles[0].role;
      if (app.guidanceRole && !app.guidanceRoles.some((entry) => entry.role === app.guidanceRole)) {
        app.guidanceRole = app.guidanceRoles[0] ? app.guidanceRoles[0].role : null;
      }
      renderGuidanceRoles();
      await loadGuidanceRoleDetail();
    }
    async function loadGuidanceRoleDetail() {
      if (!app.guidanceRole) {
        app.guidanceDoc = null;
        renderGuidanceDetail();
        return;
      }
      const doc = await api("/api/guidance/roles/" + encodeURIComponent(app.guidanceRole) + guidanceProjectQuery());
      if (app.guidanceRole !== doc.role) return;
      app.guidanceDoc = doc;
      renderGuidanceDetail();
    }
    async function saveGuidanceOverride() {
      const editor = el("guidance-editor");
      if (!editor || !app.guidanceRole) return;
      const scope = el("guidance-scope") ? el("guidance-scope").value : "home";
      const projectKey = scope === "project" ? app.compose.projectKey : undefined;
      await api("/api/guidance/roles/" + encodeURIComponent(app.guidanceRole), {
        method: "PUT",
        body: JSON.stringify({ body: editor.value, projectKey }),
      });
      toast("Guidance override saved");
      await loadGuidanceRoles();
    }
    async function resetGuidanceOverride() {
      if (!app.guidanceRole) return;
      const scope = el("guidance-scope") ? el("guidance-scope").value : "home";
      const projectKey = scope === "project" ? app.compose.projectKey : "";
      await api("/api/guidance/roles/" + encodeURIComponent(app.guidanceRole) + (projectKey ? "?projectKey=" + encodeURIComponent(projectKey) : ""), { method: "DELETE" });
      toast("Guidance reset to packaged default");
      await loadGuidanceRoles();
    }
    function renderGuidance() {
      app.view = "guidance";
      app.selectedId = null;
      app.run = null;
      app.signature = "";
      setComposeActive(false);
      document.body.classList.remove("nav-open");
      renderRuns();
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">Role guidance editor</div>' +
        '<h2 class="run-heading">Agent contexts</h2>' +
        '<p class="lede">Dedicated guidance per worker role. Edits save as layered overrides; packaged defaults stay untouched.</p></div></header>' +
        '<div class="guidance-layout"><aside class="panel"><div class="panel-title"><h3>Roles</h3></div><div class="guidance-roles" id="guidanceRoles"><div class="empty-inline">Loading…</div></div></aside>' +
        '<section class="panel" id="guidanceDetail"><div class="empty-inline">Loading role guidance…</div></section></div>';
      void loadGuidanceRoles().catch((error) => {
        const roles = el("guidanceRoles");
        const detail = el("guidanceDetail");
        if (roles) roles.innerHTML = '<div class="empty-inline">Unable to load roles.</div>';
        if (detail) detail.innerHTML = '<div class="empty-inline">' + esc(error.message) + '</div>';
      });
    }
    function showGuidance() {
      if (app.busy) return;
      renderGuidance();
    }
    function renderPhases(run) {
      const bundle = run.identity.workflowBundleId === "ticket" ? ["implement","scenario-test","publish"] : phases;
      const current = bundle.indexOf(run.state.phase);
      return bundle.map((phase, index) =>
        '<span class="phase-step ' + (index === current ? 'current' : index < current ? 'done' : '') + '">' + esc(words(phase)) + '</span>'
      ).join("");
    }
    function emptyDraft() {
      return { answers: {}, parked: {}, notes: "", selectedOptions: {}, clarifications: {}, batchFeedback: "" };
    }
    function ensureDraft(runId) {
      const draft = app.drafts[runId] || emptyDraft();
      if (!draft.selectedOptions) draft.selectedOptions = {};
      if (!draft.clarifications) draft.clarifications = {};
      if (draft.batchFeedback == null) draft.batchFeedback = "";
      app.drafts[runId] = draft;
      return draft;
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
    function grillQuestionAnswered(q, draft) {
      if (draft.parked[q.id] || draft.clarifications[q.id] != null) return true;
      if (draft.selectedOptions[q.id]) return true;
      return Boolean(String(draft.answers[q.id] || "").trim());
    }
    function renderBatchQuestion(q, index, total, draft) {
      const selected = draft.selectedOptions[q.id];
      const parked = Boolean(draft.parked[q.id]);
      const clarifying = draft.clarifications[q.id] != null;
      const clarifyText = clarifying ? draft.clarifications[q.id] : "";
      const note = draft.answers[q.id] || "";
      const questionOptions = Array.isArray(q.options) ? q.options : [];
      const options = (!clarifying && questionOptions.length)
        ? '<div class="question-options">' + questionOptions.map((option, i) => {
            const recommended = option.id === q.recommendedOptionId;
            const isSelected = selected === option.id;
            return '<button type="button" class="question-option' + (recommended ? ' recommended' : '') + (isSelected ? ' selected' : '') + '" data-batch-choice="' + esc(q.id) + '" data-option-id="' + esc(option.id) + '" data-option-index="' + i + '"><strong>' + esc(option.label) + '</strong>' + (isSelected ? '<span class="selected-badge">Selected</span>' : (recommended ? '<span class="recommendation-badge">Recommended</span>' : '')) + (option.description ? '<small>' + esc(option.description) + '</small>' : '') + '</button>';
          }).join("") + '</div>'
        : '';
      const context = q.context ? '<div class="question-context">' + esc(q.context) + '</div>' : '';
      const recommendation = (!clarifying && q.recommendation)
        ? '<div class="recommendation"><strong>Our recommendation:</strong>' + esc(q.recommendation) + '</div>'
        : '';
      const answered = grillQuestionAnswered(q, draft);
      const statusTag = clarifying
        ? '<span class="tag">Wait what?</span>'
        : (parked ? '<span class="tag">Skipped</span>' : (answered ? '<span class="tag hitl">Answered</span>' : '<span class="tag">Unanswered</span>'));
      const answerArea = clarifying
        ? '<div class="batch-clarify-box"><textarea data-batch-clarify-text="' + esc(q.id) + '" placeholder="What is unclear? Ask the griller to rephrase or add precision…">' + esc(clarifyText) + '</textarea></div>'
        : '<textarea data-batch-answer="' + esc(q.id) + '" placeholder="Optional notes, or answer in your own words…">' + esc(note) + '</textarea>';
      return '<div class="batch-question' + (parked ? ' parked' : '') + (clarifying ? ' clarifying' : '') + '" data-batch-question="' + esc(q.id) + '" tabindex="0">' +
        '<div class="item-head"><div class="card-label">Question ' + (index + 1) + ' of ' + total + '</div>' + statusTag + '</div>' +
        '<div class="prompt">' + esc(q.prompt) + '</div>' + context + options + recommendation +
        answerArea +
        '<div class="batch-question-foot">' +
          '<button type="button" class="quiet" data-batch-clarify="' + esc(q.id) + '">' + (clarifying ? 'Cancel Wait what?' : 'Wait what?') + '</button>' +
          '<button type="button" class="quiet" data-batch-skip="' + esc(q.id) + '">' + (parked ? 'Unskip' : 'Skip for now') + '</button>' +
        '</div></div>';
    }
    function renderGrillGate(gate, draft) {
      const questions = gate.questions || [];
      const answeredCount = questions.filter((q) => grillQuestionAnswered(q, draft)).length;
      return '<section class="gate batch-card" id="batchCard" data-testid="question-batch">' +
        '<header class="gate-head"><div class="eyebrow">Operator input required</div><h3>' + esc(gate.title) + '</h3></header>' +
        '<div class="keyboard-hint">Keys: 1–4 choose an option for the focused question · ↑/↓ move between questions · Esc skips the focused question</div>' +
        questions.map((q, i) => renderBatchQuestion(q, i, questions.length, draft)).join("") +
        '<div class="batch-footer"><span class="muted" id="batchCount">' + answeredCount + ' of ' + questions.length + ' answered</span>' +
        '<div class="batch-footer-actions"><button type="button" class="secondary" id="acceptAllBtn" data-batch-accept-all>Accept all recommendations</button>' +
        '<button type="button" class="primary" id="submitBatchBtn" data-action="answer" data-testid="submit-answers">Submit answers</button></div></div>' +
        '<div class="batch-feedback" id="batchFeedback"' + (draft.batchFeedback ? '' : ' hidden') + '>' + esc(draft.batchFeedback || '') + '</div>' +
        '<div class="gate-footer"><label>Batch notes<textarea id="gate-notes" placeholder="Context that applies to the whole batch">' + esc(draft.notes || "") + '</textarea></label></div></section>';
    }
    function reflectFieldValue(reflect, draft, id) {
      if (draft.answers[id] != null) return draft.answers[id];
      const raw = reflect[id];
      if (Array.isArray(raw)) return raw.join("\\n");
      return raw == null ? "" : String(raw);
    }
    function reflectListEntries(value) {
      const raw = value == null ? "" : String(value);
      const entries = raw.length ? raw.split(/\\r?\\n/) : [""];
      return entries.length ? entries : [""];
    }
    function reflectListMarkup(fieldId, value) {
      const entries = reflectListEntries(value);
      return '<div class="reflect-list" data-reflect-list="' + esc(fieldId) + '">' +
        entries.map((entry, index) =>
          '<div class="reflect-list-row">' +
          '<input type="text" data-reflect-list-item="' + esc(fieldId) + '" data-index="' + index + '" value="' + esc(entry) + '" placeholder="One entry">' +
          '<button type="button" class="quiet" data-reflect-list-remove="' + esc(fieldId) + '" data-index="' + index + '"' + (entries.length <= 1 ? " disabled" : "") + '>Remove</button>' +
          '</div>'
        ).join("") +
        '<button type="button" class="secondary reflect-list-add" data-reflect-list-add="' + esc(fieldId) + '">Add entry</button></div>';
    }
    function syncReflectListAnswers(fieldId, draft) {
      const inputs = Array.from(document.querySelectorAll('[data-reflect-list-item="' + CSS.escape(fieldId) + '"]'));
      draft.answers[fieldId] = inputs.map((input) => input.value).join("\\n");
    }
    function replaceReflectList(fieldId, draft) {
      const host = document.querySelector('[data-reflect-list="' + CSS.escape(fieldId) + '"]');
      if (!host) return;
      host.outerHTML = reflectListMarkup(fieldId, draft.answers[fieldId] || "");
    }
    function autosizeTextarea(node) {
      if (!node || node.tagName !== "TEXTAREA") return;
      node.style.height = "auto";
      node.style.height = Math.max(node.scrollHeight, 52) + "px";
    }
    function autosizeReflectFields() {
      document.querySelectorAll(".reflect-fields textarea, #gate-notes, [data-batch-answer], [data-batch-clarify-text]").forEach(autosizeTextarea);
    }
    function renderReflectGate(run, gate, draft) {
      const reflect = run.state.artifacts && run.state.artifacts.reflect && typeof run.state.artifacts.reflect === "object" ? run.state.artifacts.reflect : {};
      const fields = [
        { id: "proposedTitle", label: "Feature title", single: true },
        { id: "restatement", label: "Restatement" },
        { id: "goal", label: "Goal" },
        { id: "users", label: "Users", list: true },
        { id: "inScope", label: "In scope", list: true },
        { id: "outOfScope", label: "Out of scope", list: true },
        { id: "assumptions", label: "Assumptions", list: true },
        { id: "unknowns", label: "Unknowns", list: true }
      ];
      fields.forEach((field) => {
        if (draft.answers[field.id] == null) draft.answers[field.id] = reflectFieldValue(reflect, draft, field.id);
      });
      return '<section class="gate"><header class="gate-head"><div class="eyebrow">Operator input required</div><h3>' + esc(gate.title) + '</h3></header>' +
        '<form class="reflect-fields" id="reflectFields">' + fields.map((field) => {
          if (field.list) {
            return '<div class="field"><label>' + esc(field.label) + '</label>' + reflectListMarkup(field.id, draft.answers[field.id] || "") + '</div>';
          }
          return '<div class="field"><label>' + esc(field.label) + (field.single
            ? '<input type="text" data-reflect-field="' + esc(field.id) + '" data-answer="' + esc(field.id) + '" value="' + esc(draft.answers[field.id] || "") + '" placeholder="Short imperative run label">'
            : '<textarea data-reflect-field="' + esc(field.id) + '" data-answer="' + esc(field.id) + '" rows="1">' + esc(draft.answers[field.id] || "") + '</textarea>') + '</label></div>';
        }).join("") + '</form><div class="gate-footer"><label>Batch notes<textarea id="gate-notes" rows="1" placeholder="Context that applies to the whole batch">' + esc(draft.notes || "") + '</textarea></label>' +
        '<button class="primary" type="button" data-action="answer">Confirm brief</button></div></section>';
    }
    function gateHiddenWhileBusy(run) {
      return Boolean(
        app.busy &&
        app.busy.runId === run.identity.runId &&
        (app.busy.action === "answer" || app.busy.action === "continue" || app.busy.action === "retry")
      );
    }
    function focusRunChrome() {
      window.scrollTo(0, 0);
      const top = document.querySelector(".topbar");
      if (top) top.scrollIntoView({ block: "start" });
    }
    function renderGate(run) {
      if (gateHiddenWhileBusy(run)) return "";
      const gate = run.state.gate;
      if (!gate) return "";
      const draft = ensureDraft(run.identity.runId);
      if (gate.id === "reflect-confirm") return renderReflectGate(run, gate, draft);
      if (gate.id === "grill-batch") return renderGrillGate(gate, draft);
      return '<section class="gate"><header class="gate-head"><div class="eyebrow">Operator input required</div><h3>' + esc(gate.title) + '</h3></header>' +
        '<div class="questions">' + gate.questions.map((q) =>
          '<div class="question"><div class="question-title"><span>' + esc(q.prompt) + '</span></div>' +
          answerControl(q, draft) + '</div>'
        ).join("") + '</div><div class="gate-footer"><label>Batch notes<textarea id="gate-notes" placeholder="Context that applies to the whole batch">' + esc(draft.notes || "") + '</textarea></label>' +
        '<button class="primary" type="button" data-action="answer">Submit</button></div></section>';
    }
    function selectBatchOption(qid, optionId) {
      const draft = ensureDraft(app.selectedId);
      if (draft.clarifications[qid] != null) delete draft.clarifications[qid];
      if (draft.selectedOptions[qid] === optionId) {
        delete draft.selectedOptions[qid];
      } else {
        draft.selectedOptions[qid] = optionId;
        delete draft.parked[qid];
      }
      draft.batchFeedback = "";
      renderDetail();
    }
    function toggleBatchSkip(qid) {
      const draft = ensureDraft(app.selectedId);
      if (draft.parked[qid]) {
        delete draft.parked[qid];
      } else {
        draft.parked[qid] = true;
        delete draft.selectedOptions[qid];
        delete draft.clarifications[qid];
        delete draft.answers[qid];
      }
      draft.batchFeedback = "";
      renderDetail();
    }
    function toggleBatchClarify(qid) {
      const draft = ensureDraft(app.selectedId);
      if (draft.clarifications[qid] != null) {
        delete draft.clarifications[qid];
      } else {
        draft.clarifications[qid] = "";
        delete draft.selectedOptions[qid];
        delete draft.parked[qid];
        delete draft.answers[qid];
      }
      draft.batchFeedback = "";
      renderDetail();
      if (ensureDraft(app.selectedId).clarifications[qid] != null) {
        const box = document.querySelector('[data-batch-clarify-text="' + CSS.escape(qid) + '"]');
        if (box) box.focus();
      }
    }
    function acceptAllRecommendations() {
      const gate = app.run && app.run.state.gate;
      if (!gate || gate.id !== "grill-batch") return;
      const draft = ensureDraft(app.selectedId);
      gate.questions.forEach((q) => {
        if (draft.parked[q.id] || draft.clarifications[q.id] != null) return;
        if (draft.selectedOptions[q.id] != null) return;
        if (q.recommendedOptionId) draft.selectedOptions[q.id] = q.recommendedOptionId;
      });
      draft.batchFeedback = "";
      renderDetail();
    }
    function buildGrillAnswerPayload(gate, draft) {
      const answers = {};
      const parked = [];
      const clarifications = [];
      const missing = [];
      gate.questions.forEach((q) => {
        if (draft.parked[q.id]) {
          parked.push(q.id);
          return;
        }
        if (draft.clarifications[q.id] != null) {
          const ask = String(draft.clarifications[q.id] || "").trim();
          if (!ask) {
            missing.push(q.id);
            return;
          }
          clarifications.push({ questionId: q.id, text: ask });
          return;
        }
        const optionId = draft.selectedOptions[q.id];
        const note = String(draft.answers[q.id] || "").trim();
        if (optionId == null && !note) {
          missing.push(q.id);
          return;
        }
        const option = Array.isArray(q.options) ? q.options.find((item) => item.id === optionId) : null;
        answers[q.id] = note || (option ? option.label : "");
      });
      return { answers, parked, clarifications, missing };
    }
    function artifactBody(value) {
      if (typeof value === "string") return '<div class="artifact-body">' + esc(value).replace(/\\n/g, "<br>") + '</div>';
      return '<pre class="artifact-body">' + esc(JSON.stringify(value, null, 2)) + '</pre>';
    }
    function visibleArtifacts(artifacts) {
      const bag = Object.assign({}, artifacts || {});
      const brief = bag.reflectBrief && typeof bag.reflectBrief === "object" ? bag.reflectBrief : null;
      const confirmed = brief && typeof brief.confirmed === "string" ? brief.confirmed.trim() : "";
      if (confirmed) {
        delete bag.reflect;
        bag.reflectBrief = brief.confirmed;
      } else {
        delete bag.reflectBrief;
      }
      return bag;
    }
    function artifactOpenKey(name) {
      return (app.selectedId || "") + ":" + name;
    }
    function renderArtifacts(artifacts) {
      const entries = Object.entries(visibleArtifacts(artifacts));
      const priority = ["reflectBrief","brief","prd","plan","scenario","scenarios","summary","reflect"];
      entries.sort((a, b) => {
        const ai = priority.indexOf(a[0]); const bi = priority.indexOf(b[0]);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      });
      return entries.length ? entries.map(([name, value]) =>
        '<details class="artifact"' + (app.artifactOpen[artifactOpenKey(name)] ? " open" : "") + ' data-artifact="' + esc(name) + '"><summary>' + esc(words(name)) + '</summary>' + artifactBody(value) + '</details>'
      ).join("") : '<div class="empty-inline">The brief and planning artifacts will appear as phases complete.</div>';
    }
    function renderFog(fog) {
      return fog.length ? '<ul class="item-list">' + fog.map((item) =>
        '<li class="item"><div class="item-line"><span class="item-title">' + esc(item.text) + '</span><span class="item-state">' + esc(item.status) + '</span></div>' +
        (item.resolution ? '<div class="item-copy">' + esc(words(item.resolution.source)) + ': ' + esc(item.resolution.reason) + '</div>' : '') + '</li>'
      ).join("") + '</ul>' : '<div class="empty-inline">No unresolved fog recorded.</div>';
    }
    function renderTasks(tasks) {
      return tasks.length ? '<ul class="item-list">' + tasks.map((task) =>
        '<li class="item"><div class="item-line"><span class="item-title">' + esc(task.title) + '</span><span class="item-state">' + esc(words(task.status)) + '</span></div>' +
        (task.description ? '<div class="item-copy">' + esc(task.description) + '</div>' : '') + '</li>'
      ).join("") + '</ul>' : '<div class="empty-inline">Tasks will arrive after slicing.</div>';
    }
    function renderActivity(activity) {
      const recent = [...activity].reverse();
      return recent.length ? '<div class="activity">' + recent.map((event) => {
        if (event.kind === "agent") {
          const failed = event.status === "failed";
          const label = esc(words(event.role || "agent")) + " · " + esc(words(event.phase || "phase")) + " · " + esc(words(event.status || "completed"));
          return '<div class="event agent' + (failed ? " failed" : "") + '"' + (event.sessionId ? ' data-session-ref="' + esc(event.sessionId) + '"' : "") + '>' +
            '<div class="event-main">' + label + '</div>' +
            '<div class="event-time">' + esc(relative(event.at)) + (event.sessionId ? ' · ' + esc(event.sessionId.slice(0, 8)) : '') + '</div></div>';
        }
        return '<div class="event"><div class="event-main">' + esc(words(event.phase || "run")) + ' · ' + esc(words(event.status || "updated")) + '</div>' +
          '<div class="event-time">' + esc(relative(event.at)) + (event.revision != null ? ' · revision ' + esc(event.revision) : '') + '</div></div>';
      }).join("") + '</div>' : '<div class="empty-inline">No lifecycle activity recorded yet.</div>';
    }
    function sessionOpenKey(sessionId) {
      return (app.selectedId || "") + ":" + sessionId;
    }
    function sessionStatus(session) {
      return session.status === "failed" ? "failed" : "completed";
    }
    function sessionDuration(session) {
      if (!session.startedAt || !session.endedAt) return "";
      const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
      if (!Number.isFinite(ms) || ms < 0) return "";
      if (ms < 1000) return ms + "ms";
      if (ms < 60000) return (ms / 1000).toFixed(1).replace(/\\.0$/, "") + "s";
      return Math.floor(ms / 60000) + "m " + Math.floor((ms % 60000) / 1000) + "s";
    }
    function cappedPre(value, label) {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      const max = 80000;
      if (text.length <= max) return '<pre>' + esc(text) + '</pre>';
      return '<pre>' + esc(text.slice(0, max)) + '\\n\\n… truncated (' + label + ' was ' + text.length + ' chars)</pre>';
    }
    function renderSessionSection(title, content, extraClass) {
      if (!content) return "";
      return '<div class="session-section' + (extraClass ? " " + extraClass : "") + '"><h4>' + esc(title) + '</h4>' + content + '</div>';
    }
    function renderSessions(sessions) {
      const recent = [...sessions].reverse();
      return recent.length ? recent.map((session, index) => {
        const id = session.sessionId || ("legacy-" + index);
        const status = sessionStatus(session);
        const phase = session.packet && session.packet.phase ? words(session.packet.phase) : "";
        const ended = session.endedAt || session.at;
        const duration = sessionDuration(session);
        const meta = [phase ? phase + " phase" : "", ended ? relative(ended) : "", duration].filter(Boolean).join(" · ");
        const packet = session.packet || {};
        const body =
          renderSessionSection("Error", session.error ? cappedPre(session.error, "error") : "", "session-error") +
          renderSessionSection("Packet input", packet.input !== undefined ? cappedPre(packet.input, "input") : "") +
          renderSessionSection("Guidance", packet.guidance ? cappedPre(packet.guidance, "guidance") : "") +
          renderSessionSection("Retrieval", packet.retrieval ? cappedPre(packet.retrieval, "retrieval") : "") +
          renderSessionSection("Budget", packet.budget ? cappedPre(packet.budget, "budget") : "") +
          renderSessionSection("Output", session.output !== undefined && session.output !== null ? cappedPre(session.output, "output") : "");
        return '<details class="session"' + (app.sessionOpen[sessionOpenKey(id)] ? " open" : "") + ' data-session="' + esc(id) + '">' +
          '<summary><span class="session-title">' + esc(words(session.role || "agent session")) + '</span>' +
          '<span class="session-status ' + esc(status) + '">' + esc(status) + '</span>' +
          (meta ? '<span class="session-meta">' + esc(meta) + '</span>' : '') +
          '</summary><div class="session-body">' + (body || '<div class="empty-inline">No packet details recorded.</div>') + '</div></details>';
      }).join("") : '<div class="empty-inline">No agent sessions recorded yet.</div>';
    }
    function copyPathBtn(value, ariaLabel) {
      if (!value) return "";
      return '<button type="button" class="copy-path-btn" data-copy-path="' + esc(value) + '" title="Copy" aria-label="' + esc(ariaLabel) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" stroke-width="2"/></svg></button>';
    }
    function renderIdentity(run) {
      const baseBranch = run.identity.baseBranch || "";
      const currentBranch = run.state.branchName || "";
      const worktreePath = run.identity.worktreePath || "";
      return '<div class="item-copy"><strong>ID</strong><br>' + esc(run.identity.runId) +
        '<br><br><span class="repo-label"><strong>Base branch</strong>' + copyPathBtn(baseBranch, "Copy base branch") + '</span><br>' + esc(baseBranch || "none") +
        '<br><br><span class="repo-label"><strong>Current branch</strong>' + copyPathBtn(currentBranch, "Copy current branch") + '</span><br>' + esc(currentBranch || "none") +
        '<br><br><span class="repo-label"><strong>Worktree</strong>' + copyPathBtn(worktreePath, "Copy worktree path") + '</span><br><span title="' + esc(worktreePath) + '">' + esc(worktreePath) + '</span></div>';
    }
    function renderRunTabs(run) {
      const tabs = [
        ["overview", "Overview", null],
        ["artifacts", "Artifacts", Object.keys(visibleArtifacts(run.state.artifacts)).length],
        ["tasks", "Tasks", run.state.tasks.length],
        ["sessions", "Sessions", app.sessions.length],
        ["activity", "Activity", app.activity.length],
        ["docker", "Docker", null]
      ];
      return '<nav class="run-tabs" aria-label="Run detail sections">' + tabs.map((entry) => {
        const active = app.runTab === entry[0];
        return '<button type="button" class="run-tab' + (active ? " active" : "") + '" data-tab="' + entry[0] + '" aria-selected="' + (active ? "true" : "false") + '">' + entry[1] +
          (entry[2] != null ? '<span class="count">' + entry[2] + '</span>' : "") + '</button>';
      }).join("") + '</nav>';
    }
    function renderSandbox(run) {
      const info = app.sandbox[run.identity.runId];
      let body;
      if (!info) {
        body = '<div class="empty-inline">Loading sandbox info…</div>';
      } else if (info.error) {
        body = '<div class="empty-inline">Sandbox info unavailable: ' + esc(info.error) + '</div>';
      } else if (info.mode === "none") {
        body = '<div class="empty-inline">Sandbox disabled — runs execute locally.</div>';
      } else if (!info.running) {
        body = '<div class="empty-inline">Container not running: ' + esc(info.containerName) + '</div>';
      } else {
        const mounts = Array.isArray(info.mounts) ? info.mounts : [];
        const env = Array.isArray(info.env) ? info.env : [];
        body = '<dl class="sandbox-meta">' +
          '<div><dt>Mode</dt><dd>' + esc(info.mode) + '</dd></div>' +
          '<div><dt>Container</dt><dd>' + esc(info.containerName) + '</dd></div>' +
          '<div><dt>Image</dt><dd>' + esc(info.image || "unknown") + '</dd></div>' +
          '<div><dt>Status</dt><dd>' + esc(info.status || "running") + '</dd></div></dl>' +
          '<h4 class="sandbox-subhead">Mounts</h4>' +
          (mounts.length
            ? '<table class="sandbox-table"><thead><tr><th>Source</th><th>Destination</th></tr></thead><tbody>' +
              mounts.map((mount) => '<tr><td>' + esc(mount.source) + '</td><td>' + esc(mount.destination) + '</td></tr>').join("") + '</tbody></table>'
            : '<div class="empty-inline">No mounts recorded.</div>') +
          '<h4 class="sandbox-subhead">Environment</h4>' +
          (env.length
            ? '<ul class="sandbox-env">' + env.map((entry) => '<li>' + esc(entry) + '</li>').join("") + '</ul>'
            : '<div class="empty-inline">No environment variables recorded.</div>');
      }
      return '<section class="panel"><div class="panel-title"><h3>Docker sandbox</h3>' +
        (info && !info.error && info.status ? '<span class="count">' + esc(info.status) + '</span>' : '') + '</div>' + body + '</section>';
    }
    function renderTabContent(run) {
      if (app.runTab === "artifacts") {
        return '<section class="panel"><div class="panel-title"><h3>Brief & evidence</h3><span class="count">' + Object.keys(visibleArtifacts(run.state.artifacts)).length + ' artifacts</span></div>' +
          renderArtifacts(run.state.artifacts) + '</section>';
      }
      if (app.runTab === "tasks") {
        return '<section class="panel"><div class="panel-title"><h3>Tasks</h3><span class="count">' + run.state.tasks.length + '</span></div>' +
          renderTasks(run.state.tasks) + '</section>';
      }
      if (app.runTab === "sessions") {
        return '<section class="panel"><div class="panel-title"><h3>Agent sessions</h3><span class="count">' + app.sessions.length + '</span></div>' +
          renderSessions(app.sessions) + '</section>';
      }
      if (app.runTab === "activity") {
        return '<section class="panel"><div class="panel-title"><h3>Activity</h3><span class="count">' + app.activity.length + ' events</span></div>' +
          renderActivity(app.activity) + '</section>';
      }
      if (app.runTab === "docker") {
        return renderSandbox(run);
      }
      return '<div class="content-grid"><section class="panel"><div class="panel-title"><h3>Unknowns & fog</h3><span class="count">' + run.state.fog.length + '</span></div>' +
        renderFog(run.state.fog) + '</section><aside class="panel"><div class="panel-title"><h3>Run identity</h3></div>' +
        renderIdentity(run) + '</aside></div>';
    }
    function maybeLoadSandbox(run, refresh) {
      const runId = run.identity.runId;
      if (app.sandboxPending[runId]) return;
      if (!refresh && app.sandbox[runId]) return;
      app.sandboxPending[runId] = true;
      api("/api/runs/" + encodeURIComponent(runId) + "/sandbox").then((data) => {
        app.sandbox[runId] = data;
      }).catch((error) => {
        app.sandbox[runId] = { error: error.message || "request failed" };
      }).finally(() => {
        delete app.sandboxPending[runId];
        if (app.view === "run" && app.run && app.selectedId === runId && app.runTab === "docker") renderDetail();
      });
    }
    function renderDetail() {
      const run = app.run;
      if (!run) return;
      setComposeActive(false);
      const terminal = run.state.status === "completed" || run.state.status === "cancelled";
      const blocked = run.state.status === "blocked";
      const deleting = app.busy && app.busy.action === "delete" && app.busy.runId === run.identity.runId;
      const busyLocked = Boolean(app.busy && app.busy.runId === run.identity.runId);
      const answering = app.busy && app.busy.action === "answer" && app.busy.runId === run.identity.runId;
      const progressText = workingSummary(run) || (busyLocked && app.busy.message ? app.busy.message : "");
      const statusLabel = deleting ? "Deleting" : (answering ? "Active" : words(run.state.status));
      const statusClass = deleting ? "blocked" : (answering ? "active" : run.state.status);
      el("detail").innerHTML =
        '<header class="topbar"><div><div class="eyebrow">' + esc(run.identity.projectKey) + ' · ' + esc(run.identity.workflowBundleId) + ' workflow</div>' +
        '<h2 class="run-heading">' + esc(runLabel(run)) + '</h2>' + (runIdea(run) ? '<p class="lede">' + esc(runIdea(run)) + '</p>' : '') + '<div class="top-meta"><span class="status ' + esc(statusClass) + (deleting || answering ? " busy-pulse" : "") + '">' + esc(statusLabel) + '</span>' +
        '<span>' + esc(words(run.state.phase)) + '</span><span>rev ' + esc(run.state.revision) + '</span><span>' + esc(relative(run.state.updatedAt)) + '</span></div>' +
        (progressText ? '<div class="working-line busy-pulse"><strong>Working</strong><span>' + esc(progressText) + '</span></div>' : '') +
        '</div>' +
        '<div class="actions"><button class="secondary" data-action="continue" type="button"' + (busyLocked || terminal || run.state.status === "awaiting_input" || workingSummary(run) ? ' disabled' : '') + '>' + (app.busy && app.busy.action === "continue" && app.busy.runId === run.identity.runId ? esc(app.busy.label) : "Continue") + '</button>' +
        '<button class="secondary' + (app.busy && app.busy.action === "retry" && app.busy.runId === run.identity.runId ? " busy-pulse" : "") + '" data-action="retry" type="button"' + (busyLocked || !blocked || run.state.block && !run.state.block.retriable ? ' disabled' : '') + '>' + (app.busy && app.busy.action === "retry" && app.busy.runId === run.identity.runId ? esc(app.busy.label) : "Retry") + '</button>' +
        '<button class="danger" data-action="cancel" type="button"' + (busyLocked || terminal ? ' disabled' : '') + '>Cancel</button>' +
        '<button class="danger' + (deleting ? ' busy-pulse' : '') + '" data-action="delete" type="button"' + (busyLocked ? ' disabled' : '') + '>' + (deleting ? 'Deleting…' : 'Delete') + '</button></div></header>' +
        '<nav class="phase-track" aria-label="Run phases">' + renderPhases(run) + '</nav>' +
        renderRunTabs(run) +
        (run.state.block && !gateHiddenWhileBusy(run) ? '<div class="block"><strong>Run blocked.</strong> ' + esc(run.state.block.reason) + '</div>' : '') +
        renderGate(run) +
        renderTabContent(run);
      autosizeReflectFields();
      if (app.runTab === "docker") maybeLoadSandbox(run);
    }
    async function loadProjects() {
      app.projects = await api("/api/projects");
      if (app.view === "compose") renderCompose();
      else renderProjects();
    }
    async function refresh(options = {}) {
      const runs = await api("/api/runs");
      app.runs = runs;
      renderRuns();
      if (app.busy && app.busy.action === "start" && !app.selectedId) {
        const live = runs.find((run) => run.state && run.state.working);
        if (live) {
          if (app.selectedId !== live.identity.runId) app.runTab = "overview";
          app.selectedId = live.identity.runId;
          app.view = "run";
        }
      }
      if (app.view === "compose" && !app.selectedId) return;
      if (app.view === "guidance") return;
      if (!app.selectedId && options.selectFirst && runs[0]) {
        app.runTab = "overview";
        app.selectedId = runs[0].identity.runId;
      }
      if (app.selectedId) await openRun(app.selectedId, Boolean(options.force));
      else if (options.selectFirst) showCompose();
      else if (app.view !== "compose" && app.view !== "guidance") renderEmpty();
    }
    async function openRun(id, force) {
      if (app.selectedId !== id) app.runTab = "overview";
      app.selectedId = id;
      const [run, activity, sessions] = await Promise.all([
        api("/api/runs/" + encodeURIComponent(id)),
        api("/api/runs/" + encodeURIComponent(id) + "/activity"),
        api("/api/runs/" + encodeURIComponent(id) + "/sessions"),
      ]);
      if (app.selectedId !== id) return;
      app.view = "run";
      const workingKey = workingSummary(run) + ":" + ((run.state.working && run.state.working.startedAt) || "");
      const signature = id + ":" + run.state.revision + ":" + run.state.status + ":" + run.state.phase + ":" + activity.length + ":" + sessions.length + ":" + workingKey + ":" + (app.busy ? app.busy.action : "");
      app.run = run; app.activity = activity; app.sessions = sessions;
      renderRuns();
      if (force || signature !== app.signature) {
        app.signature = signature;
        renderDetail();
        if (app.runTab === "docker") {
          const terminal = run.state.status === "completed" || run.state.status === "cancelled";
          maybeLoadSandbox(run, !terminal);
        }
      }
      maybePlayStatusSound(run.state.status);
    }
    async function mutate(action, payload) {
      if (!app.selectedId || app.busy) return;
      const runId = app.selectedId;
      if (action === "delete") {
        const request = api("/api/runs/" + encodeURIComponent(runId) + "/delete", { method: "POST", body: "{}" });
        app.runs = app.runs.filter((run) => run.identity.runId !== runId);
        delete app.drafts[runId];
        delete app.sandbox[runId];
        app.selectedId = null;
        app.run = null;
        app.activity = [];
        app.sessions = [];
        app.signature = "";
        renderRuns();
        const next = app.runs[0];
        if (next) await openRun(next.identity.runId, true);
        else renderEmpty();
        try {
          await request;
          toast("Run removed; cleanup is continuing in the background");
        } catch (error) {
          await refresh({ selectFirst: true, force: true });
          toast(error.message, true);
        }
        return;
      }
      const pending = action === "cancel"
          ? { action: "cancel", runId, message: "Cancelling run…", label: "Cancelling…" }
          : action === "answer"
            ? { action: "answer", runId, message: "Submitting answers… continuing the run", label: "Submitting…" }
            : action === "continue"
              ? { action: "continue", runId, message: "Continuing run…", label: "Continuing…" }
              : action === "retry"
                ? { action: "retry", runId, message: "Retrying…", label: "Retrying…" }
                : null;
      try {
        if (pending) {
          toastBusy(pending.message);
          setActionBusy(pending);
          if (app.run) renderDetail();
          if (action === "answer" || action === "continue" || action === "retry") focusRunChrome();
        }
        await api("/api/runs/" + encodeURIComponent(runId) + "/" + action, { method: "POST", body: JSON.stringify(payload || {}) });
        if (action === "answer") delete app.drafts[runId];
        clearActionBusy();
        await refresh({ force: true });
        if (action === "answer" || action === "continue" || action === "retry") focusRunChrome();
      } catch (error) {
        clearActionBusy();
        if (app.run) renderDetail();
        toast(error.message, true);
      }
    }
    el("new-run-toggle").onclick = () => { if (!app.busy) showCompose(); };
    el("guidance-toggle").onclick = () => showGuidance();
    el("nav-toggle").onclick = () => document.body.classList.toggle("nav-open");
    el("soundMuteBtn").onclick = () => setSoundsMuted(!soundsMuted());
    setSoundsMuted(soundsMuted());
    el("refresh").onclick = () => {
      if (app.busy) return;
      if (app.view === "guidance") {
        loadGuidanceRoles().catch((error) => toast(error.message, true));
        return;
      }
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
      if (!target || (target.id !== "idea" && target.id !== "project" && target.id !== "workflow" && target.id !== "base-branch")) return false;
      if (target.id === "idea") app.compose.idea = target.value;
      if (target.id === "project") app.compose.projectKey = target.value;
      if (target.id === "workflow") app.compose.workflow = target.value;
      if (target.id === "base-branch") app.compose.baseBranch = target.value;
      return true;
    }
    el("detail").addEventListener("submit", async (event) => {
      if (event.target.id !== "start-form") return;
      event.preventDefault();
      if (app.busy) return;
      const idea = el("idea").value.trim();
      const projectKey = el("project").value;
      const workflow = el("workflow").value;
      const baseBranch = el("base-branch").value.trim();
      if (!idea || !projectKey) return toast("Choose a project and enter an idea.", true);
      if (!baseBranch) return toast("Choose a base branch.", true);
      app.compose.idea = idea;
      app.compose.projectKey = projectKey;
      app.compose.workflow = workflow;
      app.compose.baseBranch = baseBranch;
      const pending = {
        action: "start",
        message: "Starting wayfinding… creating worktree and opening first phase",
        label: "Starting…",
      };
      try {
        toastBusy(pending.message);
        app.busy = pending;
        renderCompose();
        const run = await api("/api/runs", { method: "POST", body: JSON.stringify({ idea, projectKey, workflowBundleId: workflow, baseBranch }) });
        app.compose.idea = "";
        clearActionBusy();
        app.view = "run";
        app.selectedId = run.identity.runId;
        await refresh({ force: true });
      } catch (error) {
        clearActionBusy();
        renderCompose();
        toast(error.message, true);
      }
    });
    el("detail").addEventListener("input", (event) => {
      if (saveComposeDraft(event.target)) return;
      if (!app.selectedId || !app.run || !app.run.state.gate) return;
      const draft = ensureDraft(app.selectedId);
      if (event.target.dataset.reflectListItem) {
        syncReflectListAnswers(event.target.dataset.reflectListItem, draft);
      }
      if (event.target.dataset.answer) draft.answers[event.target.dataset.answer] = event.target.value;
      if (event.target.dataset.batchAnswer) draft.answers[event.target.dataset.batchAnswer] = event.target.value;
      if (event.target.dataset.batchClarifyText) draft.clarifications[event.target.dataset.batchClarifyText] = event.target.value;
      if (event.target.dataset.park) draft.parked[event.target.dataset.park] = event.target.checked;
      if (event.target.id === "gate-notes") draft.notes = event.target.value;
      autosizeTextarea(event.target);
    });
    el("detail").addEventListener("toggle", (event) => {
      const artifact = event.target.closest && event.target.closest("details.artifact[data-artifact]");
      if (artifact && artifact === event.target) {
        app.artifactOpen[artifactOpenKey(artifact.dataset.artifact)] = artifact.open;
        return;
      }
      const session = event.target.closest && event.target.closest("details.session[data-session]");
      if (!session || session !== event.target) return;
      app.sessionOpen[sessionOpenKey(session.dataset.session)] = session.open;
    }, true);
    el("detail").addEventListener("change", (event) => {
      if (event.target.id === "guidance-scope") {
        app.guidanceScope = event.target.value;
        return;
      }
      if (!saveComposeDraft(event.target)) return;
      if (event.target.id === "project") {
        app.compose.baseBranch = "";
        void loadBranches(event.target.value);
      }
    });
    el("detail").addEventListener("click", (event) => {
      const copyBtn = event.target.closest("[data-copy-path]");
      if (copyBtn) {
        const path = copyBtn.dataset.copyPath;
        if (!path) { toast("Nothing to copy", true); return; }
        const copied = () => toast("Copied");
        const failed = () => toast("Could not copy", true);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(path).then(copied).catch(failed);
        } else {
          const area = document.createElement("textarea");
          area.value = path;
          area.setAttribute("readonly", "");
          area.style.position = "fixed";
          area.style.opacity = "0";
          document.body.appendChild(area);
          area.select();
          try { if (document.execCommand("copy")) copied(); else failed(); } catch (_) { failed(); }
          document.body.removeChild(area);
        }
        return;
      }
      const tab = event.target.closest("[data-tab]");
      if (tab && app.run) {
        app.runTab = tab.dataset.tab;
        renderDetail();
        return;
      }
      const guidanceRole = event.target.closest("[data-guidance-role]");
      if (guidanceRole) {
        app.guidanceRole = guidanceRole.dataset.guidanceRole;
        renderGuidanceRoles();
        loadGuidanceRoleDetail().catch((error) => toast(error.message, true));
        return;
      }
      const guidanceSave = event.target.closest("[data-guidance-save]");
      if (guidanceSave) {
        saveGuidanceOverride().catch((error) => toast(error.message, true));
        return;
      }
      const guidanceReset = event.target.closest("[data-guidance-reset]");
      if (guidanceReset) {
        if (!confirm("Remove this override and restore the packaged default?")) return;
        resetGuidanceOverride().catch((error) => toast(error.message, true));
        return;
      }
      const composeAction = event.target.closest('[data-action="compose"]');
      if (composeAction) {
        showCompose();
        return;
      }
      const batchChoice = event.target.closest("[data-batch-choice]");
      if (batchChoice && app.selectedId) {
        selectBatchOption(batchChoice.dataset.batchChoice, batchChoice.dataset.optionId);
        return;
      }
      const batchSkip = event.target.closest("[data-batch-skip]");
      if (batchSkip && app.selectedId) {
        toggleBatchSkip(batchSkip.dataset.batchSkip);
        return;
      }
      const batchClarify = event.target.closest("[data-batch-clarify]");
      if (batchClarify && app.selectedId) {
        toggleBatchClarify(batchClarify.dataset.batchClarify);
        return;
      }
      const acceptAll = event.target.closest("[data-batch-accept-all]");
      if (acceptAll && app.selectedId) {
        acceptAllRecommendations();
        return;
      }
      const choice = event.target.closest("[data-choice]");
      if (choice && app.selectedId) {
        const draft = ensureDraft(app.selectedId);
        draft.answers[choice.dataset.choice] = choice.dataset.value;
        document.querySelectorAll('[data-choice="' + CSS.escape(choice.dataset.choice) + '"]').forEach((node) => node.classList.toggle("selected", node === choice));
        return;
      }
      const listAdd = event.target.closest("[data-reflect-list-add]");
      if (listAdd && app.selectedId) {
        const fieldId = listAdd.dataset.reflectListAdd;
        const draft = ensureDraft(app.selectedId);
        syncReflectListAnswers(fieldId, draft);
        const entries = reflectListEntries(draft.answers[fieldId] || "");
        entries.push("");
        draft.answers[fieldId] = entries.join("\\n");
        replaceReflectList(fieldId, draft);
        const inputs = document.querySelectorAll('[data-reflect-list-item="' + CSS.escape(fieldId) + '"]');
        const last = inputs[inputs.length - 1];
        if (last) last.focus();
        return;
      }
      const listRemove = event.target.closest("[data-reflect-list-remove]");
      if (listRemove && app.selectedId && !listRemove.disabled) {
        const fieldId = listRemove.dataset.reflectListRemove;
        const index = Number(listRemove.dataset.index);
        const draft = ensureDraft(app.selectedId);
        syncReflectListAnswers(fieldId, draft);
        const entries = reflectListEntries(draft.answers[fieldId] || "");
        if (entries.length <= 1) {
          draft.answers[fieldId] = "";
        } else {
          entries.splice(index, 1);
          draft.answers[fieldId] = entries.join("\\n");
        }
        replaceReflectList(fieldId, draft);
        return;
      }
      const action = event.target.closest("[data-action]");
      if (!action || action.disabled || app.busy) return;
      if (action.dataset.action === "cancel" && !confirm("Cancel this run and destroy its sandbox?")) return;
      if (action.dataset.action === "delete" && !confirm("Permanently delete this run, its sandbox, worktree, and stored artifacts?")) return;
      if (action.dataset.action === "answer") {
        const draft = ensureDraft(app.selectedId);
        document.querySelectorAll("[data-reflect-list]").forEach((node) => {
          syncReflectListAnswers(node.dataset.reflectList, draft);
        });
        const gate = app.run && app.run.state.gate;
        if (gate && gate.id === "grill-batch") {
          const payload = buildGrillAnswerPayload(gate, draft);
          if (payload.missing.length) {
            draft.batchFeedback = payload.missing.length + " question(s) still need an answer, Skip, or Wait what? with a clarification.";
            renderDetail();
            const focus = document.querySelector('[data-batch-question="' + CSS.escape(payload.missing[0]) + '"]');
            if (focus) focus.focus();
            return;
          }
          draft.batchFeedback = "";
          mutate("answer", {
            answers: payload.answers,
            parked: payload.parked,
            clarifications: payload.clarifications,
            notes: draft.notes,
          });
          return;
        }
        const parked = Object.keys(draft.parked).filter((key) => draft.parked[key]);
        mutate("answer", { answers: draft.answers, parked, notes: draft.notes });
        return;
      }
      mutate(action.dataset.action);
    });
    document.addEventListener("keydown", (event) => {
      if (!app.run || !app.run.state.gate || app.run.state.gate.id !== "grill-batch") return;
      const target = event.target;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) return;
      const focused = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest("[data-batch-question]")
        : null;
      if (!focused) return;
      const qid = focused.getAttribute("data-batch-question");
      if (!qid) return;
      if (event.key === "Escape") {
        event.preventDefault();
        toggleBatchSkip(qid);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const nodes = Array.from(document.querySelectorAll("[data-batch-question]"));
        const index = nodes.indexOf(focused);
        if (index < 0) return;
        const next = nodes[(index + (event.key === "ArrowDown" ? 1 : -1) + nodes.length) % nodes.length];
        if (next) next.focus();
        return;
      }
      if (/^[1-4]$/.test(event.key)) {
        const option = focused.querySelector('[data-option-index="' + (Number(event.key) - 1) + '"]');
        if (option) {
          event.preventDefault();
          selectBatchOption(qid, option.getAttribute("data-option-id"));
        }
      }
    });
    Promise.all([loadProjects(), refresh({ selectFirst: true, force: true })]).catch((error) => toast(error.message, true));
    setInterval(() => refresh().catch(() => {}), 4000);
  </script>
</body>
</html>`;
}

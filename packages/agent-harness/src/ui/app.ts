import { clientScriptBody } from "./client/parts.js";

export function renderDashboard(): string {
  const clientScript = clientScriptBody();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>HexAgent Harness</title>
  <style>
    :root {
      --bg: #0b0d10;
      --surface: #12151a;
      --surface-2: #181c22;
      --surface-3: #20252d;
      --line: #2a3039;
      --line-soft: #20252c;
      --text: #f3f0e8;
      --muted: #9aa1aa;
      --faint: #68717d;
      --lime: #c7f36b;
      --lime-2: #8fbd38;
      --orange: #ff9d5c;
      --blue: #79b8ff;
      --red: #ff7373;
      --purple: #b99cff;
      --shadow: 0 24px 80px rgba(0,0,0,.38);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); overflow-anchor: none; }
    body { font: 14px/1.5 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, textarea, input, select { font: inherit; }
    button { color: inherit; }
    ::selection { background: rgba(199,243,107,.28); }
    .noise { position: fixed; inset: 0; pointer-events: none; opacity: .018; z-index: 10; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 180 180' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.7'/%3E%3C/svg%3E"); }
    .shell { display: grid; grid-template-columns: 300px minmax(0,1fr); min-height: 100vh; }
    .sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; border-right: 1px solid var(--line-soft); background: #0e1115; overflow: hidden; }
    .brand { display: flex; align-items: center; gap: 12px; padding: 23px 22px 18px; }
    .mark { width: 35px; height: 35px; display: grid; place-items: center; border-radius: 11px; color: #0b0d10; background: var(--lime); box-shadow: 0 0 30px rgba(199,243,107,.13); }
    .brand strong { display:block; letter-spacing: -.02em; font-size: 16px; }
    .brand span { color: var(--faint); font-size: 11px; letter-spacing: .09em; text-transform: uppercase; }
    .sidebar-actions { display:flex; gap:8px; padding: 0 16px 16px; }
    .btn { border: 1px solid var(--line); background: var(--surface-2); border-radius: 10px; padding: 9px 13px; cursor: pointer; transition: .16s ease; display:inline-flex; align-items:center; justify-content:center; gap:7px; font-weight: 650; }
    .btn:hover { border-color:#414a56; background:#20262e; transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn.primary { background: var(--lime); color:#10130d; border-color: var(--lime); }
    .btn.primary:hover { background:#d4fa83; }
    .btn.danger { color:#ffaaaa; border-color:rgba(255,115,115,.3); }
    .btn.ghost { background: transparent; border-color: transparent; color:var(--muted); }
    .btn.small { padding:6px 9px; font-size:12px; border-radius:8px; }
    .new-btn { flex:1; }
    .icon-btn { width:38px; padding:0; }
    .search-wrap { padding: 0 16px 12px; }
    .search { width:100%; border:1px solid var(--line-soft); border-radius:10px; color:var(--text); background:#0b0d10; padding:9px 11px; outline:none; }
    .search:focus { border-color:var(--lime-2); box-shadow:0 0 0 3px rgba(199,243,107,.08); }
    .section-label { padding: 8px 20px; color:var(--faint); font-size:10px; letter-spacing:.13em; text-transform:uppercase; font-weight:800; }
    /* Polling rewrites this list and restores scrollTop by hand; Chrome's
       scroll anchoring fights that restore with micro-adjustments and warns. */
    .run-list { overflow:auto; overflow-anchor:none; flex:1; padding:0 9px 20px; }
    [data-scroll-key] { overflow-anchor: none; }
    .run-item { width:100%; text-align:left; border:1px solid transparent; background:transparent; padding:11px 12px; border-radius:11px; cursor:pointer; margin:2px 0; }
    .run-item:hover { background:var(--surface); }
    .run-item.active { background:var(--surface-2); border-color:var(--line); }
    .run-title { display:flex; gap:8px; align-items:center; font-size:13px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .run-title > span { min-width:0; overflow:hidden; text-overflow:ellipsis; }
    .run-warn { margin-left:auto; flex:none; width:16px; height:16px; border-radius:5px; display:inline-grid; place-items:center; background:rgba(255,115,115,.15); color:var(--red); font-size:11px; font-weight:800; line-height:1; box-shadow:inset 0 0 0 1px rgba(255,115,115,.45); animation:pulse 1.5s infinite; }
    .run-meta { display:flex; align-items:center; justify-content:space-between; color:var(--faint); font-size:11px; margin-top:6px; }
    .dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--faint); }
    .dot.completed { background:var(--lime); box-shadow:0 0 10px rgba(199,243,107,.4); }
    .dot.blocked { background:var(--red); }
    .dot.waiting { background:var(--orange); }
    .dot.awaiting_input { background:var(--orange); }
    .dot.running, .dot.queued { background:var(--blue); animation:pulse 1.5s infinite; }
    @keyframes pulse { 50% { opacity:.35; } }
    .sidebar-foot { border-top:1px solid var(--line-soft); padding:14px 16px; }
    .global-link { width:100%; justify-content:flex-start; }
    .connection { display:flex; align-items:center; gap:7px; color:var(--faint); font-size:11px; padding:10px 5px 0; }
    .connection i { width:6px;height:6px;border-radius:50%;background:var(--lime); }
    .main { min-width:0; }
    .topbar { height:72px; display:flex; align-items:center; justify-content:space-between; padding:0 34px; border-bottom:1px solid var(--line-soft); background:rgba(11,13,16,.78); backdrop-filter: blur(18px); position:sticky; top:0; z-index:5; }
    .crumb { color:var(--muted); display:flex; align-items:center; gap:9px; min-width:0; }
    .crumb strong { color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:50vw; }
    .top-actions, .top-action-slot { display:flex; gap:8px; align-items:center; }
    .mobile-menu { display:none; }
    .content { max-width:1240px; margin:0 auto; padding:36px 38px 80px; }
    .hero { min-height:calc(100vh - 160px); display:grid; align-items:center; grid-template-columns:minmax(0,1.15fr) minmax(330px,.85fr); gap:60px; }
    .eyebrow { color:var(--lime); font-size:11px; font-weight:800; letter-spacing:.16em; text-transform:uppercase; }
    h1 { font-size:clamp(38px,5vw,68px); letter-spacing:-.055em; line-height:.98; margin:14px 0 20px; max-width:850px; }
    .hero-copy { color:var(--muted); font-size:17px; max-width:650px; }
    .hero-card { border:1px solid var(--line); background:linear-gradient(145deg,#171b20,#101318); border-radius:22px; padding:26px; box-shadow:var(--shadow); }
    .route { display:grid; gap:9px; margin-top:18px; }
    .route-step { display:flex; align-items:center; gap:12px; color:var(--muted); }
    .route-step b { width:26px;height:26px;border:1px solid var(--line);border-radius:8px;display:grid;place-items:center;color:var(--lime);font-size:11px;background:var(--bg); }
    .title-row { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:24px; }
    .title-row h1 { color:#dedbd2; font-size:clamp(28px,3vw,42px); font-weight:680; line-height:1.06; letter-spacing:-.04em; margin:8px 0 10px; max-width:780px; }
    .subtitle { color:var(--muted); max-width:780px; }
    .badge { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--line); background:var(--surface-2); color:var(--muted); border-radius:999px; padding:6px 10px; font-size:11px; font-weight:750; text-transform:uppercase; letter-spacing:.07em; white-space:nowrap; }
    .badge.completed { color:var(--lime); border-color:rgba(199,243,107,.25); background:rgba(199,243,107,.07); }
    .badge.blocked { color:var(--red); border-color:rgba(255,115,115,.3); background:rgba(255,115,115,.07); }
    .badge.awaiting_input { color:var(--orange); border-color:rgba(255,157,92,.3); background:rgba(255,157,92,.07); }
    .badge.running, .badge.queued { color:var(--blue); border-color:rgba(121,184,255,.3); background:rgba(121,184,255,.07); }
    .run-vitals { display:flex; gap:8px; margin:0 0 16px; flex-wrap:wrap; }
    .vital { display:flex; flex-direction:column; align-items:flex-start; gap:2px; flex:1 1 140px; min-width:0; border:1px solid var(--line); background:var(--surface-2); border-radius:10px; padding:8px 12px; color:var(--text); cursor:pointer; text-align:left; }
    .vital:hover { border-color:rgba(199,243,107,.35); color:var(--text); }
    .vital.active { border-color:rgba(199,243,107,.4); background:rgba(199,243,107,.07); }
    .vital-label { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.1em; font-weight:800; }
    .vital-value { font-size:15px; font-weight:680; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
    .vital-meta { color:var(--muted); font-size:11px; line-height:1.35; }
    .tabs { display:flex; gap:3px; border-bottom:1px solid var(--line-soft); margin-bottom:26px; overflow:auto; }
    .tab { border:0; border-bottom:2px solid transparent; background:transparent; padding:12px 14px; color:var(--muted); cursor:pointer; white-space:nowrap; }
    .tab:hover { color:var(--text); }
    .tab.active { color:var(--text); border-bottom-color:var(--lime); }
    .grid { display:grid; grid-template-columns:repeat(12,minmax(0,1fr)); gap:16px; }
    .card { grid-column:span 12; border:1px solid var(--line-soft); background:var(--surface); border-radius:var(--radius); padding:20px; }
    .card.third { grid-column:span 4; }
    .card.half { grid-column:span 6; }
    .card.two-thirds { grid-column:span 8; }
    .card h2, .card h3 { margin:0 0 7px; letter-spacing:-.02em; }
    .card h2 { font-size:18px; }
    .card h3 { font-size:15px; }
    .card-label { color:var(--faint); font-size:10px; text-transform:uppercase; letter-spacing:.13em; font-weight:800; margin-bottom:8px; }
    .metric { font-size:34px; line-height:1; letter-spacing:-.04em; margin:10px 0 8px; font-weight:720; }
    .muted { color:var(--muted); }
    .faint { color:var(--faint); }
    .repo-label { display:flex; align-items:center; gap:6px; margin-top:12px; }
    .copy-path-btn { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--faint); cursor:pointer; }
    .copy-path-btn:hover { color:var(--text); background:var(--surface-3); }
    .copy-path-btn svg { display:block; }
    .progress { height:6px; background:var(--surface-3); border-radius:99px; overflow:hidden; margin-top:13px; }
    .progress > i { display:block; height:100%; width:0; max-width:100%; background:linear-gradient(90deg,var(--lime-2),var(--lime)); border-radius:99px; }
    .budget-meter { margin-top:16px; }
    .budget-meter + .budget-meter { margin-top:14px; }
    .budget-meter-head { display:flex; justify-content:space-between; align-items:baseline; gap:12px; margin-bottom:8px; color:var(--muted); font-size:12px; }
    .budget-meter-head strong { color:var(--text); font-weight:650; }
    .budget-meter .progress { margin-top:0; }
    .budget-meter-foot { margin-top:7px; color:var(--faint); font-size:12px; }
    .usage-breakdown { margin-top:16px; }
    .usage-breakdown > summary { list-style:none; font-size:12px; font-weight:650; color:var(--muted); }
    .usage-breakdown > summary::-webkit-details-marker { display:none; }
    .usage-breakdown > summary::before { content:"▸"; display:inline-block; width:1em; color:var(--faint); transition:transform .12s ease; }
    .usage-breakdown[open] > summary::before { transform:rotate(90deg); }
    .usage-mini-tabs { display:flex; gap:6px; margin:12px 0 10px; flex-wrap:wrap; }
    .usage-mini-tab { border:1px solid var(--line); background:var(--surface-2); color:var(--muted); border-radius:8px; padding:6px 10px; font-size:12px; font-weight:650; cursor:pointer; }
    .usage-mini-tab:hover { color:var(--text); }
    .usage-mini-tab.active { color:var(--text); border-color:rgba(199,243,107,.35); background:rgba(199,243,107,.08); }
    .usage-table-wrap { overflow:auto; border:1px solid var(--line-soft); border-radius:10px; background:#0e1115; }
    .usage-table { width:100%; border-collapse:collapse; font-size:12.5px; }
    .usage-table th, .usage-table td { padding:8px 10px; border-bottom:1px solid var(--line-soft); vertical-align:top; }
    .usage-table th { color:var(--faint); font-size:10px; font-weight:750; text-transform:uppercase; letter-spacing:.08em; text-align:left; white-space:nowrap; }
    .usage-table td.num, .usage-table th.num { text-align:right; font-variant-numeric:tabular-nums; }
    .usage-table tbody tr:last-child td { border-bottom:0; }
    .usage-table code { color:var(--text); font:12px/1.4 "SFMono-Regular",Consolas,monospace; }
    .question-card { border-color:rgba(255,157,92,.28); background:linear-gradient(145deg,rgba(255,157,92,.09),var(--surface)); }
    .question { font-size:20px; letter-spacing:-.02em; margin:8px 0 6px; max-width:850px; }
    .question-context { color:var(--muted); max-width:850px; margin:0 0 16px; }
    .question-options { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:9px; margin:0 0 14px; }
    .question-options.layout-rows { grid-template-columns:1fr; }
    .question-options.layout-rows .question-option { min-height:72px; }
    .question-option { position:relative; display:block; width:100%; min-height:92px; text-align:left; border:1px solid var(--line); border-radius:12px; background:#0e1115; color:var(--text); padding:13px 14px; cursor:pointer; }
    .question-option:hover { border-color:var(--orange); background:rgba(255,157,92,.06); }
    .question-option.recommended { border-color:rgba(199,243,107,.35); }
    .question-option strong { display:block; padding-right:78px; }
    .question-option small { display:block; color:var(--muted); margin-top:5px; line-height:1.4; }
    .recommendation-badge { position:absolute; top:11px; right:11px; color:var(--lime); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .recommendation { border-left:2px solid var(--lime-2); background:rgba(199,243,107,.04); color:#dce9c3; padding:9px 12px; margin:0 0 16px; }
    .recommendation strong { margin-right:5px; }
    .thinking-strip { grid-column:span 12; display:flex; align-items:center; gap:12px; min-height:48px; border:1px solid rgba(121,184,255,.22); border-radius:12px; background:rgba(121,184,255,.055); padding:11px 14px; color:#c9ddf5; }
    .thinking-copy { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
    .thinking-copy strong { font-size:13px; }
    .thinking-copy span { color:var(--muted); font-size:12px; }
    .thinking-dots { display:inline-flex; align-items:center; gap:4px; }
    .thinking-dots i { width:5px; height:5px; border-radius:50%; background:var(--blue); animation:thinking 1.25s infinite ease-in-out; }
    .thinking-dots i:nth-child(2) { animation-delay:.15s; }
    .thinking-dots i:nth-child(3) { animation-delay:.3s; }
    @keyframes thinking { 0%,60%,100% { opacity:.22; transform:translateY(0); } 30% { opacity:1; transform:translateY(-3px); } }
    textarea, input[type=text], input[type=number], select { width:100%; border:1px solid var(--line); border-radius:11px; color:var(--text); background:#0c0f12; padding:11px 13px; outline:none; resize:vertical; }
    textarea:focus, input:focus { border-color:var(--lime-2); box-shadow:0 0 0 3px rgba(199,243,107,.07); }
    .answer-row { display:flex; gap:10px; align-items:flex-end; }
    .answer-row textarea { min-height:86px; }
    .answer-row .btn { height:43px; }
    .reflect-card { border-color:rgba(121,184,255,.28); background:linear-gradient(145deg,rgba(121,184,255,.08),var(--surface)); }
    .reflect-editor { display:grid; gap:12px; }
    .reflect-editor textarea { min-height:380px; width:100%; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; line-height:1.45; }
    .reflect-fields { display:grid; gap:14px; }
    .reflect-fields textarea { min-height:220px; overflow:hidden; }
    .reflect-fields textarea.reflect-goal { min-height:100px; }
    .reflect-list-section h3 { margin:0 0 6px; font-size:12px; color:var(--faint); text-transform:uppercase; letter-spacing:.09em; }
    .reflect-list-row { display:flex; gap:8px; align-items:flex-start; margin-bottom:7px; }
    .reflect-list-row textarea { flex:1; min-height:42px; resize:vertical; overflow:hidden; }
    .reflect-list-row button { flex:none; margin-top:4px; }
    .batch-question.clarifying { opacity:1; }
    .batch-clarify-box { margin-top:8px; }
    .batch-clarify-box textarea { min-height:72px; }
    .batch-question-foot { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; flex-wrap:wrap; }
    .brief-body { margin:8px 0 0; color:var(--muted); font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
    .question-option.selected { border-color:var(--lime-2); background:rgba(199,243,107,.08); box-shadow:0 0 0 2px rgba(199,243,107,.15) inset; }
    .selected-badge { position:absolute; top:11px; right:11px; color:var(--lime); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .batch-question { border:1px solid var(--line-soft); border-radius:13px; background:rgba(11,13,16,.35); padding:14px 15px; margin-bottom:12px; }
    .batch-question:focus { outline:2px solid var(--orange); outline-offset:2px; }
    .batch-question.parked { opacity:.55; }
    .batch-question textarea { min-height:64px; margin-top:8px; }
    .keyboard-hint { margin:2px 0 14px; }
    .batch-footer { position:sticky; bottom:-20px; margin:14px -20px -20px; padding:12px 20px; background:var(--surface); border-top:1px solid var(--line-soft); display:flex; align-items:center; justify-content:space-between; gap:12px; border-radius:0 0 var(--radius) var(--radius); flex-wrap:wrap; }
    .fog-card .card-label { margin-bottom:4px; }
    .fog-summary { color:var(--muted); margin:0 0 14px; }
    .fog-entry { border-left:2px solid var(--orange); padding:8px 12px; margin-bottom:9px; background:rgba(255,157,92,.04); border-radius:0 9px 9px 0; }
    .fog-entry .item-title { font-size:13px; }
    .fog-entry.impact-blocking { border-left-color:var(--red); }
    .fog-entry.impact-shaping { border-left-color:var(--orange); }
    .fog-entry.impact-minor { border-left-color:var(--faint); }
    .fog-group-label { font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.08em; margin:10px 0 6px; }
    .note-box { border:1px solid var(--line-soft); border-radius:13px; padding:14px 15px; margin-top:16px; }
    .note-box textarea { min-height:64px; }
    .note-row { display:flex; align-items:center; gap:10px; margin-top:9px; flex-wrap:wrap; }
    .note-row label { display:flex; align-items:center; gap:6px; color:var(--muted); font-size:12px; }
    .note-list { margin-top:14px; display:grid; gap:8px; }
    .note-item { border:1px solid var(--line-soft); border-radius:9px; padding:8px 11px; color:var(--muted); font-size:12.5px; }
    .note-item b { color:var(--text); }
    .alert { border:1px solid rgba(255,115,115,.3); background:rgba(255,115,115,.07); border-radius:var(--radius); padding:18px; display:flex; justify-content:space-between; align-items:flex-start; gap:18px; min-width:0; }
    .alert > :first-child { flex:1 1 auto; min-width:0; }
    .alert > .btn, .alert > .alert-actions { flex:0 0 auto; }
    .alert-actions { display:grid; gap:10px; align-content:start; }
    .alert details, .alert pre { min-width:0; max-width:100%; }
    .dockerfile-preview { margin-top:0; max-height:min(48vh,520px); border:1px solid var(--line-soft); border-radius:12px; background:#0b0e11; }
    .execution-image-preview .dockerfile-preview { max-height:min(36vh,360px); }
    .dockerfile-editor { width:100%; min-height:min(48vh,520px); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.45; border:1px solid var(--line); border-radius:12px; color:var(--text); background:#0b0e11; padding:12px 14px; resize:vertical; }
    .alert strong { color:#ffb3b3; }
    .alert.warning { border-color:rgba(255,176,96,.35); background:rgba(255,176,96,.08); }
    .alert.warning strong { color:#ffd4a8; }
    .run-error { margin:0 0 16px; padding:12px 14px; border-radius:12px; align-items:center; }
    .run-error-message { flex:1 1 auto; min-width:0; color:#ffc1c1; font-size:13px; white-space:pre-wrap; word-break:break-word; }
    .form-feedback { margin-top:14px; padding:10px 12px; border-radius:10px; border:1px solid rgba(121,184,255,.25); background:rgba(121,184,255,.06); color:#c9ddf5; font-size:13px; line-height:1.4; }
    .form-feedback.error { border-color:rgba(255,115,115,.42); background:rgba(255,115,115,.08); color:#ffc1c1; }
    .list { display:grid; gap:10px; }
    .item { border:1px solid var(--line-soft); background:var(--surface); border-radius:13px; padding:16px; }
    .item-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .item-title { font-weight:700; font-size:15px; }
    .tags { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
    .tag { border:1px solid var(--line); color:var(--muted); border-radius:999px; font-size:10px; padding:3px 7px; text-transform:uppercase; letter-spacing:.06em; }
    .tag.hitl { color:var(--orange); }
    .tag.afk { color:var(--blue); }
    .resolution { border:0; border-left:2px solid var(--lime-2); padding:8px 12px; margin-top:13px; color:#dce9c3; background:rgba(199,243,107,.035); }
    .resolution summary { color:#dce9c3; font-weight:700; }
    .resolution[open] summary { margin-bottom:6px; }
    .conversation { display:grid; gap:7px; margin-top:13px; }
    .turn { color:var(--muted); padding:8px 11px; background:#0e1115; border-radius:9px; }
    .turn b { color:var(--text); }
    details { border-top:1px solid var(--line-soft); margin-top:13px; padding-top:11px; }
    summary { cursor:pointer; color:var(--muted); }
    .evidence { margin-top:10px; border-radius:10px; background:#090b0d; overflow:hidden; }
    .evidence-head { display:flex; justify-content:space-between; padding:9px 11px; font-size:11px; border-bottom:1px solid var(--line-soft); }
    .pass { color:var(--lime); }
    .fail { color:var(--red); }
    pre { margin:0; padding:13px; overflow:auto; max-height:430px; white-space:pre-wrap; word-break:break-word; color:#bec7d2; font:12px/1.55 "SFMono-Regular",Consolas,monospace; }
    .timeline { position:relative; display:grid; gap:0; }
    .event { position:relative; padding:0 0 18px 28px; }
    .event:before { content:""; position:absolute; left:7px; top:7px; width:7px; height:7px; border-radius:50%; background:var(--lime-2); }
    .event:after { content:""; position:absolute; left:10px; top:17px; bottom:0; width:1px; background:var(--line); }
    .event:last-child:after { display:none; }
    .event-name { font-weight:650; }
    .event-time { color:var(--faint); font-size:11px; margin-top:2px; }
    .activity-timeline { display:grid; gap:12px; }
    .activity-view { display:grid; gap:12px; }
    .activity-view-head { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .activity-view-switch { display:inline-flex; gap:3px; padding:3px; border:1px solid var(--line-soft); border-radius:10px; background:#0e1115; }
    .activity-view-switch .btn { border:0; background:transparent; color:var(--muted); box-shadow:none; }
    .activity-view-switch .btn:hover { transform:none; color:var(--text); }
    .activity-view-switch .btn.primary { background:var(--surface-3); color:var(--text); }
    .activity-view-help { color:var(--faint); font-size:11px; }
    .activity-sequence { display:grid; gap:0; border:1px solid var(--line-soft); border-radius:12px; background:#0e1115; overflow:hidden; }
    .activity-row { position:relative; min-width:0; background:transparent; border-bottom:1px solid var(--line-soft); }
    .activity-row:last-child { border-bottom:0; }
    .activity-row:hover, .activity-row.open { background:var(--surface); }
    .activity-row-main { display:grid; grid-template-columns:28px 66px minmax(84px,110px) minmax(180px,1fr) auto auto 16px; gap:10px; align-items:center; min-width:0; }
    .activity-row-toggle { display:block; width:100%; text-align:left; background:transparent; border:0; color:inherit; padding:10px 12px; cursor:pointer; }
    .activity-row-detail { margin:0 12px 12px 116px; padding:10px 12px; border-left:1px solid var(--line); display:grid; gap:7px; color:var(--muted); font-size:12px; }
    .activity-row-detail .btn { justify-self:start; margin-top:3px; }
    .activity-detail-meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; color:var(--faint); font-size:11px; }
    .activity-seq { font-variant-numeric:tabular-nums; font-size:11px; font-weight:700; color:var(--faint); }
    .activity-time { font-variant-numeric:tabular-nums; font-size:11px; }
    .activity-role { font-size:12px; font-weight:750; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .activity-task { color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .activity-result { color:var(--muted); font-size:11px; font-weight:650; white-space:nowrap; max-width:150px; overflow:hidden; text-overflow:ellipsis; }
    .activity-tokens { font-variant-numeric:tabular-nums; font-size:11px; white-space:nowrap; text-align:right; justify-self:end; }
    .activity-chevron { color:var(--faint); font-size:11px; transition:transform .12s ease; }
    .activity-row.open .activity-chevron { transform:rotate(90deg); }
    .activity-row:before { content:""; position:absolute; left:0; top:8px; bottom:8px; width:2px; border-radius:2px; background:var(--line); }
    .activity-row.role-green:before { background:#8fbf7a; }
    .activity-row.role-review:before { background:#7aa0c4; }
    .activity-row.role-verify:before { background:#c4b07a; }
    .activity-row.role-routing:before { background:#a08fc4; }
    .activity-context { border:1px solid var(--line-soft); background:var(--surface); border-radius:13px; padding:0; min-width:0; overflow:hidden; }
    .activity-context-head { display:block; width:100%; text-align:left; background:transparent; border:0; color:inherit; padding:15px; cursor:pointer; }
    .activity-context-head:hover { background:var(--surface-2); }
    .activity-invocations { border-top:1px solid var(--line-soft); display:grid; gap:0; }
    .activity-invocation { padding:12px 15px; border-top:1px solid var(--line-soft); }
    .activity-invocation:first-child { border-top:0; }
    .activity-invocation-main { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
    .context-badge { display:inline-flex; align-items:center; font-size:10px; font-weight:800; letter-spacing:.06em; border-radius:999px; padding:3px 8px; border:1px solid var(--line); }
    .context-badge.new { color:var(--lime); border-color:rgba(170,220,120,.35); }
    .context-badge.reused { color:#9ecbff; border-color:rgba(120,170,255,.35); }
    .session-role { color:var(--purple); font-weight:750; }
    .session-model { color:var(--faint); font-size:11px; margin-top:3px; overflow-wrap:anywhere; }
    dialog.session-dialog { width:min(1280px,calc(100vw - 30px)); max-width:none; height:min(900px,calc(100vh - 30px)); max-height:none; }
    dialog.session-dialog[open] { display:flex; flex-direction:column; }
    .session-dialog .dialog-head { flex:none; }
    .session-title-wrap { min-width:0; }
    .session-title-wrap h2 { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .session-inspector { flex:1; min-height:0; overflow:auto; padding:20px 22px 28px; }
    .session-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:9px; margin-bottom:18px; }
    .session-stat { border:1px solid var(--line-soft); border-radius:11px; background:#0e1115; padding:10px 12px; min-width:0; }
    .session-stat span { display:block; color:var(--faint); font-size:9px; text-transform:uppercase; letter-spacing:.1em; font-weight:800; }
    .session-stat strong { display:block; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .session-section { border:1px solid var(--line-soft); border-radius:12px; background:#0b0e11; margin-top:10px; padding:0; overflow:hidden; }
    .session-section summary { border:0; padding:12px 14px; background:var(--surface-2); color:var(--text); font-weight:700; }
    .session-section summary small { color:var(--faint); font-weight:500; margin-left:7px; }
    .session-section pre { max-height:55vh; border-top:1px solid var(--line-soft); }
    .session-error { color:#ffb3b3; }
    .related-artifacts { display:flex; flex-wrap:wrap; gap:6px; padding:12px 14px; border-top:1px solid var(--line-soft); }
    .related-artifacts code { color:var(--muted); background:var(--surface-2); border-radius:7px; padding:4px 7px; }
    .artifact-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:9px; }
    .artifact { display:flex; align-items:center; gap:10px; min-width:0; text-align:left; }
    .artifact code { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .knowledge-layout { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:20px; }
    .knowledge-results { display:grid; gap:11px; margin-top:18px; }
    .guidance-layout { display:grid; grid-template-columns:220px minmax(0,1fr); gap:20px; }
    .guidance-roles { display:grid; gap:6px; align-content:start; }
    .guidance-role { width:100%; justify-content:flex-start; text-align:left; }
    .guidance-role.active { border-color:rgba(170,220,120,.45); background:rgba(170,220,120,.08); }
    .guidance-meta { display:grid; gap:8px; margin:14px 0 18px; }
    .guidance-warnings { display:grid; gap:8px; margin-bottom:16px; }
    .guidance-section { margin-top:16px; }
    .guidance-section h2 { margin:0 0 8px; font-size:14px; }
    .guidance-section pre { max-height:min(52vh,520px); border:1px solid var(--line-soft); border-radius:12px; background:#0b0e11; }
    .score { color:var(--lime); font:11px monospace; }
    .empty { text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:var(--radius); padding:50px 20px; }
    dialog { color:var(--text); width:min(680px,calc(100vw - 28px)); border:1px solid var(--line); border-radius:20px; background:#12161b; padding:0; box-shadow:var(--shadow); }
    dialog::backdrop { background:rgba(0,0,0,.68); backdrop-filter:blur(5px); }
    .dialog-head { display:flex; justify-content:space-between; align-items:center; padding:20px 22px; border-bottom:1px solid var(--line-soft); }
    .dialog-head h2 { margin:0; }
    .dialog-body { padding:22px; }
    .dialog-foot { display:flex; justify-content:flex-end; gap:9px; padding:16px 22px; border-top:1px solid var(--line-soft); }
    #settingsDialog { max-height:min(900px,calc(100vh - 30px)); }
    #settingsDialog[open] { display:flex; flex-direction:column; }
    #settingsForm { display:flex; flex-direction:column; flex:1; min-height:0; overflow:hidden; }
    #settingsDialog .dialog-head, #settingsDialog .dialog-foot, #settingsScope { flex:none; }
    #settingsBody { flex:1; min-height:0; overflow:auto; }
    .settings-intro { margin:0 0 20px; color:var(--muted); }
    .settings-group { display:grid; gap:10px; }
    .settings-group + .settings-group { margin-top:22px; }
    .settings-group h3 { margin:0; font-size:12px; color:var(--faint); letter-spacing:.1em; text-transform:uppercase; }
    .setting-row { display:grid; grid-template-columns:minmax(0,1fr) 110px; align-items:center; gap:24px; border:1px solid var(--line-soft); border-radius:12px; padding:14px; }
    .setting-row strong { display:block; margin-bottom:3px; }
    .setting-row input { width:100%; }
    .setting-row textarea { width:100%; resize:vertical; font:12px/1.45 var(--mono); }
    .folder-picker { margin-top:8px; padding:12px; border:1px solid var(--line-soft); border-radius:10px; background:var(--panel); }
    .folder-picker-list { display:grid; gap:6px; margin-top:10px; max-height:220px; overflow:auto; }
    .folder-picker-item { display:flex; justify-content:space-between; align-items:center; gap:12px; }
    .settings-scope { margin:0; padding:12px 22px; border-top:1px solid var(--line-soft); background:rgba(121,184,255,.07); color:var(--muted); font-size:12px; }
    .field { display:grid; gap:7px; margin-bottom:16px; }
    .field label { color:var(--muted); font-size:12px; font-weight:650; }
    .field small { color:var(--faint); }
    .switch-row { display:flex; justify-content:space-between; align-items:center; gap:20px; border:1px solid var(--line-soft); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
    .switch-row input { accent-color:var(--lime); width:18px;height:18px; }
    .columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .toast { position:fixed; top:16px; left:50%; max-width:min(560px, calc(100vw - 32px)); width:max-content; background:#20262d; border:1px solid #39414b; color:var(--text); padding:12px 14px; border-radius:11px; box-shadow:var(--shadow); opacity:0; transform:translate(-50%, -12px); pointer-events:none; transition:.2s; z-index:40; display:flex; align-items:center; gap:12px; }
    .toast.show { opacity:1; transform:translate(-50%, 0); pointer-events:auto; }
    .toast.error { border-color:rgba(255,115,115,.5); background:rgba(32,20,22,.96); }
    .toast-message { flex:1; min-width:0; white-space:pre-wrap; word-break:break-word; }
    .toast-dismiss { flex:none; display:inline-flex; align-items:center; justify-content:center; width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; line-height:1; }
    .toast-dismiss:hover { color:var(--text); background:rgba(255,255,255,.06); }
    .toast-dismiss[hidden] { display:none; }
    .install-item { border:1px solid var(--line-soft); border-radius:10px; padding:12px 14px; margin-bottom:10px; }
    .install-item label { display:flex; gap:10px; align-items:flex-start; cursor:pointer; }
    .install-item .pkg { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
    .sound-toggle { font-size:12px; color:var(--muted); }
    .markdown-view { min-height:300px; max-height:70vh; overflow:auto; background:#090b0d; }
    @media (max-width: 900px) {
      .shell { grid-template-columns:1fr; }
      .sidebar { position:fixed; z-index:20; width:min(320px,88vw); transform:translateX(-102%); transition:.2s; box-shadow:var(--shadow); }
      body.menu-open .sidebar { transform:none; }
      .mobile-menu { display:inline-flex; }
      .topbar { padding:0 18px; }
      .content { padding:25px 18px 60px; }
      .hero { grid-template-columns:1fr; gap:28px; }
      .card.third, .card.half, .card.two-thirds { grid-column:span 12; }
      .knowledge-layout { grid-template-columns:1fr; }
      .guidance-layout { grid-template-columns:1fr; }
      .activity-row-main { grid-template-columns:24px 58px minmax(80px,100px) minmax(140px,1fr) auto 16px; }
      .activity-result { display:none; }
      .activity-row-detail { margin-left:104px; }
    }
    @media (max-width: 600px) {
      .topbar { height:62px; }
      .title-row { display:block; }
      .title-row .badge { margin-top:8px; }
      .answer-row { display:grid; }
      .columns { grid-template-columns:1fr; }
      .content { padding-left:13px; padding-right:13px; }
      .activity-view-head { align-items:flex-start; }
      .activity-view-help { width:100%; }
      .activity-row-main { grid-template-columns:24px minmax(76px,96px) minmax(0,1fr) auto 16px; gap:8px; }
      .activity-time { display:none; }
      .activity-row-detail { margin-left:48px; }
    }
  </style>
</head>
<body>
  <div class="noise"></div>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="mark" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 2 4 6.5v9L12 22l8-6.5v-9L12 2Z" stroke="currentColor" stroke-width="2"/><path d="m8 13 2.4 2.4L16.5 9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div><strong>HexAgent Harness</strong><span>Reflect · Grill · Deliver</span></div>
      </div>
      <div class="sidebar-actions">
        <button class="btn primary new-btn" id="newRunBtn">＋ New run</button>
        <button class="btn icon-btn" id="refreshBtn" title="Refresh">↻</button>
      </div>
      <div class="search-wrap"><input class="search" id="runFilter" placeholder="Filter runs…" aria-label="Filter runs"></div>
      <div class="section-label">Runs</div>
      <div class="run-list" id="runList"></div>
      <div class="sidebar-foot">
        <button class="btn ghost global-link" id="guidanceBtn">▤ &nbsp;Agent guidance</button>
        <button class="btn ghost global-link" id="knowledgeBtn">⌕ &nbsp;Knowledge base</button>
        <div class="connection"><i></i><span>Local connection secured</span></div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="crumb"><button class="btn ghost icon-btn mobile-menu" id="menuBtn">☰</button><span id="projectName">Workspace</span><span>›</span><strong id="crumbTitle">Overview</strong></div>
        <div class="top-actions"><button type="button" class="btn ghost sound-toggle" id="soundMuteBtn" title="Toggle notification sounds">Sound on</button><div class="top-action-slot" id="topActions"></div><button class="btn icon-btn" id="settingsBtn" title="Project settings" aria-label="Project settings">&#9881;</button></div>
      </header>
      <section class="content" id="content"></section>
    </main>
  </div>

  <dialog id="newRunDialog">
    <form id="newRunForm">
      <div class="dialog-head"><h2>Start a new run</h2><button type="button" class="btn ghost icon-btn" data-close="newRunDialog">×</button></div>
      <div class="dialog-body">
        <div class="field"><label for="idea">What do you want to build?</label><textarea id="idea" name="idea" rows="7" required placeholder="Describe the outcome, the user, and any constraints you already know…"></textarea></div>
        <div class="form-feedback" id="newRunFeedback" hidden></div>
        <div class="field"><label for="ideaFile">Or load an idea file</label><input id="ideaFile" type="file" accept=".md,.txt,.json"></div>
        <div class="switch-row"><div><strong>Document RAG</strong><div class="faint">Retrieve project docs into agent work packets (independent of repository intelligence).</div></div><input id="rag" type="checkbox"></div>
        <div class="field" id="baseBranchField" hidden><label for="baseBranch">Start from branch</label><select id="baseBranch"></select><small class="faint">Creates the run worktree from this local branch tip. Does not switch or clean the project folder. PRs target it. Defaults to the project base branch.</small></div>
        <details><summary>Advanced run settings</summary><div style="padding-top:14px">
          <div class="columns"><div class="field"><label for="smallModel">Small model</label><input id="smallModel" type="text"></div><div class="field"><label for="capableModel">Capable model</label><input id="capableModel" type="text"></div></div>
          <div class="switch-row"><div><strong>Use repository intelligence</strong><div class="faint">Prepare and query structural code context through ordered providers for this run.</div></div><input id="repositoryIntelligence" type="checkbox"></div>
          <div class="switch-row"><div><strong>Push branch</strong><div class="faint">Push verified commits to the configured remote.</div></div><input id="push" type="checkbox"></div>
          <div class="switch-row"><div><strong>Open pull request</strong><div class="faint">Uses <code>gh</code>; also enables push.</div></div><input id="openPr" type="checkbox"></div>
        </div></details>
      </div>
      <div class="dialog-foot"><button type="button" class="btn" data-close="newRunDialog">Cancel</button><button class="btn primary" type="submit" data-testid="start-run">Start reflect</button></div>
    </form>
  </dialog>

  <dialog id="artifactDialog">
    <div class="dialog-head"><h2 id="artifactTitle">Artifact</h2><button type="button" class="btn ghost icon-btn" data-close="artifactDialog">×</button></div>
    <div class="markdown-view"><pre id="artifactContent"></pre></div>
    <div class="dialog-foot"><button type="button" class="btn primary" id="copyArtifactBtn">Copy to clipboard</button></div>
  </dialog>
  <dialog id="sessionDialog" class="session-dialog">
    <div class="dialog-head"><div class="session-title-wrap"><h2 id="sessionTitle">Invocation inspector</h2><div class="faint" id="sessionSubtitle"></div></div><button type="button" class="btn ghost icon-btn" data-close="sessionDialog">×</button></div>
    <div class="session-inspector" id="sessionInspector"></div>
  </dialog>
  <dialog id="settingsDialog">
    <form id="settingsForm">
      <div class="dialog-head"><div><h2>Project settings</h2><div class="faint">Defaults for future harness runs</div></div><button type="button" class="btn ghost icon-btn" data-close="settingsDialog">×</button></div>
      <div class="dialog-body" id="settingsBody"></div>
      <div class="settings-scope" id="settingsScope"></div>
      <div class="dialog-foot"><button type="button" class="btn" data-close="settingsDialog">Cancel</button><button class="btn primary" id="saveSettingsBtn" type="submit">Save settings</button></div>
    </form>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"><div class="toast-message" id="toastMessage"></div><button type="button" class="toast-dismiss" id="toastDismiss" aria-label="Dismiss" hidden>×</button></div>

  <script>
${clientScript}
  </script>
</body>
</html>`;
}

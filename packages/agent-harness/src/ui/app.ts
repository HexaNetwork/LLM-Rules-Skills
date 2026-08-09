export function renderDashboard(): string {
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
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
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
    .run-list { overflow:auto; flex:1; padding:0 9px 20px; }
    .run-item { width:100%; text-align:left; border:1px solid transparent; background:transparent; padding:11px 12px; border-radius:11px; cursor:pointer; margin:2px 0; }
    .run-item:hover { background:var(--surface); }
    .run-item.active { background:var(--surface-2); border-color:var(--line); }
    .run-title { display:flex; gap:8px; align-items:center; font-size:13px; font-weight:650; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .run-meta { display:flex; align-items:center; justify-content:space-between; color:var(--faint); font-size:11px; margin-top:6px; }
    .dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--faint); }
    .dot.completed { background:var(--lime); box-shadow:0 0 10px rgba(199,243,107,.4); }
    .dot.blocked { background:var(--red); }
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
    .progress { height:7px; background:#090b0d; border-radius:99px; overflow:hidden; margin-top:13px; }
    .progress > i { display:block; height:100%; background:linear-gradient(90deg,var(--lime-2),var(--lime)); border-radius:99px; }
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
    .alert { border:1px solid rgba(255,115,115,.3); background:rgba(255,115,115,.07); border-radius:var(--radius); padding:18px; display:flex; justify-content:space-between; align-items:flex-start; gap:18px; }
    .alert strong { color:#ffb3b3; }
    .alert.warning { border-color:rgba(255,176,96,.35); background:rgba(255,176,96,.08); }
    .alert.warning strong { color:#ffd4a8; }
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
    .session-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:12px; }
    .session { border:1px solid var(--line-soft); background:var(--surface); border-radius:13px; padding:15px; }
    .session-role { color:var(--purple); font-weight:750; }
    .session-model { color:var(--faint); font-size:11px; margin-top:3px; }
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
    .score { color:var(--lime); font:11px monospace; }
    .empty { text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:var(--radius); padding:50px 20px; }
    .loading { height:2px; position:fixed; top:0; left:0; right:0; z-index:30; overflow:hidden; opacity:0; transition:.2s; }
    .loading.show { opacity:1; }
    .loading:after { content:""; display:block; height:100%; width:32%; background:var(--lime); animation:load 1.1s infinite ease-in-out; }
    @keyframes load { from { transform:translateX(-120%); } to { transform:translateX(430%); } }
    dialog { color:var(--text); width:min(680px,calc(100vw - 28px)); border:1px solid var(--line); border-radius:20px; background:#12161b; padding:0; box-shadow:var(--shadow); }
    dialog::backdrop { background:rgba(0,0,0,.68); backdrop-filter:blur(5px); }
    .dialog-head { display:flex; justify-content:space-between; align-items:center; padding:20px 22px; border-bottom:1px solid var(--line-soft); }
    .dialog-head h2 { margin:0; }
    .dialog-body { padding:22px; }
    .dialog-foot { display:flex; justify-content:flex-end; gap:9px; padding:16px 22px; border-top:1px solid var(--line-soft); }
    .settings-intro { margin:0 0 20px; color:var(--muted); }
    .settings-group { display:grid; gap:10px; }
    .settings-group + .settings-group { margin-top:22px; }
    .settings-group h3 { margin:0; font-size:12px; color:var(--faint); letter-spacing:.1em; text-transform:uppercase; }
    .setting-row { display:grid; grid-template-columns:minmax(0,1fr) 110px; align-items:center; gap:24px; border:1px solid var(--line-soft); border-radius:12px; padding:14px; }
    .setting-row strong { display:block; margin-bottom:3px; }
    .setting-row input { width:100%; }
    .settings-scope { margin-top:18px; padding:12px 14px; border-radius:10px; background:rgba(121,184,255,.07); color:var(--muted); font-size:12px; }
    .field { display:grid; gap:7px; margin-bottom:16px; }
    .field label { color:var(--muted); font-size:12px; font-weight:650; }
    .field small { color:var(--faint); }
    .switch-row { display:flex; justify-content:space-between; align-items:center; gap:20px; border:1px solid var(--line-soft); border-radius:12px; padding:12px 14px; margin-bottom:10px; }
    .switch-row input { accent-color:var(--lime); width:18px;height:18px; }
    .columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .toast { position:fixed; top:16px; left:50%; max-width:min(560px, calc(100vw - 32px)); width:max-content; background:#20262d; border:1px solid #39414b; color:var(--text); padding:12px 14px; border-radius:11px; box-shadow:var(--shadow); opacity:0; transform:translate(-50%, -12px); pointer-events:none; transition:.2s; z-index:40; display:flex; align-items:flex-start; gap:12px; }
    .toast.show { opacity:1; transform:translate(-50%, 0); pointer-events:auto; }
    .toast.error { border-color:rgba(255,115,115,.5); background:rgba(32,20,22,.96); }
    .toast-message { flex:1; min-width:0; white-space:pre-wrap; word-break:break-word; }
    .toast-dismiss { flex:none; width:28px; height:28px; padding:0; border:0; border-radius:8px; background:transparent; color:var(--muted); cursor:pointer; font-size:18px; line-height:1; }
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
    }
    @media (max-width: 600px) {
      .topbar { height:62px; }
      .title-row { display:block; }
      .title-row .badge { margin-top:8px; }
      .answer-row { display:grid; }
      .columns { grid-template-columns:1fr; }
      .content { padding-left:13px; padding-right:13px; }
    }
  </style>
</head>
<body>
  <div class="loading" id="loading"></div>
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
        <div class="switch-row"><div><strong>Test-driven development</strong><div class="faint">Write and verify RED before implementation.</div></div><input id="tdd" type="checkbox"></div>
        <div class="field" id="baseBranchField" hidden><label for="baseBranch">Start from branch</label><select id="baseBranch"></select><small class="faint">Cuts the harness branch from this local branch; PRs target it. Defaults to the project base branch.</small></div>
        <details><summary>Advanced run settings</summary><div style="padding-top:14px">
          <div class="columns"><div class="field"><label for="smallModel">Small model</label><input id="smallModel" type="text"></div><div class="field"><label for="capableModel">Capable model</label><input id="capableModel" type="text"></div></div>
          <div class="switch-row"><div><strong>Use Graphify</strong><div class="faint">Prepare and query structural code context for this run.</div></div><input id="graphify" type="checkbox"></div>
          <div class="switch-row"><div><strong>Push branch</strong><div class="faint">Push verified commits to the configured remote.</div></div><input id="push" type="checkbox"></div>
          <div class="switch-row"><div><strong>Open pull request</strong><div class="faint">Uses <code>gh</code>; also enables push.</div></div><input id="openPr" type="checkbox"></div>
        </div></details>
      </div>
      <div class="dialog-foot"><button type="button" class="btn" data-close="newRunDialog">Cancel</button><button class="btn primary" type="submit">Start reflect</button></div>
    </form>
  </dialog>

  <dialog id="artifactDialog">
    <div class="dialog-head"><h2 id="artifactTitle">Artifact</h2><button type="button" class="btn ghost icon-btn" data-close="artifactDialog">×</button></div>
    <div class="markdown-view"><pre id="artifactContent"></pre></div>
  </dialog>
  <dialog id="sessionDialog" class="session-dialog">
    <div class="dialog-head"><div class="session-title-wrap"><h2 id="sessionTitle">Session inspector</h2><div class="faint" id="sessionSubtitle"></div></div><button type="button" class="btn ghost icon-btn" data-close="sessionDialog">×</button></div>
    <div class="session-inspector" id="sessionInspector"></div>
  </dialog>
  <dialog id="settingsDialog">
    <form id="settingsForm">
      <div class="dialog-head"><div><h2>Project settings</h2><div class="faint">Defaults for future harness runs</div></div><button type="button" class="btn ghost icon-btn" data-close="settingsDialog">×</button></div>
      <div class="dialog-body" id="settingsBody"></div>
      <div class="dialog-foot"><button type="button" class="btn" data-close="settingsDialog">Cancel</button><button class="btn primary" id="saveSettingsBtn" type="submit">Save settings</button></div>
    </form>
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"><div class="toast-message" id="toastMessage"></div><button type="button" class="toast-dismiss" id="toastDismiss" aria-label="Dismiss" hidden>×</button></div>

  <script>
  (function () {
    "use strict";
    var params = new URLSearchParams(location.search);
    var token = params.get("token") || sessionStorage.getItem("harnessToken") || "";
    if (token) sessionStorage.setItem("harnessToken", token);
    if (params.has("token")) history.replaceState(null, "", location.pathname);
    var state = {
      bootstrap: null, runs: [], unreadableRuns: [], selected: null, detail: null, signature: "", scrolls: null,
      tab: "overview", view: "runs", busy: 0, filter: "", answerDrafts: {}, settings: null,
      selectedOptions: {}, parked: {}, clarifications: {}, batchFeedback: "",
      reflectDrafts: {},
      noteText: "", noteAsUnknown: false,
      elapsedTimer: null,
      cancelling: false,
      lastSoundPhase: null,
      installSelections: {},
      // After reflect confirm / grill batch submit, keep the viewport at the top
      // even if a silent poll captures scroll mid-flight.
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
      if (state.pinScrollTop) window.scrollTo(0, 0);
      else if (scrolls.windowY != null) window.scrollTo(scrolls.windowX || 0, scrolls.windowY);
    }
    // Answers (reflect confirm + grill batch) leave the user deep in a tall form.
    // Scroll immediately — do not wait for the follow-on job — and pin restored
    // window coords so a silent poll cannot jump them back down mid-work.
    function scrollMainToTop() {
      state.pinScrollTop = true;
      window.scrollTo(0, 0);
      var content = $("content");
      if (content) content.scrollTop = 0;
      if (state.scrolls) {
        state.scrolls.windowX = 0;
        state.scrolls.windowY = 0;
      } else {
        state.scrolls = { windowX: 0, windowY: 0, nodes: {}, details: {} };
      }
    }
    function hideToast() {
      var node = $("toast");
      node.className = "toast";
      $("toastMessage").textContent = "";
      $("toastDismiss").hidden = true;
      clearTimeout(toast.timer);
    }
    function toast(message, error) {
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
    function loading(on) { state.busy += on ? 1 : -1; state.busy = Math.max(0,state.busy); $("loading").classList.toggle("show", state.busy > 0); }
    async function api(path, options, silent) {
      if (!silent) loading(true);
      try {
        var init = options || {};
        // The server also accepts an HttpOnly session cookie set when the
        // tokenized URL was first opened, so a refresh that lost sessionStorage
        // still authenticates. Send the header only when we actually have one.
        init.credentials = "same-origin";
        init.headers = Object.assign(token ? {"X-Harness-Token":token} : {}, init.headers || {});
        if (init.body && typeof init.body !== "string") {
          init.headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(init.body);
        }
        var response = await fetch(path, init);
        var body = await response.json();
        if (!response.ok) throw new Error(body.error || ("Request failed: " + response.status));
        return body;
      } finally { if (!silent) loading(false); }
    }

    async function bootstrap(keepSelection) {
      try {
        var data = await api("/api/bootstrap");
        state.bootstrap = data; state.runs = data.runs || [];
        state.unreadableRuns = data.unreadableRuns || [];
        $("projectName").textContent = data.project.name;
        $("projectName").title = data.project.root || "";
        if (!keepSelection && !state.selected && state.runs.length) state.selected = state.runs[0].runId;
        if (state.selected && !state.runs.some(function (run) { return run.runId === state.selected; })) state.selected = state.runs[0] ? state.runs[0].runId : null;
        renderSidebar();
        if (state.view === "knowledge") renderKnowledge();
        else if (state.selected) await loadRun(state.selected, false);
        else renderHome();
      } catch (error) {
        toast(error.message, true);
        // A blank shell reads as data loss. Name the failure instead, and say
        // whether the runs on disk are affected (they are not).
        if (/token|401|denied/i.test(String(error.message))) renderAuthError(error.message);
        else renderLoadError("The dashboard could not load this workspace.", error.message);
      }
    }
    async function loadRun(runId, showSpinner, silent, preserveEditor) {
      var sameRun = state.selected === runId;
      state.selected = runId; state.view = "runs";
      if (showSpinner !== false) $("content").innerHTML = '<div class="empty">Loading run…</div>';
      try {
        var since = sameRun && state.signature ? ("?since=" + encodeURIComponent(state.signature)) : "";
        var detail = await api("/api/runs/" + encodeURIComponent(runId) + since, undefined, silent);
        if (detail.unchanged) return;
        state.detail = detail;
        if (detail.state && detail.state.phase === "cancelled") state.cancelling = false;
        renderSidebar();
        // The signature tracks the last *rendered* payload; do not advance it
        // when a poll skips render, or a later poll treats stale DOM as current.
        if (preserveEditor && (editorIsActive() || batchIsActive())) return;
        if (silent) captureScrolls();
        renderRun();
        state.signature = detail.signature || "";
        if (detail.state) maybePlayPhaseSound(detail.state.phase);
        if (silent) restoreScrolls();
      } catch (error) {
        toast(error.message, true);
        playTone('error');
        // A background poll must not blow away a good render; only a foreground
        // load (refresh, run switch) is allowed to replace the content area.
        if (!silent) renderLoadError("This run could not be loaded.", error.message);
      }
    }

    function renderSidebar() {
      var runList = $("runList");
      var scrollTop = runList ? runList.scrollTop : 0;
      var needle = state.filter.toLowerCase();
      var runs = state.runs.filter(function (run) { return !needle || (run.idea + " " + (run.destination || "") + " " + run.runId).toLowerCase().includes(needle); });
      runList.innerHTML = runs.length ? runs.map(function (run) {
        var phase = effectivePhase(run);
        var title = shortTitle(run.idea || run.destination || run.runId, 62);
        var progress = run.taskProgress && run.taskProgress.total ? run.taskProgress.completed + "/" + run.taskProgress.total : phaseLabel(phase);
        return '<button class="run-item ' + (run.runId === state.selected && state.view === "runs" ? "active" : "") + '" data-run="' + attr(run.runId) + '"><div class="run-title"><i class="dot ' + attr(phase) + '"></i><span>' + esc(title) + '</span></div><div class="run-meta"><span>' + esc(progress) + '</span><span>' + esc(ago(run.updatedAt)) + '</span></div></button>';
      }).join("") : '<div class="empty" style="padding:25px 10px">No matching runs</div>';
      // Unreadable runs are listed, not hidden: a run silently missing from this
      // list is indistinguishable from a run the harness lost.
      (state.unreadableRuns || []).forEach(function (failure) {
        runList.innerHTML += '<div class="run-item" style="cursor:default" title="' + attr(failure.error) + '"><div class="run-title"><i class="dot blocked"></i><span>' + esc(shortTitle(failure.runId, 62)) + '</span></div><div class="run-meta"><span>unreadable state.json</span></div></div>';
      });
      runList.scrollTop = scrollTop;
    }

    function renderHome() {
      $("crumbTitle").textContent = "Overview"; $("topActions").innerHTML = "";
      $("content").innerHTML = '<div class="hero"><div><div class="eyebrow">Durable delivery control plane</div><h1>One idea.<br>Every decision.<br>A finished feature.</h1><p class="hero-copy">Reflect the idea, grill until shared understanding, hand clean context between agents, and watch deterministic tests turn red into green—all without losing the thread.</p><p><button class="btn primary" data-open-new>Start your first run →</button></p></div><div class="hero-card"><div class="card-label">The route</div><h2>Clarity before code</h2><div class="route"><div class="route-step"><b>01</b><span>Reflect and confirm the brief</span></div><div class="route-step"><b>02</b><span>Grill the open decisions</span></div><div class="route-step"><b>03</b><span>Plan tracer-bullet tasks</span></div><div class="route-step"><b>04</b><span>Test, implement, review</span></div><div class="route-step"><b>05</b><span>Commit and publish</span></div></div></div></div>';
    }

    function renderRun() {
      if (!state.detail) return;
      var s = state.detail.state;
      var summary = state.runs.find(function (run) { return run.runId === s.runId; }) || {};
      var phase = state.detail.job ? state.detail.job.status : s.phase;
      var title = shortTitle(s.idea, 96);
      $("crumbTitle").textContent = title;
      $("topActions").innerHTML = actionButtons(s, phase);
      var tabs = ["overview","decisions","tasks","sessions","artifacts"];
      var fullIdea = String(s.idea || "");
      var subtitle = title !== fullIdea ? '<div class="subtitle">' + esc(fullIdea) + '</div>' : '';
      var html = '<div class="title-row"><div><div class="eyebrow">Run ' + esc(s.runId.slice(0,8)) + '</div><h1>' + esc(title) + '</h1>' + subtitle + '</div><span class="badge ' + attr(phase) + '"><i class="dot ' + attr(phase) + '"></i>' + esc(phaseLabel(phase)) + '</span></div>';
      html += renderUsageRow(s);
      html += '<nav class="tabs">' + tabs.map(function (tab) { return '<button class="tab ' + (state.tab === tab ? "active" : "") + '" data-tab="' + tab + '">' + tab[0].toUpperCase() + tab.slice(1) + '</button>'; }).join("") + '</nav><div id="tabBody"></div>';
      $("content").innerHTML = html;
      if (state.tab === "overview") renderOverview(s, summary, phase);
      else if (state.tab === "decisions") renderDecisions(s);
      else if (state.tab === "tasks") renderTasks(s);
      else if (state.tab === "sessions") renderSessions();
      else renderArtifacts();
    }

    function actionButtons(s, phase) {
      if (state.cancelling && s.phase !== "cancelled") {
        return '<span class="badge running"><i class="dot running"></i>Cancelling…</span>';
      }
      if (phase === "queued" || phase === "running") return '<span class="badge ' + phase + '"><i class="dot ' + phase + '"></i>' + phase + '</span>';
      var out = "";
      if (s.stoppedAfterTaskAt || (!["completed","cancelled","awaiting_input","blocked"].includes(s.phase))) {
        out += '<button class="btn small primary" data-action="resume">Resume run</button>';
      }
      if (s.phase === "executing" && !s.stoppedAfterTaskAt) {
        out += s.stopAfterTask
          ? '<span class="badge running"><i class="dot running"></i>Stopping after task…</span>'
          : '<button class="btn small" data-action="stop" title="Finish the current task, then halt">Stop after task</button>';
      }
      if (s.phase === "blocked") {
        out += s.blockedRetriable === false
          ? '<button class="btn small primary" data-action="retry" data-force="true">Retry anyway</button>'
          : '<button class="btn small primary" data-action="retry">Retry</button>';
      }
      if (!["completed","cancelled"].includes(s.phase)) out += '<button class="btn small danger" data-action="cancel">Cancel</button>';
      if (s.pullRequestUrl) out += '<a class="btn small primary" target="_blank" rel="noreferrer" href="' + attr(safeUrl(s.pullRequestUrl)) + '">Open PR ↗</a>';
      return out;
    }

    function parseBlockedPaths(failureText) {
      var text = String(failureText || "");
      var match = /(?:Diverging paths|changed unreported paths):\s*(.+)$/im.exec(text);
      if (!match) return [];
      var raw = String(match[1] || "").trim();
      if (!raw || raw.indexOf("(HEAD") === 0) return [];
      return raw.split(/,\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
    }

    // Prefer blockedKind; fall back to message patterns for runs blocked before classification.
    function blockedRemediation(stateOrFailure) {
      var kind = stateOrFailure && typeof stateOrFailure === "object" ? stateOrFailure.blockedKind : undefined;
      var text = String((stateOrFailure && typeof stateOrFailure === "object" ? stateOrFailure.failure : stateOrFailure) || "");
      var byKind = {
        workspace: { title: "A workspace problem is blocking this run",
          hint: "Fix the working tree, missing graph, or unreported paths, then retry the transition." },
        provider: { title: "The agent backend failed transiently",
          hint: "Check credentials and provider health, then retry. Automatic provider retries were already exhausted for this step." },
        config: { title: "The run configuration cannot be resumed as-is",
          hint: "Restore the original configuration, start a new run, or use Retry anyway only if you accept the drift." },
        budget: { title: "A run budget ceiling was reached",
          hint: "Raise the frozen run ceiling below, then retry. Retrying without raising the limit will hit the same block." },
        contract: { title: "The model could not satisfy the required contract",
          hint: "Inspect the failure detail, adjust the task or prompts if needed, then retry." },
        internal: { title: "The harness hit an internal error",
          hint: "This is unlikely to clear on retry. Capture the failure detail and file a bug, or Retry anyway only to unblock." }
      };
      if (/Working tree diverged|Diverging paths/i.test(text)) {
        return {
          id: "tree-divergence",
          title: "The working tree diverged from the harness's last known state",
          hint: "Inspect the unexpected changes. Accept the current tree to continue from here, or restore the tree and retry.",
        };
      }
      if (/not a git repository/i.test(text)) {
        return {
          id: "not-a-git-repo",
          title: "This project is not a git repository",
          hint: "Run git init and make an initial commit in the project folder, or set git.enabled: false in agent-harness.config.yaml, then retry.",
        };
      }
      if (kind && byKind[kind]) return byKind[kind];
      var patterns = [
        { id: "dirty-tree",
          test: /dirty working tree|uncommitted changes|working tree is not clean/i,
          title: "The working tree has uncommitted changes",
          hint: "Commit or stash local changes in the repository, then retry the transition." },
        { test: /CURSOR_API_KEY|agent backend (is )?unavailable|missing.*api.?key/i,
          title: "The agent backend is unavailable",
          hint: "Set the required credential (e.g. CURSOR_API_KEY) in the terminal running the harness, then restart the dashboard and retry." },
        { test: /graphify-out[\\/]graph\.json|graphify graph|missing graph/i,
          title: "The Graphify repository graph is missing",
          hint: "Run Graphify's setup for this repository so graphify-out/graph.json exists, then retry." },
        { test: /run configuration changed|configurationHash|resume with the persisted run config/i,
          title: "The run configuration changed since this run started",
          hint: "Project settings or config changed after this run began. Restore the original configuration, or start a new run to pick up the change." }
      ];
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test.test(text)) return patterns[i];
      }
      return { title: "The current transition could not complete", hint: "Review the failure detail below, resolve the underlying issue, then retry." };
    }

    function fogSummaryLine(unknowns) {
      var resolved = unknowns.filter(function (u) { return u.status === "resolved"; }).length;
      var open = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
      var parked = unknowns.filter(function (u) { return u.status === "parked"; }).length;
      var dropped = unknowns.filter(function (u) { return u.status === "dropped"; }).length;
      return resolved + " resolved · " + open + " open · " + parked + " parked · " + dropped + " dropped";
    }

    function formatCostUsd(usage) {
      if (!usage) return "$0";
      var amount = Number(usage.costUsd || 0);
      var formatted = amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2);
      return (usage.costIsLowerBound ? "≥$" : "$") + formatted;
    }

    function renderUsageRow(s) {
      var usage = s.usage || {};
      var tokens = Number(usage.totalTokens || 0);
      var cached = Number(usage.cacheReadTokens || 0);
      if (!tokens && !(state.detail && state.detail.sessions && state.detail.sessions.length)) {
        return '<div class="usage-row muted">No recorded usage yet</div>';
      }
      var parts = [number(tokens) + " total tokens"];
      if (cached) parts.push(number(cached) + " cached");
      parts.push(formatCostUsd(usage) + (usage.costIsLowerBound ? " (lower bound)" : ""));
      return '<div class="usage-row muted">' + esc(parts.join(" · ")) + '</div>';
    }

    function renderUsageBudgetCard(s) {
      var usage = s.usage || {};
      var ceilings = (state.detail && state.detail.ceilings) || {};
      var maxTokens = Number(ceilings.maxRunTokens || 0);
      var maxCost = Number(ceilings.maxRunCostUsd || 0);
      if (!maxTokens && !maxCost && !usage.totalTokens) return "";
      var tokenPct = maxTokens > 0 ? Math.min(100, Math.round((Number(usage.totalTokens || 0) / maxTokens) * 100)) : 0;
      var costPct = maxCost > 0 ? Math.min(100, Math.round((Number(usage.costUsd || 0) / maxCost) * 100)) : 0;
      var html = '<div class="card"><div class="card-label">Usage</div>';
      html += '<div class="metric">' + number(usage.totalTokens || 0) + '<span class="faint"> tokens</span></div>';
      html += '<div class="muted">' + esc(formatCostUsd(usage)) + (usage.costIsLowerBound ? ' · unpriced models omitted from cost' : '') + '</div>';
      if (maxTokens > 0) {
        html += '<div class="muted" style="margin-top:10px">Tokens vs maxRunTokens (' + number(maxTokens) + ')</div>';
        html += '<div class="progress"><i style="width:' + tokenPct + '%"></i></div>';
      }
      if (maxCost > 0) {
        html += '<div class="muted" style="margin-top:10px">Cost vs maxRunCostUsd ($' + esc(String(maxCost)) + ')</div>';
        html += '<div class="progress"><i style="width:' + costPct + '%"></i></div>';
      }
      html += '</div>';
      return html;
    }

    function renderFogCard(s) {
      var unknowns = s.openUnknowns || [];
      if (!unknowns.length) return "";
      var open = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; });
      var parked = unknowns.filter(function (u) { return u.status === "parked"; });
      var resolved = unknowns.filter(function (u) { return u.status === "resolved"; });
      var openHtml = open.length ? open.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : '<div class="muted">No open unknowns right now.</div>';
      var parkedHtml = parked.length ? '<div class="fog-group-label">Parked</div>' + parked.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-head"><div class="item-title">' + esc(u.title) + '</div><span class="tag">' + esc(u.impact) + '</span></div>' + (u.whyItMatters ? '<div class="muted" style="margin-top:4px">' + esc(u.whyItMatters) + '</div>' : '') + '</div>';
      }).join("") : "";
      var resolvedHtml = resolved.length ? '<details data-details-key="fog-resolved"><summary>' + resolved.length + ' resolved</summary>' + resolved.map(function (u) {
        return '<div class="fog-entry impact-' + attr(u.impact) + '"><div class="item-title">' + esc(u.title) + '</div></div>';
      }).join("") + '</details>' : "";
      return '<div class="card fog-card"><div class="card-label">Open unknowns</div><p class="fog-summary">' + esc(fogSummaryLine(unknowns)) + '</p>' + openHtml + parkedHtml + resolvedHtml + '</div>';
    }

    function renderNoteBox(s) {
      var notes = s.operatorNotes || [];
      var unconsumed = notes.filter(function (n) { return !n.consumedAt; });
      var list = unconsumed.length ? '<div class="note-list">' + unconsumed.map(function (n) {
        return '<div class="note-item"><b>' + (n.title ? esc(n.title) + ': ' : '') + '</b>' + esc(n.text) + ' <span class="faint">· will be sent with your next answer</span></div>';
      }).join("") + '</div>' : "";
      return '<div class="card note-box"><div class="card-label">Add a constraint or note</div><form id="noteForm"><textarea id="noteText" placeholder="Add a constraint, correction, or context the griller should account for…">' + esc(state.noteText) + '</textarea><div class="note-row"><label><input type="checkbox" id="noteAsUnknown"' + (state.noteAsUnknown ? ' checked' : '') + '> Ask me about this</label><button class="btn small primary" type="submit">Add note</button></div></form>' + list + '</div>';
    }

    function renderInstallApproval(installs) {
      var rows = installs.map(function (item) {
        var selected = state.installSelections[item.id];
        if (selected == null) selected = "accept";
        return '<div class="install-item"><div class="item-head"><div><strong>' + esc(item.manager) + '</strong> <span class="pkg">' + esc((item.packages || []).join(" ")) + '</span></div></div><div class="muted" style="margin:6px 0 10px">' + esc(item.reason) + '</div><div style="display:flex;gap:14px;flex-wrap:wrap"><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="accept"' + (selected === "accept" ? " checked" : "") + '> Accept</label><label><input type="radio" name="install-' + attr(item.id) + '" data-install-id="' + attr(item.id) + '" value="deny"' + (selected === "deny" ? " checked" : "") + '> Deny</label></div></div>';
      }).join("");
      return '<div class="card question-card" id="installApprovalCard"><div class="card-label">Approve dependency installs</div><p class="muted">The planner proposed these installs before implementation. Accept or deny each item, then continue.</p>' + rows + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button type="button" class="btn" id="acceptAllInstallsBtn">Accept all</button><button type="button" class="btn" id="denyAllInstallsBtn">Deny all</button><button type="button" class="btn primary" id="submitInstallsBtn">Continue</button></div></div>';
    }

    function renderRunTddControl(s) {
      var locked = ["completed","cancelled"].includes(s.phase);
      var enabled = s.tasks.length ? s.tasks.some(function (t) { return t.tdd; }) : !!(state.bootstrap && state.bootstrap.project && state.bootstrap.project.defaults && state.bootstrap.project.defaults.tdd);
      if (locked) return '<strong>' + (enabled ? "Enabled" : "Disabled") + '</strong>';
      return '<label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" id="runTddToggle"' + (enabled ? " checked" : "") + '> <strong>' + (enabled ? "Enabled" : "Disabled") + '</strong></label><div class="faint" style="margin-top:4px">Applies to the run default and pending tasks</div>';
    }

    function renderInstallLogPanel() {
      var entries = (state.detail && state.detail.installLog) || [];
      if (!entries.length) return '';
      var rows = entries.slice(-20).reverse().map(function (entry) {
        return '<div class="install-item"><div class="item-head"><div class="pkg">' + esc(entry.commandSummary || entry.manager || "install") + '</div><span class="tag">' + esc(entry.source || "agent") + '</span></div><div class="faint" style="margin-top:4px">' + esc(entry.role || "") + (entry.taskId ? " · task " + esc(entry.taskId) : "") + (entry.at ? " · " + esc(ago(entry.at)) : "") + '</div></div>';
      }).join("");
      return '<div class="card"><div class="card-label">Installs observed</div><p class="muted" style="margin:0 0 10px">Passive log of package installs seen during agent work (review only).</p>' + rows + '</div>';
    }

    function batchQuestionAnswered(q) {
      if (state.parked[q.id]) return false; // parked counts separately, not "answered"
      if (state.clarifications[q.id] != null) return false; // clarifying counts separately
      if (state.selectedOptions[q.id] != null) return true;
      var draft = state.answerDrafts[q.id];
      return Boolean(draft && draft.trim().length);
    }

    function batchQuestionHandled(q) {
      return Boolean(state.parked[q.id] || state.clarifications[q.id] != null || batchQuestionAnswered(q));
    }

    function renderBatchQuestion(q, index, total) {
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
      var html = '<div class="card question-card batch-card" id="batchCard" data-batch-id="' + attr(batchId || activeQuestion.id) + '">';
      html += '<div class="card-label">Grill question' + (batch.length > 1 ? "s" : "") + '</div>';
      html += '<div class="keyboard-hint faint">Keys: 1–4 choose an option for the focused question · ↑/↓ move between questions · Esc skips the focused question</div>';
      html += batch.map(function (q, i) { return renderBatchQuestion(q, i, batch.length); }).join("");
      html += '<div class="batch-footer"><span class="muted" id="batchCount">' + answeredCount + ' of ' + batch.length + ' answered</span><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" id="acceptAllBtn">Accept all recommendations</button><button type="button" class="btn primary" id="submitBatchBtn">Submit answers</button></div></div>';
      html += '<div class="form-feedback error" id="batchFeedback"' + (state.batchFeedback ? '' : ' hidden') + '>' + esc(state.batchFeedback) + '</div>';
      html += '</div>';
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
        // Runs created before the structured reflector output existed fall back to the raw editor.
        var draft = state.answerDrafts[q.id];
        if (draft == null && q.draftAnswer) draft = q.draftAnswer;
        if (draft == null) draft = "";
        return '<div class="card question-card reflect-card">' +
          head + '<form id="answerForm" data-question="' + attr(q.id) + '"><div class="reflect-editor"><textarea name="answer" required placeholder="Edit the restatement until it matches what you mean…">' + esc(draft) + '</textarea><button class="btn primary" type="submit">Confirm & continue to grill</button></div></form></div>';
      }
      if (!state.reflectDrafts[q.id]) {
        state.reflectDrafts[q.id] = {
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
      html += '<form id="reflectForm" data-question="' + attr(q.id) + '"><div class="reflect-fields" id="reflectFields">';
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

    function renderOverview(s, summary, phase) {
      stopElapsedTimer();
      var taskTotal = s.tasks.length, taskDone = s.tasks.filter(function (t) { return t.status === "done"; }).length;
      var grillTotal = (s.grillResolutions || []).length;
      var unknowns = s.openUnknowns || [];
      var openUnknownCount = unknowns.filter(function (u) { return u.status === "fog" || u.status === "asked"; }).length;
      var percent = taskTotal ? Math.round(taskDone / taskTotal * 100) : (s.phase === "completed" ? 100 : 0);
      var html = '<div class="grid">';
      var activity = state.detail.activity;
      var activityText = activityLine(activity);
      var thinkingSince = activity && activity.startedAt
        ? activity.startedAt
        : (state.detail.job ? (state.detail.job.startedAt || state.detail.job.queuedAt) : null);
      if (state.cancelling && s.phase !== "cancelled") {
        html += '<div class="thinking-strip" role="status" aria-live="polite"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="thinking-copy"><strong>Cancelling…</strong><span>Waiting for the current step to stop</span></div></div>';
      } else if (phase === "queued" || phase === "running") {
        var jobAction = state.detail.job && state.detail.job.action;
        var jobDetail = state.detail.job && state.detail.job.detail;
        var thinkingDetail = phase === "queued"
          ? "Waiting for the current transition to start"
          : jobAction === "index knowledge and reflect"
            ? "Indexing knowledge before the reflector starts"
            : "An agent or deterministic command is working";
        if (jobDetail) thinkingDetail = jobDetail;
        if (activityText) thinkingDetail = activityText;
        if (s.phase === "grilling" && unknowns.length && !activityText) thinkingDetail += " · " + openUnknownCount + " open unknown(s) remain";
        html += '<div class="thinking-strip" role="status" aria-live="polite"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><div class="thinking-copy"><strong>Thinking…</strong><span>' + esc(thinkingDetail) + '</span>' + (thinkingSince && !activityText ? '<span id="thinkingElapsed">' + esc(elapsed(thinkingSince)) + '</span>' : '') + '</div></div>';
      }
      if (s.phase === "awaiting_input") {
        var pendingInstalls = (s.proposedInstalls || []).filter(function (item) { return !item.decision; });
        if (pendingInstalls.length) {
          html += renderInstallApproval(pendingInstalls);
        } else {
          var q = s.questions.find(function (item) { return item.id === s.activeQuestionId; });
          if (q) {
            if (q.purpose === "reflect") html += renderReflectEditor(q, s);
            else html += renderQuestionBatch(s, q);
          }
        }
      }
      if (s.stoppedAfterTaskAt) {
        html += '<div class="card"><div class="alert warning"><div><strong>Stopped after task</strong><div class="muted" style="margin-top:5px">The current task finished and the next frontier task was not started. Resume continues from here. Cancel remains available to abort immediately.</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      } else if (s.yieldedAt) {
        html += '<div class="card"><div class="alert warning"><div><strong>Run yielded to its step budget</strong><div class="muted" style="margin-top:5px">This run hit its maxStepsPerRun limit mid-transition and stopped to avoid runaway work, not because it is waiting on you. Resume continues it from exactly where it left off.</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      } else if (!state.detail.job && !["completed","cancelled","awaiting_input","blocked"].includes(s.phase) && !s.stopAfterTask) {
        html += '<div class="card"><div class="alert"><div><strong>This run is paused</strong><div class="muted" style="margin-top:5px">Dashboard work does not continue automatically after a restart. Resume queues the next transition and refreshes the document index first.</div></div><button class="btn primary" data-action="resume">Resume run</button></div></div>';
      }
      if (s.phase === "blocked") {
        var remediation = blockedRemediation(s);
        var failureText = String(s.failure || "");
        var isTreeDivergence = /Working tree diverged|Diverging paths/i.test(failureText);
        var isDirtyTree = !isTreeDivergence && (remediation.id === "dirty-tree" || /dirty working tree|uncommitted changes|working tree is not clean/i.test(failureText));
        var failureDetail = (isDirtyTree || isTreeDivergence)
          ? '<pre style="margin-top:8px">' + esc(s.failure || "") + '</pre>'
          : '<details><summary>Raw failure detail</summary><pre>' + esc(s.failure || "The current transition could not complete.") + '</pre></details>';
        var commitControls = "";
        if (isDirtyTree) {
          var settingsValues = (state.bootstrap && state.bootstrap.project && state.bootstrap.project.settings && state.bootstrap.project.settings.values) || {};
          var defaultOrder = settingsValues["git.preflightCommitOrder"] === "commit-then-branch" ? "commit-then-branch" : "branch-then-commit";
          var otherOrder = defaultOrder === "commit-then-branch" ? "branch-then-commit" : "commit-then-branch";
          var gitInfo = state.detail.git;
          var currentBranch = gitInfo ? gitInfo.currentBranch : null;
          var baseBranch = gitInfo ? gitInfo.baseBranch : null;
          var onBaseBranch = !!(currentBranch && baseBranch && currentBranch === baseBranch);
          var orderLabel = function (order) {
            if (order === "commit-then-branch") return currentBranch ? "Commit onto " + currentBranch : "Commit onto the current branch";
            return "Commit onto the run branch";
          };
          var defaultBtnClass = defaultOrder === "commit-then-branch" && onBaseBranch ? "btn danger" : "btn primary";
          var otherBtnClass = otherOrder === "commit-then-branch" && onBaseBranch ? "btn danger" : "btn";
          var cautionNote = onBaseBranch
            ? '<div class="alert warning" style="margin-top:10px;padding:10px 12px"><div><strong>Heads up</strong><div class="muted" style="margin-top:3px">' + esc(currentBranch) + ' is your base branch. Committing onto the current branch lands these changes directly on it.</div></div></div>'
            : "";
          commitControls = '<div class="preflight-commit-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="' + defaultBtnClass + '" data-action="commit_preflight" data-preflight-order="' + attr(defaultOrder) + '">' + esc(orderLabel(defaultOrder)) + ' and retry</button>' +
            '<button class="' + otherBtnClass + '" data-action="commit_preflight" data-preflight-order="' + attr(otherOrder) + '">' + esc(orderLabel(otherOrder)) + ' and retry</button>' +
            '</div>' + cautionNote;
        }
        var acceptTreeControls = "";
        if (isTreeDivergence) {
          acceptTreeControls = '<div class="accept-tree-actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn primary" data-action="accept_tree">Accept current tree and continue</button>' +
            '</div>';
        }
        var ignoreArtifactControls = "";
        var divergingPaths = parseBlockedPaths(failureText);
        var canEditSettings = !!(state.bootstrap && state.bootstrap.project && state.bootstrap.project.settings && state.bootstrap.project.settings.editable);
        if (divergingPaths.length > 0 && (isTreeDivergence || /changed unreported paths/i.test(failureText)) && canEditSettings) {
          ignoreArtifactControls =
            '<div class="ignore-artifacts" style="margin-top:12px">' +
            '<div class="muted" style="margin-bottom:6px"><strong>Ignore these paths</strong> — add build/generated folders to project config (not .gitignore), then accept the tree and continue.</div>' +
            '<div style="display:grid;gap:6px">' +
            divergingPaths.map(function (filePath) {
              return '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap">' +
                '<code style="font-size:12px;word-break:break-all">' + esc(filePath) + '</code>' +
                '<button class="btn small" data-action="ignore_artifacts" data-ignore-path="' + attr(filePath) + '">Ignore</button>' +
                '</div>';
            }).join('') +
            '<div style="margin-top:4px"><button class="btn" data-action="ignore_artifacts" data-ignore-paths="' + attr(JSON.stringify(divergingPaths)) + '">Ignore all listed paths</button></div>' +
            '</div></div>';
        }
        var retryControls = "";
        if (s.blockedKind === "budget") {
          var ceilings = (state.detail && state.detail.ceilings) || {};
          var currentTokens = ceilings.maxRunTokens || 0;
          var currentCost = ceilings.maxRunCostUsd || 0;
          var suggestedTokens = Math.max(currentTokens * 2 || 0, Math.ceil((s.usage && s.usage.totalTokens || 0) * 1.5) || 0, 1);
          var suggestedCost = Math.max(currentCost * 2 || 0, Number(((s.usage && s.usage.costUsd || 0) * 1.5).toFixed(4)) || 0);
          retryControls =
            '<div class="budget-raise" style="margin-top:12px;display:grid;gap:8px">' +
            '<div class="muted">Raise the frozen run ceiling, then force-retry. Project config alone will not unblock this run.</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end">' +
            '<label style="display:grid;gap:4px"><span class="faint">maxRunTokens</span><input id="raiseMaxRunTokens" type="number" min="0" step="1" value="' + attr(String(suggestedTokens)) + '" style="width:140px"></label>' +
            '<label style="display:grid;gap:4px"><span class="faint">maxRunCostUsd</span><input id="raiseMaxRunCostUsd" type="number" min="0" step="0.01" value="' + attr(String(suggestedCost || currentCost || 0)) + '" style="width:140px"></label>' +
            '<button class="btn primary" data-action="raise_budget_retry">Raise ceiling and retry</button>' +
            '</div></div>';
        } else if (s.blockedRetriable === false) {
          retryControls = '<div class="alert warning" style="margin-top:10px;padding:10px 12px"><div><strong>Not retriable</strong><div class="muted" style="margin-top:3px">This block is classified as <code>' + esc(s.blockedKind || "unknown") + '</code>. Retrying without fixing the cause is unlikely to help.</div></div></div><button class="btn danger" data-action="retry" data-force="true">Retry anyway</button>';
        } else if (!isTreeDivergence) {
          retryControls = '<button class="btn danger" data-action="retry">Retry transition</button>';
        }
        html += '<div class="card"><div class="alert"><div><strong>' + esc(remediation.title) + '</strong><div class="muted" style="margin-top:5px">' + esc(remediation.hint) + '</div><div class="faint" style="margin-top:6px">Stopped from: ' + esc(s.blockedFrom || "unknown") + (s.blockedKind ? ' · kind: ' + esc(s.blockedKind) : '') + '</div>' + failureDetail + commitControls + acceptTreeControls + ignoreArtifactControls + '</div>' + retryControls + '</div></div>';
      }
      if (["grilling","awaiting_input","planning"].includes(s.phase)) {
        html += renderFogCard(s);
      }
      if (["grilling","awaiting_input"].includes(s.phase)) {
        html += renderNoteBox(s);
      }
      var repoRoot = (state.bootstrap && state.bootstrap.project && state.bootstrap.project.root) || "";
      html += '<div class="card third"><div class="card-label">Build progress</div><div class="metric">' + taskDone + '<span class="faint"> / ' + taskTotal + '</span></div><div class="muted">implementation tasks done</div><div class="progress"><i style="width:' + percent + '%"></i></div><div class="muted" style="margin-top:12px">Repository</div><div style="margin-top:4px"><code title="' + attr(repoRoot) + '" style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(repoRoot || "Unknown") + '</code></div></div>';
      html += '<div class="card third"><div class="card-label">Grill resolutions</div><div class="metric">' + grillTotal + '</div><div class="muted">' + (unknowns.length ? (openUnknownCount + ' open unknown(s) · ' + unknowns.length + ' in register') : 'decisions locked in') + '</div></div>';
      var episode = s.grillEpisode;
      var usage = s.usage || {};
      var tokenTotals = { tokens: Number(usage.totalTokens || 0), cached: Number(usage.cacheReadTokens || 0) };
      if (!tokenTotals.tokens) {
        tokenTotals = state.detail.sessions.reduce(function (acc, session) { var sessionUsage = session.usage || {}; var total = sessionUsage.totalTokens; if (total == null && (sessionUsage.inputTokens != null || sessionUsage.outputTokens != null)) total = Number(sessionUsage.inputTokens || 0) + Number(sessionUsage.outputTokens || 0); acc.tokens += Number(total || 0); acc.cached += Number(sessionUsage.cacheReadTokens || 0); return acc; }, { tokens: 0, cached: 0 });
      }
      var episodeDetail = episode ? ('grill episode ' + episode.number + ' · ' + episode.questionsAnswered + ' answered' + (episode.closedAt ? ' · closed' : ' · active')) : 'bounded grill episodes';
      if (tokenTotals.tokens) episodeDetail += ' · ' + number(tokenTotals.tokens) + ' recorded tokens' + (tokenTotals.cached ? ' (' + number(tokenTotals.cached) + ' served from cache)' : '');
      html += '<div class="card third"><div class="card-label">Sessions</div><div class="metric">' + state.detail.sessions.length + '</div><div class="muted">' + esc(episodeDetail) + '</div><div class="faint" style="margin-top:12px">Updated ' + esc(ago(s.updatedAt)) + '</div></div>';
      html += renderUsageBudgetCard(s);
      var brief = s.reflectBrief;
      var briefTitle = brief && brief.confirmed ? "Confirmed brief" : (brief ? "Draft brief" : "Feature brief");
      var briefBody = brief ? (brief.confirmed || brief.draft) : "The reflector will restate the idea for your confirmation before grilling begins.";
      html += '<div class="card two-thirds"><div class="card-label">' + esc(briefTitle) + '</div><pre class="brief-body" data-scroll-key="brief">' + esc(briefBody) + '</pre></div>';
      html += '<div class="card third"><div class="card-label">Delivery</div><div class="muted">Branch</div><div style="margin:4px 0 13px"><code>' + esc(s.branchName || "Not created yet") + '</code></div><div class="muted">TDD</div><div style="margin-top:4px">' + renderRunTddControl(s) + '</div></div>';
      html += renderInstallLogPanel();
      html += '<div class="card"><div class="card-label">Recent activity</div><div class="timeline">' + (state.detail.events.slice(-10).reverse().map(renderEvent).join("") || '<div class="muted">No events yet.</div>') + '</div></div>';
      html += '</div>';
      $("tabBody").innerHTML = html;
      autoGrowReflectFields();
      if (thinkingSince && $("thinkingElapsed")) startElapsedTimer(thinkingSince);
    }
    function renderEvent(event) { return '<div class="event"><div class="event-name">' + esc(event.type) + '</div><div class="event-time">' + esc(date(event.at)) + '</div></div>'; }

    function renderDecisions(s) {
      var resolutions = s.grillResolutions || [];
      var html = resolutions.length ? '<div class="list">' + resolutions.map(function (item) {
        return '<article class="item"><div class="item-head"><div><div class="item-title">' + esc(item.summary) + '</div><div class="muted" style="margin-top:5px">' + esc(item.question) + '</div></div><span class="badge completed">resolved</span></div><div class="conversation"><div class="turn"><b>Answer:</b> ' + esc(item.answer) + '</div></div></article>';
      }).join("") + '</div>' : '<div class="empty">No grill resolutions yet. Confirm the reflect brief to begin grilling.</div>';
      $("tabBody").innerHTML = html;
    }

    function renderTasks(s) {
      var html = s.tasks.length ? '<div class="list">' + s.tasks.map(function (task, index) {
        var taskKey = task.id || ("task-" + index);
        var criteria = '<ul>' + task.acceptanceCriteria.map(function (criterion) { return '<li>' + esc(criterion) + '</li>'; }).join("") + '</ul>';
        var evidence = task.evidence.length ? '<details data-details-key="' + attr(taskKey + "-evidence") + '"><summary>' + task.evidence.length + ' command result(s)</summary>' + task.evidence.map(function (item, evidenceIndex) { var output = [item.stderr,item.stdout].filter(Boolean).join(String.fromCharCode(10)); return '<div class="evidence"><div class="evidence-head"><span>' + esc(item.purpose) + ' · <code>' + esc(item.command) + '</code></span><strong class="' + (item.passed ? "pass" : "fail") + '">' + (item.passed ? "PASS" : "FAIL") + ' / ' + item.exitCode + '</strong></div>' + (output ? '<pre data-scroll-key="' + attr(taskKey + "-evidence-" + evidenceIndex) + '">' + esc(output.slice(-8000)) + '</pre>' : '') + '</div>'; }).join("") + '</details>' : '';
        var canToggle = task.status === "pending" && task.step === "pending" && !["completed","cancelled"].includes(s.phase);
        var tddControl = canToggle
          ? '<button type="button" class="tag" data-action="set_tdd" data-task-id="' + attr(task.id) + '" data-tdd="' + (task.tdd ? "false" : "true") + '" title="Toggle TDD for this pending task">TDD ' + (task.tdd ? "on" : "off") + ' · click</button>'
          : '<span class="tag" title="TDD is locked once the task starts">TDD ' + (task.tdd ? "on" : "off") + '</span>';
        return '<article class="item"><div class="item-head"><div><div class="card-label">Task ' + String(index + 1).padStart(2,"0") + '</div><div class="item-title">' + esc(task.title) + '</div><div class="muted" style="margin-top:5px">' + esc(task.description) + '</div></div><span class="badge ' + attr(task.status === "done" ? "completed" : task.status) + '">' + esc(task.status + " · " + task.step) + '</span></div><div class="tags">' + tddControl + (task.blockedBy.length ? '<span class="tag">after ' + esc(task.blockedBy.join(", ")) + '</span>' : '') + (task.commitSha ? '<span class="tag">' + esc(task.commitSha.slice(0,8)) + '</span>' : '') + '</div><details data-details-key="' + attr(taskKey + "-criteria") + '"><summary>Acceptance criteria</summary>' + criteria + '</details>' + evidence + (task.failure ? '<div class="resolution" style="border-color:var(--red)">' + esc(task.failure) + '</div>' : '') + '</article>';
      }).join("") + '</div>' : '<div class="empty">Implementation tasks appear after grilling reaches shared understanding.</div>';
      $("tabBody").innerHTML = html;
    }

    function renderSessions() {
      var sessions = state.detail.sessions;
      $("tabBody").innerHTML = sessions.length ? '<div class="session-grid">' + sessions.map(function (session) {
        var usage = session.usage && (session.usage.inputTokens || session.usage.outputTokens) ? (String(session.usage.inputTokens || 0) + ' in' + (session.usage.cacheReadTokens ? ' (' + number(session.usage.cacheReadTokens) + ' cached)' : '') + ' · ' + String(session.usage.outputTokens || 0) + ' out') : 'usage unavailable';
        var summary = session.handoff && session.handoff.summary ? session.handoff.summary : (session.error || 'Session record');
        var contextMode = session.providerSessionReused === true ? ' · continued' : (session.providerSessionReused === false ? ' · fresh' : '');
        return '<article class="session"><div class="item-head"><span class="session-role">' + esc(session.role) + '</span><span class="badge ' + attr(session.status === "completed" ? "completed" : session.status) + '">' + esc(session.status) + '</span></div><div class="session-model">' + esc(session.model) + ' · ' + esc(usage) + esc(contextMode) + '</div><p class="muted">' + esc(summary) + '</p><button class="btn small" data-session="' + attr(session.path) + '">Inspect session</button></article>';
      }).join("") + '</div>' : '<div class="empty">No model sessions have launched yet.</div>';
    }

    function renderArtifacts() {
      var artifacts = state.detail.artifacts;
      $("tabBody").innerHTML = artifacts.length ? '<div class="artifact-list">' + artifacts.map(function (file) { return '<button class="btn artifact" data-artifact="' + attr(file) + '"><span>◇</span><code>' + esc(file) + '</code></button>'; }).join("") + '</div>' : '<div class="empty">No artifacts yet.</div>';
    }

    function renderKnowledge() {
      state.view = "knowledge"; state.selected = null; state.detail = null; renderSidebar();
      $("crumbTitle").textContent = "Knowledge base";
      $("topActions").innerHTML = '<button class="btn small" id="refreshKnowledge">Refresh sources</button>';
      $("content").innerHTML = '<div class="title-row"><div><div class="eyebrow">RAG inspector</div><h1>Knowledge base</h1><div class="subtitle">Manually test the same lexical, semantic, and repository context retrieval used in agent work packets.</div></div></div><div class="card" id="knowledgeStatus"><div class="muted">Loading retrieval configuration…</div></div><div class="knowledge-layout"><div class="card"><form id="knowledgeSearch"><div class="field"><label for="knowledgeQuery">Manual RAG query</label><div style="display:flex;gap:8px"><input id="knowledgeQuery" type="text" required placeholder="e.g. where is retry logic configured?"><button class="btn primary">Search</button></div></div></form><div class="knowledge-results" id="knowledgeResults"><div class="empty">Enter a query to inspect retrieved chunks.</div></div></div><aside class="card"><div class="card-label">Add a source</div><p class="muted">Index a text file already inside this repository.</p><form id="knowledgeAdd"><div class="field"><label for="knowledgePath">Repository-relative path</label><input id="knowledgePath" type="text" required placeholder="docs/api.md"></div><button class="btn" style="width:100%">Add document</button></form><hr style="border:0;border-top:1px solid var(--line-soft);margin:20px 0"><div class="card-label">Storage</div><p class="faint"><code>.agent-harness/knowledge/</code><br>Lexical chunks and optional vectors stay local; Graphify reads <code>graphify-out/graph.json</code>.</p></aside></div>';
      void loadKnowledgeStatus();
    }

    async function loadKnowledgeStatus() {
      try {
        var status = await api('/api/knowledge/status');
        var semantic = status.semantic || {};
        var semanticText = semantic.enabled
          ? 'Enabled · ' + String(semantic.provider) + ' · ' + String(semantic.model)
          : 'Disabled · lexical retrieval remains active';
        $("knowledgeStatus").innerHTML = '<div class="item-head"><div><div class="card-label">Retrieval configuration</div><div class="muted" style="margin-top:6px"><strong>Lexical:</strong> enabled &nbsp; <strong>Semantic:</strong> ' + esc(semanticText) + ' &nbsp; <strong>Graphify:</strong> ' + (status.graphify && status.graphify.enabled ? 'enabled' : 'disabled') + '</div></div><span class="tag">' + esc((status.sources || []).length + ' source(s)') + '</span></div>';
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

    function renderSettings(settings) {
      var definitions = Array.isArray(settings.definitions) ? settings.definitions : [];
      var values = settings.values || {};
      var categories = [];
      definitions.forEach(function (definition) {
        var category = definition.category || "General";
        var group = categories.find(function (candidate) { return candidate.name === category; });
        if (!group) { group = { name:category, definitions:[] }; categories.push(group); }
        group.definitions.push(definition);
      });
      var fields = categories.map(function (category) {
        var rows = category.definitions.map(function (definition) {
          var id = "setting-" + String(definition.key).replace(/[^a-z0-9_-]/gi,"-");
          var input;
          if (definition.type === "boolean") {
            input = '<input id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="boolean" type="checkbox"' + (values[definition.key] ? ' checked' : '') + (settings.editable ? '' : ' disabled') + '>';
          } else if (definition.type === "enum") {
            var options = Array.isArray(definition.options) ? definition.options : [];
            var optionHtml = options.map(function (option) {
              return '<option value="' + attr(option.value) + '"' + (values[definition.key] === option.value ? ' selected' : '') + '>' + esc(option.label) + '</option>';
            }).join('');
            input = '<select id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="enum"' + (settings.editable ? '' : ' disabled') + '>' + optionHtml + '</select>';
          } else {
            input = '<input id="' + attr(id) + '" data-setting-key="' + attr(definition.key) + '" data-setting-type="integer" type="number" value="' + attr(values[definition.key]) + '" min="' + attr(definition.minimum) + '" max="' + attr(definition.maximum) + '" step="1" required' + (settings.editable ? '' : ' disabled') + '>';
          }
          return '<label class="setting-row" for="' + attr(id) + '"><span><strong>' + esc(definition.label) + '</strong><span class="faint">' + esc(definition.description) + '</span></span>' + input + '</label>';
        }).join('');
        return '<section class="settings-group"><h3>' + esc(category.name) + '</h3>' + rows + '</section>';
      }).join('');
      var persistence = settings.editable
        ? 'Most changes apply to new runs. Ignored build artifacts are live project policy and also apply to in-progress runs.'
        : 'This dashboard was started without a config file path, so settings are read-only.';
      var grillLayout = getGrillOptionsLayout();
      var displayGroup = '<section class="settings-group"><h3>Display</h3>' +
        '<label class="setting-row" for="grill-options-layout"><span><strong>Grill options layout</strong><span class="faint">Arrange recommended options as columns or stacked rows</span></span>' +
        '<select id="grill-options-layout">' +
          '<option value="columns"' + (grillLayout === "columns" ? ' selected' : '') + '>Columns</option>' +
          '<option value="rows"' + (grillLayout === "rows" ? ' selected' : '') + '>Rows</option>' +
        '</select></label></section>';
      var artifactPatterns = Array.isArray(values["git.ignoredArtifactPatterns"]) ? values["git.ignoredArtifactPatterns"] : [];
      var artifactRows = artifactPatterns.length
        ? artifactPatterns.map(function (pattern, index) {
            return '<div class="setting-row" style="align-items:center"><code style="font-size:12px;word-break:break-all">' + esc(pattern) + '</code>' +
              (settings.editable
                ? '<button type="button" class="btn small danger" data-remove-artifact-index="' + attr(String(index)) + '">Remove</button>'
                : '') +
              '</div>';
          }).join('')
        : '<div class="muted">No ignored artifact patterns yet.</div>';
      var artifactGroup = '<section class="settings-group" id="ignoredArtifactsGroup"><h3>Ignored build artifacts</h3>' +
        '<p class="faint" style="margin:0 0 8px">Harness-local globs skipped for dirty-tree and unreported-path checks. Does not edit .gitignore.</p>' +
        '<div id="ignoredArtifactsList" style="display:grid;gap:8px">' + artifactRows + '</div></section>';
      $("settingsBody").innerHTML = '<p class="settings-intro">Tune token use and workflow behavior from one place. More settings can be added to this menu as the harness grows.</p>' + fields + artifactGroup + displayGroup + '<div class="settings-scope">' + esc(persistence) + '</div>';
      $("saveSettingsBtn").disabled = !settings.editable;
      var layoutSelect = $("grill-options-layout");
      if (layoutSelect) {
        layoutSelect.addEventListener("change", function () {
          setGrillOptionsLayout(layoutSelect.value);
          applyGrillOptionsLayout();
        });
      }
    }

    async function openSettings() {
      try {
        var data = await api('/api/settings');
        state.settings = data.settings;
        renderSettings(state.settings);
        $("settingsDialog").showModal();
      } catch (error) { toast(error.message,true); }
    }

    async function removeIgnoredArtifact(index) {
      if (!state.settings || !state.settings.editable) return;
      var current = Array.isArray(state.settings.values["git.ignoredArtifactPatterns"])
        ? state.settings.values["git.ignoredArtifactPatterns"].slice()
        : [];
      if (index < 0 || index >= current.length) return;
      current.splice(index, 1);
      try {
        var values = collectSettingsValues();
        values["git.ignoredArtifactPatterns"] = current;
        var data = await api('/api/settings', { method: 'PUT', body: { values: values } });
        state.settings = data.settings;
        if (state.bootstrap) state.bootstrap.project.settings = data.settings;
        renderSettings(state.settings);
        toast('Ignored artifact pattern removed');
      } catch (error) { toast(error.message, true); }
    }

    function collectSettingsValues() {
      var values = {};
      $("settingsForm").querySelectorAll('[data-setting-key]').forEach(function (input) {
        var type = input.dataset.settingType;
        values[input.dataset.settingKey] = type === 'integer' ? Number(input.value) : (type === 'boolean' ? input.checked : input.value);
      });
      var patterns = (state.settings && state.settings.values && state.settings.values["git.ignoredArtifactPatterns"]) || [];
      values["git.ignoredArtifactPatterns"] = Array.isArray(patterns) ? patterns.slice() : [];
      return values;
    }

    async function waitForJob(runId) {
      var deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
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
      return { ok: false, error: 'Timed out waiting for the action to finish' };
    }

    async function runAction(action, extra) {
      if (!state.selected) return;
      try {
        var response = await api('/api/runs/' + encodeURIComponent(state.selected) + '/actions', {method:'POST',body:Object.assign({action:action},extra||{})});
        if (action === 'answer' && extra && extra.questionId) delete state.answerDrafts[extra.questionId];
        if (action === 'cancel') {
          state.cancelling = !(response && response.state && response.state.phase === 'cancelled');
          toast(state.cancelling ? 'Cancelling…' : 'Run cancelled');
          await bootstrap(true);
          return;
        }
        if (action === 'stop') {
          toast(response && response.state && response.state.stoppedAfterTaskAt ? 'Stopped after task' : 'Will stop after the current task');
          await bootstrap(true);
          return;
        }
        // Reflect confirm / grill batch can queue a long agent job; scroll before
        // waiting so the thinking strip at the top is visible while it works.
        if (action === 'answer') scrollMainToTop();
        if (action === 'resolve_installs') scrollMainToTop();
        loading(true);
        var result;
        try { result = await waitForJob(state.selected); }
        finally { loading(false); }
        await bootstrap(true);
        if (action === 'answer') scrollMainToTop();
        if (action === 'resolve_installs') scrollMainToTop();
        state.pinScrollTop = false;
        if (!result.ok) {
          playTone('error');
          toast(result.error, true);
          return;
        }
        var doneMsg = action === 'answer' ? 'Answer recorded'
          : (action === 'ignore_artifacts' ? 'Ignored artifacts and continued'
          : (action === 'resolve_installs' ? 'Install decisions applied'
          : (action === 'set_tdd' ? 'TDD updated' : 'Action completed')));
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

    async function openSession(file) {
      try {
        var data = await api('/api/runs/' + encodeURIComponent(state.selected) + '/session?path=' + encodeURIComponent(file));
        var session = data.session || {}, usage = session.usage || {};
        var started = session.startedAt ? new Date(session.startedAt) : null;
        var ended = session.endedAt ? new Date(session.endedAt) : null;
        var duration = started && ended ? Math.max(0,ended.getTime()-started.getTime()) : null;
        var prompt = data.inputPrompt || "Input unavailable for this historical session.";
        var meta = '';
        meta += sessionStat('Status', session.status || 'unknown');
        meta += sessionStat('Model', session.model || 'unknown');
        meta += sessionStat('Attempt', String(Number(session.attempt || 0) + 1));
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
        meta += sessionStat('Provider session', session.providerSessionId || '—');
        meta += sessionStat('Provider run', session.providerRunId || '—');
        meta += sessionStat('Context mode', session.providerSessionReused === true ? 'continued episode' : (session.providerSessionReused === false ? 'fresh provider context' : 'unknown'));
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
        $("sessionTitle").textContent = String(session.role || 'Session') + ' session';
        $("sessionSubtitle").textContent = String(session.sessionId || file);
        $("sessionInspector").innerHTML = html;
        $("sessionDialog").showModal();
      } catch (error) { toast(error.message,true); }
    }

    // Surgical DOM updates so answering a question never triggers a full renderRun().
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

    document.addEventListener('click', function (event) {
      var target = event.target.closest('button,a'); if (!target) return;
      if (target.dataset.run) { document.body.classList.remove('menu-open'); loadRun(target.dataset.run); }
      if (target.dataset.tab) { state.tab = target.dataset.tab; renderRun(); }
      if (target.dataset.action) {
        if (target.dataset.action === 'cancel' && !confirm('Cancel this run?')) return;
        if (target.dataset.action === 'stop' && !confirm('Finish the current task, then stop before starting the next one?')) return;
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
      if (target.id === 'soundMuteBtn') {
        setSoundsMuted(!soundsMuted());
      }
      if (target.dataset.artifact) openArtifact(target.dataset.artifact);
      if (target.dataset.session) openSession(target.dataset.session);
      if (target.id === 'settingsBtn') openSettings();
      if (target.dataset.removeArtifactIndex != null) {
        event.preventDefault();
        removeIgnoredArtifact(Number(target.dataset.removeArtifactIndex));
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
    });
    document.addEventListener('change', function (event) {
      if (event.target.id === 'noteAsUnknown') state.noteAsUnknown = event.target.checked;
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
        toast('Settings saved for new runs');
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
          summary: trim(d.summary) || trim(d.restatement).slice(0, 200) || 'Confirmed brief',
          restatement: trim(d.restatement),
          goal: trim(d.goal),
          users: d.users.map(trim).filter(Boolean),
          inScope: d.inScope.map(trim).filter(Boolean),
          outOfScope: d.outOfScope.map(trim).filter(Boolean),
          assumptions: d.assumptions.map(trim).filter(Boolean),
          unknowns: d.unknowns.map(trim).filter(Boolean)
        };
        if (!cleaned.restatement || !cleaned.goal) { toast('Restatement and goal cannot be empty', true); return; }
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
      if (event.target.id === 'knowledgeSearch') { event.preventDefault(); try { var data = await api('/api/knowledge/search',{method:'POST',body:{query:$("knowledgeQuery").value}}); $("knowledgeResults").innerHTML = data.results.length ? data.results.map(function (result) { return '<article class="item"><div class="item-head"><div class="item-title">' + esc(result.title) + '</div><span class="score">' + Number(result.score).toFixed(3) + '</span></div><div class="faint">' + esc(result.source) + '</div><p class="muted">' + esc(result.excerpt) + '</p></article>'; }).join('') : '<div class="empty">No retrieved chunks matched this query.</div>'; } catch(error) { toast(error.message,true); } }
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
  })();
  </script>
</body>
</html>`;
}

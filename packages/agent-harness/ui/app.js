const elements = {
  runs: document.querySelector("#runs"),
  runCount: document.querySelector("#run-count"),
  action: document.querySelector("#action"),
  runActions: document.querySelector("#run-actions"),
  events: document.querySelector("#events"),
  diagnostics: document.querySelector("#diagnostics"),
  connection: document.querySelector("#connection"),
  projectSelect: document.querySelector("#project"),
  projectForm: document.querySelector("#add-project"),
  projectResult: document.querySelector("#project-result"),
  startForm: document.querySelector("#start-run"),
  startResult: document.querySelector("#start-result"),
  runTitle: document.querySelector("#run-title"),
  runMeta: document.querySelector("#run-meta"),
  runStatus: document.querySelector("#run-status"),
  newRunPanel: document.querySelector("#new-run-panel"),
  sidebar: document.querySelector("#sidebar"),
  navToggle: document.querySelector("#nav-toggle"),
  usageSummary: document.querySelector("#usage-summary"),
  usageBreakdown: document.querySelector("#usage-breakdown"),
  telemetryCoverage: document.querySelector("#telemetry-coverage"),
  sessions: document.querySelector("#sessions"),
  sessionCount: document.querySelector("#session-count"),
  artifacts: document.querySelector("#artifacts"),
  artifactCount: document.querySelector("#artifact-count"),
  setupPanel: document.querySelector("#setup-panel"),
  setupStatus: document.querySelector("#setup-status"),
  dockerCli: document.querySelector("#docker-cli"),
  dockerDaemon: document.querySelector("#docker-daemon"),
  runnerImage: document.querySelector("#runner-image"),
  setupGuidance: document.querySelector("#setup-guidance"),
  buildRunner: document.querySelector("#build-runner"),
  refreshSetup: document.querySelector("#refresh-setup"),
  setupLog: document.querySelector("#setup-log"),
};

let selected;
let projects = new Map();
let setupReady = false;
let setupPolling;

async function request(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function loadProjects(selectId) {
  const values = await request("/api/projects");
  projects = new Map(values.map((project) => [project.id, project]));
  elements.projectSelect.replaceChildren(...values.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} — ${project.repositoryPath}`;
    return option;
  }));
  if (selectId) elements.projectSelect.value = selectId;
  updateStartAvailability();
  if (values.length === 0) {
    const option = document.createElement("option");
    option.textContent = "Register a project first";
    elements.projectSelect.replaceChildren(option);
  }
}

async function loadRuns() {
  const values = await request("/api/runs");
  elements.runCount.textContent = String(values.length);
  if (values.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "No runs yet. Chart the first one.";
    elements.runs.replaceChildren(empty);
    return;
  }
  elements.runs.replaceChildren(...values.map(runNode));
}

function runNode(run) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "run-row";
  button.setAttribute("aria-pressed", String(run.id === selected));
  if (run.id === selected) button.classList.add("selected");

  const bar = document.createElement("span");
  bar.className = `status-bar ${run.status}`;
  const body = document.createElement("span");
  const name = document.createElement("span");
  name.className = "run-name";
  name.textContent = runLabel(run);
  const meta = document.createElement("span");
  meta.className = "run-meta-row";
  const step = document.createElement("span");
  step.textContent = words(run.currentStep);
  const age = document.createElement("span");
  age.textContent = relativeTime(run.updatedAt);
  meta.append(step, age);
  body.append(name, meta);
  button.append(bar, body);
  button.onclick = () => selectRun(run.id);
  return button;
}

function runLabel(run) {
  const idea = typeof run.input?.idea === "string" ? run.input.idea.trim() : "";
  return idea || `${projects.get(run.projectId)?.name || "Run"} · ${run.id.slice(0, 8)}`;
}

async function selectRun(id) {
  selected = id;
  const run = await request(`/api/runs/${id}`);
  await loadRuns();
  renderRunHeader(run);
  elements.diagnostics.textContent = JSON.stringify({ id: run.id, status: run.status, step: run.currentStep, revision: run.revision, workflow: run.workflowId }, null, 2);
  renderEvents(run.events);
  renderTelemetry(run.usage);
  renderSessions(run.turns || []);
  renderArtifacts(run.outputs || {}, run.artifacts || []);
  renderRunActions(run);
  renderGate(run);
  closeMobileNav();
}

function updateStartAvailability() {
  elements.startForm.querySelector("button[type=submit]").disabled = projects.size === 0 || !setupReady;
}

async function loadSetup() {
  const status = await request("/api/setup");
  setupReady = Boolean(status.ready);
  renderSetup(status);
  updateStartAvailability();
  if (status.build.status === "building" && !setupPolling) setupPolling = setInterval(() => void loadSetup().catch(renderSetupError), 2000);
  if (status.build.status !== "building" && setupPolling) { clearInterval(setupPolling); setupPolling = undefined; }
}

function renderSetup(status) {
  const building = status.build.status === "building";
  const failed = status.build.status === "failed";
  elements.setupPanel.className = `panel setup-panel ${failed ? "failed" : status.ready ? "ready" : ""}`;
  elements.setupStatus.className = `status ${building ? "working" : failed ? "blocked" : status.ready ? "completed" : "blocked"}`;
  elements.setupStatus.replaceChildren(document.createElement("i"), document.createTextNode(building ? "Building" : failed ? "Build failed" : status.ready ? "Ready" : "Setup required"));
  setCheck(elements.dockerCli, status.docker.cli, status.docker.cli ? status.docker.version || "Available" : "Not found");
  setCheck(elements.dockerDaemon, status.docker.daemon, status.docker.daemon ? "Running" : "Unavailable");
  setCheck(elements.runnerImage, status.runner.ready, status.runner.ready ? status.runner.image : "Not built");
  if (!status.docker.cli) elements.setupGuidance.textContent = "Install Docker Desktop (or Docker Engine) first, then return here and refresh. The WebUI will build the harness image.";
  else if (!status.docker.daemon) elements.setupGuidance.textContent = "Start Docker with Linux containers, then refresh this check.";
  else if (building) elements.setupGuidance.textContent = `Building ${status.runner.image}. This can take several minutes; you may leave this page open.`;
  else if (failed && status.runner.ready) elements.setupGuidance.textContent = "The rebuild failed, but the previous runner image is still usable. Review the diagnostics or retry the build.";
  else if (failed) elements.setupGuidance.textContent = "The runner image build failed. Review the diagnostics, correct the Docker issue, and retry here.";
  else if (!status.runner.ready) elements.setupGuidance.textContent = "Docker is ready. Build the neutral runner image here before starting a run.";
  else elements.setupGuidance.textContent = `Container execution is ready with ${status.runner.image}. Rebuild after updating the harness package.`;
  elements.buildRunner.disabled = !status.docker.daemon || building;
  elements.buildRunner.textContent = building ? "Building runner…" : status.runner.ready ? "Rebuild runner image" : "Build runner image";
  const diagnostic = status.build.error || status.build.log || status.docker.error || status.runner.error;
  elements.setupLog.hidden = !diagnostic;
  elements.setupLog.querySelector("pre").textContent = diagnostic || "";
}

function setCheck(element, ok, label) { element.className = ok ? "ok" : "error"; element.textContent = label; }
function renderSetupError(error) {
  setupReady = false;
  updateStartAvailability();
  elements.setupGuidance.textContent = error.message;
  elements.setupStatus.className = "status blocked";
  elements.setupStatus.replaceChildren(document.createElement("i"), document.createTextNode("Check failed"));
}

function renderTelemetry(report) {
  const total = report?.total;
  if (!total) return;
  elements.telemetryCoverage.textContent = `${total.usageReportedSessions} / ${total.sessions} reported`;
  const metrics = [
    ["Total tokens", formatNumber(total.usage.totalTokens)],
    ["Input tokens", formatNumber(total.usage.inputTokens)],
    ["Output tokens", formatNumber(total.usage.outputTokens)],
    ["Provider cost", formatCost(total.usage.costUsd)],
  ];
  elements.usageSummary.replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement("div"); item.className = "metric";
    const name = document.createElement("span"); name.textContent = label;
    const amount = document.createElement("strong"); amount.textContent = value;
    item.append(name, amount); return item;
  }));
  if (!report.byRole?.length) { elements.usageBreakdown.replaceChildren(); return; }
  const table = document.createElement("table");
  const head = document.createElement("thead"); const header = document.createElement("tr");
  for (const label of ["Role", "Sessions", "Input", "Output", "Total"]) { const cell = document.createElement("th"); cell.textContent = label; header.append(cell); }
  head.append(header); const body = document.createElement("tbody");
  for (const row of report.byRole) {
    const tr = document.createElement("tr");
    for (const value of [words(row.key), row.sessions, formatNumber(row.usage.inputTokens), formatNumber(row.usage.outputTokens), formatNumber(row.usage.totalTokens)]) { const cell = document.createElement("td"); cell.textContent = String(value); tr.append(cell); }
    body.append(tr);
  }
  table.append(head, body); elements.usageBreakdown.replaceChildren(table);
}

function renderSessions(turns) {
  elements.sessionCount.textContent = String(turns.length);
  if (!turns.length) { const empty = document.createElement("div"); empty.className = "empty-inline"; empty.textContent = "No agent sessions recorded yet."; elements.sessions.replaceChildren(empty); return; }
  elements.sessions.replaceChildren(...[...turns].reverse().map((turn) => {
    const detail = document.createElement("details"); detail.className = "session";
    const summary = document.createElement("summary");
    const identity = document.createElement("span"); identity.className = "session-identity";
    const title = document.createElement("strong"); title.textContent = words(turn.role);
    const meta = document.createElement("small"); meta.textContent = `${words(turn.stepId)} · ${relativeTime(turn.updatedAt)}`;
    identity.append(title, meta);
    const status = document.createElement("span"); status.className = `session-status ${turn.status}`; status.textContent = words(turn.status);
    summary.append(identity, status);
    const body = document.createElement("div"); body.className = "session-body";
    body.append(detailBlock("Session", turn.sessionId || "Not assigned"), detailBlock("Provider telemetry", turn.usage || "Not reported"), detailBlock("Submitted prompt", turn.request?.prompt), detailBlock("Output", turn.output), detailBlock("Error", turn.error));
    detail.append(summary, body); return detail;
  }));
}

function renderArtifacts(outputs, artifacts) {
  const entries = [
    ...Object.entries(outputs).map(([name, value]) => ({ stepId: name, name: "Step output", value })),
    ...artifacts.map((artifact) => ({ stepId: artifact.stepId, name: artifact.name, value: { path: artifact.path, mediaType: artifact.mediaType, createdAt: artifact.createdAt } })),
  ];
  elements.artifactCount.textContent = String(entries.length);
  if (!entries.length) { const empty = document.createElement("div"); empty.className = "empty-inline"; empty.textContent = "No durable outputs or artifacts yet."; elements.artifacts.replaceChildren(empty); return; }
  elements.artifacts.replaceChildren(...entries.map((entry) => {
    const detail = document.createElement("details"); detail.className = "artifact";
    const summary = document.createElement("summary"); const title = document.createElement("strong"); title.textContent = entry.name;
    const step = document.createElement("span"); step.textContent = words(entry.stepId); summary.append(title, step);
    const pre = document.createElement("pre"); pre.textContent = serialize(entry.value); detail.append(summary, pre); return detail;
  }));
}

function detailBlock(label, value) {
  const section = document.createElement("section"); if (value === undefined || value === null || value === "") { section.hidden = true; return section; }
  const heading = document.createElement("h4"); heading.textContent = label;
  const pre = document.createElement("pre"); pre.textContent = serialize(value); section.append(heading, pre); return section;
}

function serialize(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function formatCost(value) { return Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }); }

function renderRunHeader(run) {
  elements.runTitle.textContent = runLabel(run);
  const project = projects.get(run.projectId);
  elements.runMeta.textContent = `${project?.name || "Unknown project"} · ${words(run.currentStep)} · Updated ${relativeTime(run.updatedAt)}`;
  elements.runStatus.className = `status ${run.status}`;
  elements.runStatus.replaceChildren(document.createElement("i"), document.createTextNode(words(run.status)));
}

function renderGate(run) {
  if (!run.gate) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const symbol = document.createElement("div");
    symbol.className = "empty-symbol";
    symbol.textContent = run.status === "blocked" ? "!" : "✓";
    const title = document.createElement("strong");
    title.textContent = run.status === "blocked" ? "Run needs intervention" : "No operator action required";
    const copy = document.createElement("p");
    copy.textContent = run.status === "blocked" ? "Inspect diagnostics, then retry or cancel the run." : "The coordinator will surface the next decision here.";
    empty.append(symbol, title, copy);
    elements.action.replaceChildren(empty);
    return;
  }

  const form = document.createElement("form");
  const heading = document.createElement("h3");
  heading.textContent = run.gate.title;
  form.append(heading);
  for (const question of run.gate.questions) {
    const label = document.createElement("label");
    label.textContent = question.prompt;
    const textarea = document.createElement("textarea");
    textarea.name = question.id;
    textarea.required = question.required;
    textarea.placeholder = question.required ? "Required response" : "Optional response";
    label.append(textarea);
    form.append(label);
  }
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Submit answers";
  form.append(submit);
  form.onsubmit = async (event) => {
    event.preventDefault();
    submit.disabled = true;
    submit.textContent = "Submitting…";
    try {
      const answers = Object.fromEntries(new FormData(form));
      await command(run.id, "submit-answers", { gateId: run.gate.id, answers });
      elements.action.textContent = "Answers submitted. The coordinator is resuming the run.";
    } catch (error) {
      submit.textContent = error.message;
      submit.disabled = false;
    }
  };
  elements.action.replaceChildren(form);
}

function renderRunActions(run) {
  elements.runActions.replaceChildren();
  if (["blocked", "stalled"].includes(run.status)) elements.runActions.append(actionButton("Retry turn", () => command(run.id, "retry-turn"), "secondary"));
  if (!["completed", "cancelled"].includes(run.status)) elements.runActions.append(actionButton("Cancel run", () => command(run.id, "cancel-run"), "danger"));
}

function actionButton(label, handler, className) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = className;
  button.onclick = async () => {
    button.disabled = true;
    try {
      await handler();
      button.textContent = `${label} requested`;
    } catch (error) {
      button.textContent = error.message;
      button.disabled = false;
    }
  };
  return button;
}

function command(runId, kind, payload = {}) {
  return request(`/api/runs/${runId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, payload }),
  });
}

function renderEvents(values) {
  if (values.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-event";
    empty.textContent = "This run has not emitted any events yet.";
    elements.events.replaceChildren(empty);
    return;
  }
  elements.events.replaceChildren(...values.map(eventNode));
  elements.events.scrollTop = elements.events.scrollHeight;
}

function eventNode(event) {
  const item = document.createElement("li");
  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const message = document.createElement("span");
  message.textContent = event.message;
  item.append(time, message);
  return item;
}

function words(value) {
  return String(value).replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeTime(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

elements.projectForm.onsubmit = async (event) => {
  event.preventDefault();
  elements.projectResult.textContent = "Registering…";
  try {
    const body = Object.fromEntries(new FormData(elements.projectForm));
    const project = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await loadProjects(project.id);
    elements.projectResult.textContent = `Registered ${project.name}.`;
    elements.projectForm.reset();
    elements.projectForm.elements.baseBranch.value = "main";
  } catch (error) {
    elements.projectResult.textContent = error.message;
  }
};

elements.startForm.onsubmit = async (event) => {
  event.preventDefault();
  const submit = elements.startForm.querySelector("button[type=submit]");
  submit.disabled = true;
  elements.startResult.textContent = "Starting run…";
  try {
    const values = Object.fromEntries(new FormData(elements.startForm));
    const run = await request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: values.projectId, idea: values.idea, fresh: values.fresh === "on" }) });
    elements.startForm.querySelector("textarea").value = "";
    elements.startResult.textContent = `Started run ${run.id.slice(0, 8)}.`;
    await selectRun(run.id);
  } catch (error) {
    elements.startResult.textContent = error.message;
  } finally {
    updateStartAvailability();
  }
};

document.querySelector("#new-run-toggle").onclick = () => {
  closeMobileNav();
  elements.newRunPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.startForm.querySelector("textarea").focus({ preventScroll: true });
};

elements.navToggle.onclick = () => {
  const open = elements.sidebar.classList.toggle("open");
  elements.navToggle.setAttribute("aria-expanded", String(open));
};

elements.buildRunner.onclick = async () => {
  elements.buildRunner.disabled = true;
  try { await request("/api/setup/runner", { method: "POST" }); await loadSetup(); }
  catch (error) { renderSetupError(error); }
};
elements.refreshSetup.onclick = () => void loadSetup().catch(renderSetupError);

function closeMobileNav() {
  elements.sidebar.classList.remove("open");
  elements.navToggle.setAttribute("aria-expanded", "false");
}

const source = new EventSource("/api/events");
source.onopen = () => {
  elements.connection.className = "connection live";
  elements.connection.lastChild.textContent = " Live";
};
source.onerror = () => {
  elements.connection.className = "connection reconnecting";
  elements.connection.lastChild.textContent = " Reconnecting";
};
source.onmessage = (message) => {
  const event = JSON.parse(message.data);
  if (!event.runId) void loadSetup().catch(renderSetupError);
  if (event.runId === selected) {
    void selectRun(selected);
  } else void loadRuns();
};

void Promise.all([loadProjects(), loadRuns(), loadSetup()]).catch((error) => {
  elements.connection.className = "connection reconnecting";
  elements.connection.lastChild.textContent = ` ${error.message}`;
});

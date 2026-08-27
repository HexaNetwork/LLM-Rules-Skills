const elements = {
  runs: document.querySelector("#runs"),
  runCount: document.querySelector("#run-count"),
  action: document.querySelector("#action"),
  actionTitle: document.querySelector("#action-title"),
  actionPanel: document.querySelector(".action-panel"),
  runActions: document.querySelector("#run-actions"),
  events: document.querySelector("#events"),
  diagnostics: document.querySelector("#diagnostics"),
  connection: document.querySelector("#connection"),
  projects: document.querySelector("#projects"),
  projectCount: document.querySelector("#project-count"),
  projectSelect: document.querySelector("#project"),
  baseBranchSelect: document.querySelector("#base-branch"),
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
  ideaInput: document.querySelector("#idea"),
  errorsPanel: document.querySelector("#errors-panel"),
  errors: document.querySelector("#errors"),
  errorCount: document.querySelector("#error-count"),
  settingsPanel: document.querySelector("#settings-panel"),
  settingsToggle: document.querySelector("#settings-toggle"),
  settingsClose: document.querySelector("#settings-close"),
  settingsResult: document.querySelector("#settings-result"),
  settingsRuntimeForm: document.querySelector("#settings-runtime-form"),
  settingsModelsForm: document.querySelector("#settings-models-form"),
  guidanceRoles: document.querySelector("#guidance-roles"),
  guidanceDetail: document.querySelector("#guidance-detail"),
  workspaceMain: document.querySelector(".workspace"),
  runDetail: document.querySelector("#run-detail"),
  runInput: document.querySelector("#run-input"),
  sessionTabCount: document.querySelector("#session-tab-count"),
  artifactTabCount: document.querySelector("#artifact-tab-count"),
  errorTabCount: document.querySelector("#error-tab-count"),
};

const runTabPanels = {
  overview: document.querySelector("#run-tab-overview"),
  timeline: document.querySelector("#run-tab-timeline"),
  sessions: document.querySelector("#run-tab-sessions"),
  outputs: document.querySelector("#run-tab-outputs"),
  technical: document.querySelector("#run-tab-technical"),
};

let runTab = "overview";

function autosizeIdeaInput() {
  const node = elements.ideaInput;
  if (!node) return;
  node.style.height = "auto";
  node.style.height = `${Math.max(node.scrollHeight, 132)}px`;
}

elements.ideaInput?.addEventListener("input", autosizeIdeaInput);
autosizeIdeaInput();

let selected;
let projects = new Map();
let preferredBaseBranch = "";
let setupReady = false;
let setupPolling;
let settingsState = null;
let guidanceRole = null;
let guidanceDoc = null;
let settingsTab = "runtime";
const gateDrafts = new Map();

function emptyGateDraft() {
  return { answers: {}, parked: {}, notes: "", clarifications: {}, batchFeedback: "", gateFeedback: "" };
}

function ensureGateDraft(runId) {
  const draft = gateDrafts.get(runId) || emptyGateDraft();
  gateDrafts.set(runId, draft);
  return draft;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function loadProjects(selectId) {
  const values = await request("/api/projects");
  projects = new Map(values.map((project) => [project.id, project]));
  renderProjects(values);
  elements.projectSelect.replaceChildren(...values.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} — ${project.repositoryPath}`;
    return option;
  }));
  if (selectId) elements.projectSelect.value = selectId;
  await loadProjectBranches(elements.projectSelect.value);
  updateStartAvailability();
  if (values.length === 0) {
    const option = document.createElement("option");
    option.textContent = "Register a project first";
    elements.projectSelect.replaceChildren(option);
    await loadProjectBranches("");
  }
}

function branchOption(label, value) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

async function loadProjectBranches(projectId) {
  const select = elements.baseBranchSelect;
  if (!projectId) {
    select.replaceChildren(branchOption("Select a project first", ""));
    select.disabled = true;
    return;
  }
  const project = projects.get(projectId);
  select.disabled = true;
  select.replaceChildren(branchOption("Loading branches…", ""));
  try {
    const listed = await request(`/api/projects/${encodeURIComponent(projectId)}/branches`);
    const branches = listed.branches || [];
    if (branches.length === 0) {
      select.replaceChildren(branchOption("No local branches", ""));
      select.disabled = true;
      return;
    }
    select.replaceChildren(...branches.map((name) => branchOption(name, name)));
    const pick = (preferredBaseBranch && branches.includes(preferredBaseBranch))
      ? preferredBaseBranch
      : (project?.baseBranch && branches.includes(project.baseBranch))
        ? project.baseBranch
        : (listed.current && branches.includes(listed.current))
          ? listed.current
          : branches[0];
    select.value = pick;
    select.disabled = false;
  } catch (error) {
    select.replaceChildren(branchOption(error.message, ""));
    select.disabled = true;
  }
}

function renderProjects(values) {
  elements.projectCount.textContent = String(values.length);
  if (values.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "No registered projects.";
    elements.projects.replaceChildren(empty);
    return;
  }
  elements.projects.replaceChildren(...values.map(projectNode));
}

function projectNode(project) {
  const row = document.createElement("div");
  row.className = "project-row";
  row.title = project.repositoryPath;
  const name = document.createElement("span");
  name.className = "project-name";
  name.textContent = project.name;
  const meta = document.createElement("span");
  meta.className = "project-meta";
  meta.textContent = `${project.repositoryPath} · ${project.baseBranch}`;
  row.append(name, meta);
  return row;
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
  hideSettings();
  const run = await request(`/api/runs/${id}`);
  await loadRuns();
  showRunDetail();
  renderRunHeader(run);
  renderRunInput(run);
  elements.diagnostics.textContent = JSON.stringify({ id: run.id, status: run.status, step: run.currentStep, revision: run.revision, workflow: run.workflowId, input: run.input, outputs: run.outputs, errors: run.errors }, null, 2);
  renderErrors(run.errors || []);
  renderEvents(run.events);
  renderTelemetry(run.usage);
  renderSessions(run.turns || []);
  renderArtifacts(run.outputs || {}, run.artifacts || []);
  renderRunActions(run);
  renderGate(run);
  closeMobileNav();
}

function showRunDetail() {
  elements.runDetail.classList.remove("hidden");
  elements.runDetail.setAttribute("aria-hidden", "false");
}

function hideRunDetail() {
  elements.runDetail.classList.add("hidden");
  elements.runDetail.setAttribute("aria-hidden", "true");
}

function showRunTab(tab = runTab) {
  runTab = tab;
  for (const button of document.querySelectorAll(".run-tab")) {
    const active = button.dataset.runTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  }
  for (const [name, panel] of Object.entries(runTabPanels)) {
    const active = name === tab;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  }
}

function renderRunInput(run) {
  const idea = typeof run.input?.idea === "string" ? run.input.idea.trim() : "";
  if (!idea) {
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "No input recorded for this run.";
    elements.runInput.replaceChildren(empty);
    return;
  }
  const body = document.createElement("div");
  body.className = "run-input-copy";
  const pre = document.createElement("pre");
  pre.textContent = idea;
  body.append(pre);
  const meta = document.createElement("dl");
  meta.className = "run-input-meta";
  const fields = [
    ["Base branch", run.input?.baseBranch],
    ["Fresh project", run.input?.fresh ? "Yes" : "No"],
    ["Title", run.input?.title],
  ];
  for (const [label, value] of fields) {
    if (value === undefined || value === null || value === "") continue;
    const term = document.createElement("dt");
    term.textContent = label;
    const detail = document.createElement("dd");
    detail.textContent = String(value);
    meta.append(term, detail);
  }
  if (meta.children.length) body.append(meta);
  elements.runInput.replaceChildren(body);
}

function renderErrors(errors) {
  const count = errors.length;
  elements.errorCount.textContent = String(count);
  elements.errorTabCount.textContent = String(count);
  elements.errorTabCount.classList.toggle("hidden", count === 0);
  elements.errorsPanel.classList.toggle("hidden", count === 0);
  elements.errorsPanel.classList.toggle("has-errors", count > 0);
  if (!count) {
    elements.errors.replaceChildren();
    return;
  }
  elements.errors.replaceChildren(...errors.map((entry) => {
    const article = document.createElement("article");
    article.className = "error-card";
    const head = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = errorTitle(entry);
    const meta = document.createElement("span");
    meta.className = "error-meta";
    meta.textContent = `${words(entry.source)} · ${relativeTime(entry.createdAt)}`;
    head.append(title, meta);
    const message = document.createElement("pre");
    message.textContent = entry.message;
    article.append(head, message);
    if (entry.detail !== undefined && entry.detail !== null && entry.detail !== "") {
      const detail = document.createElement("pre");
      detail.className = "error-detail";
      detail.textContent = serialize(entry.detail);
      article.append(detail);
    }
    return article;
  }));
}

function errorTitle(entry) {
  const parts = [];
  if (entry.stepId) parts.push(words(entry.stepId));
  if (entry.role) parts.push(words(entry.role));
  if (!parts.length) parts.push(words(entry.source));
  return parts.join(" · ");
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
  if (!total) {
    elements.telemetryCoverage.textContent = "0 sessions";
    const empty = document.createElement("div");
    empty.className = "empty-inline";
    empty.textContent = "No usage reported yet.";
    elements.usageSummary.replaceChildren(empty);
    elements.usageBreakdown.replaceChildren();
    return;
  }
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
  elements.sessionTabCount.textContent = String(turns.length);
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
  elements.artifactTabCount.textContent = String(entries.length);
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

const REFLECT_FIELDS = [
  { id: "proposedTitle", label: "Feature title", list: false, single: true },
  { id: "restatement", label: "Restatement", list: false, single: false },
  { id: "goal", label: "Goal", list: false, single: false },
  { id: "users", label: "Users", list: true, single: false },
  { id: "inScope", label: "In scope", list: true, single: false },
  { id: "outOfScope", label: "Out of scope", list: true, single: false },
  { id: "assumptions", label: "Assumptions", list: true, single: false },
  { id: "unknowns", label: "Unknowns", list: true, single: false },
];

function reflectFieldValue(reflect, draft, id) {
  if (draft?.answers[id] != null) return draft.answers[id];
  const raw = reflect?.[id];
  if (Array.isArray(raw)) return raw.join("\n");
  return raw == null ? "" : String(raw);
}

function reflectListEntries(value) {
  const raw = value == null ? "" : String(value);
  return raw.length ? raw.split(/\r?\n/) : [""];
}

function autosizeTextarea(node) {
  if (!node || node.tagName !== "TEXTAREA") return;
  node.style.height = "auto";
  node.style.height = `${Math.max(node.scrollHeight, 52)}px`;
}

function autosizeGateTextareas(root) {
  root?.querySelectorAll("textarea").forEach(autosizeTextarea);
}

function syncReflectListAnswers(form, fieldId) {
  const inputs = form.querySelectorAll(`[data-reflect-list-item="${CSS.escape(fieldId)}"]`);
  return Array.from(inputs).map((input) => input.value).join("\n");
}

function replaceReflectList(form, fieldId, value) {
  const host = form.querySelector(`[data-reflect-list="${CSS.escape(fieldId)}"]`);
  if (!host) return;
  host.replaceWith(reflectListNode(fieldId, value));
}

function reflectListNode(fieldId, value) {
  const entries = reflectListEntries(value);
  const list = document.createElement("div");
  list.className = "reflect-list";
  list.dataset.reflectList = fieldId;
  for (const [index, entry] of entries.entries()) {
    list.append(reflectListRow(fieldId, index, entry, entries.length));
  }
  const add = document.createElement("button");
  add.type = "button";
  add.className = "secondary reflect-list-add";
  add.dataset.reflectListAdd = fieldId;
  add.textContent = "Add entry";
  list.append(add);
  return list;
}

function reflectListRow(fieldId, index, entry, count) {
  const row = document.createElement("div");
  row.className = "reflect-list-row";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.reflectListItem = fieldId;
  input.dataset.index = String(index);
  input.value = entry;
  input.placeholder = "One entry";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "quiet";
  remove.dataset.reflectListRemove = fieldId;
  remove.dataset.index = String(index);
  remove.title = "Remove";
  remove.setAttribute("aria-label", "Remove");
  remove.disabled = count <= 1;
  remove.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" stroke="currentColor" stroke-width="2"/><path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  row.append(input, remove);
  return row;
}

function reflectFieldNode(field, reflect, draft) {
  const value = reflectFieldValue(reflect, draft, field.id);
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = document.createElement("label");
  label.textContent = field.label;
  if (field.list) {
    label.append(reflectListNode(field.id, value));
  } else if (field.single) {
    const input = document.createElement("input");
    input.type = "text";
    input.name = field.id;
    input.dataset.reflectField = field.id;
    input.value = value;
    input.placeholder = "Short imperative run label";
    label.append(input);
  } else {
    const textarea = document.createElement("textarea");
    textarea.name = field.id;
    textarea.dataset.reflectField = field.id;
    textarea.rows = 1;
    textarea.value = value;
    label.append(textarea);
  }
  wrap.append(label);
  return wrap;
}

function readReflectGateAnswers(form) {
  const answers = {};
  for (const field of REFLECT_FIELDS) {
    if (field.list) answers[field.id] = syncReflectListAnswers(form, field.id);
    else answers[field.id] = form.elements[field.id]?.value ?? "";
  }
  const notes = form.querySelector("#gate-notes");
  if (notes?.value?.trim()) answers.notes = notes.value.trim();
  return answers;
}

function gateNotesFooter(notesValue = "") {
  const footer = document.createElement("div");
  footer.className = "gate-footer";
  const notesLabel = document.createElement("label");
  notesLabel.textContent = "Extra notes for the agent";
  const notes = document.createElement("textarea");
  notes.id = "gate-notes";
  notes.rows = 1;
  notes.placeholder = "Optional context for the next agent turn";
  notes.value = notesValue;
  notesLabel.append(notes);
  footer.append(notesLabel);
  return footer;
}

async function submitGateAnswers(run, answers, button, successMessage) {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Submitting…";
  try {
    await command(run.id, "submit-answers", { gateId: run.gate.id, answers });
    elements.action.replaceChildren(Object.assign(document.createElement("p"), { className: "gate-submitted", textContent: successMessage }));
  } catch (error) {
    button.textContent = error.message;
    button.disabled = false;
  }
}

function wireReflectListControls(form) {
  form.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement) autosizeTextarea(event.target);
  });
  form.addEventListener("click", (event) => {
    const add = event.target.closest("[data-reflect-list-add]");
    if (add) {
      const fieldId = add.dataset.reflectListAdd;
      const entries = reflectListEntries(syncReflectListAnswers(form, fieldId));
      entries.push("");
      replaceReflectList(form, fieldId, entries.join("\n"));
      autosizeGateTextareas(form);
      form.querySelectorAll(`[data-reflect-list-item="${CSS.escape(fieldId)}"]`).at(-1)?.focus();
      return;
    }
    const remove = event.target.closest("[data-reflect-list-remove]");
    if (remove && !remove.disabled) {
      const fieldId = remove.dataset.reflectListRemove;
      const entries = reflectListEntries(syncReflectListAnswers(form, fieldId));
      if (entries.length <= 1) replaceReflectList(form, fieldId, "");
      else {
        entries.splice(Number(remove.dataset.index), 1);
        replaceReflectList(form, fieldId, entries.join("\n"));
      }
      autosizeGateTextareas(form);
    }
  });
}

function renderReflectGate(run, gate, draft) {
  const reflect = gate.reflect || {};
  for (const field of REFLECT_FIELDS) {
    if (draft.answers[field.id] == null) draft.answers[field.id] = reflectFieldValue(reflect, draft, field.id);
  }
  const section = document.createElement("section");
  section.className = "gate reflect-gate";
  const form = document.createElement("form");
  form.className = "reflect-fields";
  form.id = "reflectFields";
  for (const field of REFLECT_FIELDS) form.append(reflectFieldNode(field, reflect, draft));
  const footer = gateNotesFooter(draft.notes);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Confirm brief";
  footer.append(submit);
  form.append(footer);
  wireReflectListControls(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitGateAnswers(run, readReflectGateAnswers(form), submit, "Brief confirmed. The coordinator is resuming the run.");
  });
  section.append(form);
  autosizeGateTextareas(section);
  return section;
}

function renderFlatBriefGate(run, gate, draft) {
  const briefQuestion = gate.questions.find((question) => question.id === "brief") || gate.questions[0];
  if (draft.answers.brief == null) draft.answers.brief = briefQuestion?.prompt || "";
  const section = document.createElement("section");
  section.className = "gate flat-brief-gate";
  const form = document.createElement("form");
  form.className = "reflect-fields";
  const field = document.createElement("div");
  field.className = "field";
  const label = document.createElement("label");
  label.textContent = "Brief";
  const textarea = document.createElement("textarea");
  textarea.name = "brief";
  textarea.required = true;
  textarea.value = draft.answers.brief;
  label.append(textarea);
  field.append(label);
  form.append(field);
  const footer = gateNotesFooter(draft.notes);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Confirm brief";
  footer.append(submit);
  form.append(footer);
  form.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement) autosizeTextarea(event.target);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const answers = { brief: textarea.value.trim() };
    const notes = form.querySelector("#gate-notes");
    if (notes?.value?.trim()) answers.notes = notes.value.trim();
    void submitGateAnswers(run, answers, submit, "Brief confirmed. The coordinator is resuming the run.");
  });
  section.append(form);
  autosizeGateTextareas(section);
  return section;
}

function grillQuestionAnswered(question, draft) {
  if (draft.parked[question.id]) return true;
  if (draft.clarifications[question.id] != null) return true;
  return Boolean(String(draft.answers[question.id] || "").trim());
}

function renderGrillGate(run, gate, draft) {
  const questions = gate.questions || [];
  const section = document.createElement("section");
  section.className = "gate batch-card";
  const hint = document.createElement("p");
  hint.className = "keyboard-hint";
  hint.textContent = "Answer each material unknown below. Skip any question you want to defer.";
  section.append(hint);
  for (const [index, question] of questions.entries()) {
    if (draft.answers[question.id] == null) draft.answers[question.id] = "";
    const card = document.createElement("article");
    card.className = "batch-question";
    if (draft.parked[question.id]) card.classList.add("parked");
    if (draft.clarifications[question.id] != null) card.classList.add("clarifying");
    const head = document.createElement("div");
    head.className = "item-head";
    const label = document.createElement("div");
    label.className = "card-label";
    label.textContent = `Question ${index + 1} of ${questions.length}`;
    const tag = document.createElement("span");
    tag.className = `tag${grillQuestionAnswered(question, draft) ? " hitl" : ""}`;
    tag.textContent = draft.parked[question.id] ? "Skipped" : (grillQuestionAnswered(question, draft) ? "Answered" : "Unanswered");
    head.append(label, tag);
    const prompt = document.createElement("div");
    prompt.className = "prompt";
    prompt.textContent = question.prompt;
    card.append(head, prompt);
    if (draft.clarifications[question.id] != null) {
      const clarify = document.createElement("textarea");
      clarify.dataset.batchClarifyText = question.id;
      clarify.placeholder = "What is unclear? Ask the griller to rephrase or add precision…";
      clarify.value = draft.clarifications[question.id];
      card.append(clarify);
    } else {
      const answer = document.createElement("textarea");
      answer.dataset.batchAnswer = question.id;
      answer.placeholder = "Optional notes, or answer in your own words…";
      answer.value = draft.answers[question.id];
      card.append(answer);
    }
    const foot = document.createElement("div");
    foot.className = "batch-question-foot";
    const clarifyButton = document.createElement("button");
    clarifyButton.type = "button";
    clarifyButton.className = "quiet";
    clarifyButton.dataset.batchClarify = question.id;
    clarifyButton.textContent = draft.clarifications[question.id] != null ? "Cancel Wait what?" : "Wait what?";
    const skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.className = "quiet";
    skipButton.dataset.batchSkip = question.id;
    skipButton.textContent = draft.parked[question.id] ? "Unskip" : "Skip for now";
    foot.append(clarifyButton, skipButton);
    card.append(foot);
    section.append(card);
  }
  const footer = document.createElement("div");
  footer.className = "batch-footer";
  const count = document.createElement("span");
  count.className = "muted";
  count.dataset.batchCount = "true";
  count.textContent = `${questions.filter((question) => grillQuestionAnswered(question, draft)).length} of ${questions.length} answered`;
  const actions = document.createElement("div");
  actions.className = "batch-footer-actions";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary";
  submit.textContent = "Submit answers";
  actions.append(submit);
  footer.append(count, actions);
  section.append(footer, gateNotesFooter(draft.notes));
  section.addEventListener("click", (event) => {
    const clarifyToggle = event.target.closest("[data-batch-clarify]");
    if (clarifyToggle) {
      const id = clarifyToggle.dataset.batchClarify;
      if (draft.clarifications[id] != null) delete draft.clarifications[id];
      else draft.clarifications[id] = "";
      renderGate(run);
      return;
    }
    const skipToggle = event.target.closest("[data-batch-skip]");
    if (skipToggle) {
      const id = skipToggle.dataset.batchSkip;
      draft.parked[id] = !draft.parked[id];
      renderGate(run);
      return;
    }
    if (event.target === submit) {
      const answers = {};
      for (const question of questions) {
        if (draft.parked[question.id]) continue;
        if (draft.clarifications[question.id] != null) answers[question.id] = draft.clarifications[question.id];
        else answers[question.id] = section.querySelector(`[data-batch-answer="${CSS.escape(question.id)}"]`)?.value || draft.answers[question.id] || "";
      }
      const notes = section.querySelector("#gate-notes");
      if (notes?.value?.trim()) answers.notes = notes.value.trim();
      void submitGateAnswers(run, answers, submit, "Answers submitted. The coordinator is resuming the run.");
    }
  });
  section.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    autosizeTextarea(target);
    if (target.dataset.batchAnswer) draft.answers[target.dataset.batchAnswer] = target.value;
    if (target.dataset.batchClarifyText) draft.clarifications[target.dataset.batchClarifyText] = target.value;
    const answered = questions.filter((question) => grillQuestionAnswered(question, draft)).length;
    count.textContent = `${answered} of ${questions.length} answered`;
    section.querySelectorAll(".batch-question").forEach((node, index) => {
      const question = questions[index];
      const tag = node.querySelector(".tag");
      if (!tag || !question) return;
      tag.className = `tag${grillQuestionAnswered(question, draft) ? " hitl" : ""}`;
      tag.textContent = draft.parked[question.id] ? "Skipped" : (grillQuestionAnswered(question, draft) ? "Answered" : "Unanswered");
    });
  });
  autosizeGateTextareas(section);
  return section;
}

function formatGateText(value) {
  const body = document.createElement("div");
  body.className = "artifact-body";
  body.textContent = String(value ?? "");
  return body;
}

function formatGateScenarios(value) {
  let list = Array.isArray(value) ? value : null;
  if (!list && value && typeof value === "object" && Array.isArray(value.scenarios)) list = value.scenarios;
  if (!list?.length) {
    const missing = document.createElement("div");
    missing.className = "gate-review-missing";
    missing.textContent = "Missing";
    return missing;
  }
  const wrap = document.createElement("div");
  for (const item of list) {
    const row = item && typeof item === "object" ? item : {};
    const block = document.createElement("div");
    block.className = "gate-scenario";
    const title = document.createElement("h5");
    title.textContent = String(row.title || row.id || "Scenario");
    block.append(title);
    if (Array.isArray(row.steps) && row.steps.length) {
      const steps = document.createElement("ol");
      for (const step of row.steps) {
        const li = document.createElement("li");
        li.textContent = String(step);
        steps.append(li);
      }
      block.append(steps);
    } else {
      const empty = document.createElement("div");
      empty.className = "empty-inline";
      empty.textContent = "No steps.";
      block.append(empty);
    }
    wrap.append(block);
  }
  return wrap;
}

function reviewBlock(title, content) {
  const block = document.createElement("div");
  block.className = "gate-review-block";
  const heading = document.createElement("h4");
  heading.textContent = title;
  block.append(heading, content);
  return block;
}

function renderSpecificationGate(run, gate, draft) {
  const documents = gate.documents || {};
  const section = document.createElement("section");
  section.className = "gate operator-gate";
  const review = document.createElement("div");
  review.className = "gate-review";
  review.append(
    reviewBlock("Plan", formatGateText(documents.plan)),
    reviewBlock("Requirements", formatGateText(documents.requirements)),
    reviewBlock("Scenarios", formatGateScenarios(documents.scenarios)),
  );
  section.append(review);
  const footer = gateNotesFooter(draft.notes);
  footer.classList.add("operator-gate-footer");
  const actions = document.createElement("div");
  actions.className = "gate-actions";
  const requestChanges = document.createElement("button");
  requestChanges.type = "button";
  requestChanges.className = "secondary";
  requestChanges.textContent = "Request changes";
  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary";
  approve.textContent = "Approve";
  actions.append(requestChanges, approve);
  footer.append(actions);
  section.append(footer);
  requestChanges.addEventListener("click", () => {
    const notes = section.querySelector("#gate-notes")?.value.trim();
    if (!notes) {
      draft.gateFeedback = "Describe the requested changes in Notes before submitting.";
      renderGate(run);
      return;
    }
    void submitGateAnswers(run, { decision: notes }, requestChanges, "Requested changes submitted. The coordinator is revising the specification.");
  });
  approve.addEventListener("click", () => {
    void submitGateAnswers(run, { decision: "approve" }, approve, "Specification approved. The coordinator is continuing the run.");
  });
  autosizeGateTextareas(section);
  return section;
}

function renderPublishGate(run, gate, draft) {
  const section = document.createElement("section");
  section.className = "gate publish-gate";
  const form = document.createElement("form");
  form.className = "reflect-fields";
  for (const question of gate.questions) {
    if (draft.answers[question.id] == null) draft.answers[question.id] = question.prompt;
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = words(question.id);
    const textarea = document.createElement("textarea");
    textarea.name = question.id;
    textarea.required = question.required;
    textarea.value = draft.answers[question.id];
    label.append(textarea);
    field.append(label);
    form.append(field);
  }
  const footer = gateNotesFooter(draft.notes);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Approve pull request";
  footer.append(submit);
  form.append(footer);
  form.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement) autosizeTextarea(event.target);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const answers = Object.fromEntries(new FormData(form));
    void submitGateAnswers(run, answers, submit, "Pull request draft approved. The coordinator is continuing the run.");
  });
  section.append(form);
  autosizeGateTextareas(section);
  return section;
}

function renderQuestionGate(run, gate, draft) {
  const section = document.createElement("section");
  section.className = "gate question-gate";
  const questions = document.createElement("div");
  questions.className = "questions";
  for (const question of gate.questions) {
    if (draft.answers[question.id] == null) draft.answers[question.id] = "";
    const block = document.createElement("div");
    block.className = "question";
    const title = document.createElement("div");
    title.className = "question-title";
    title.textContent = question.prompt;
    const textarea = document.createElement("textarea");
    textarea.name = question.id;
    textarea.required = question.required;
    textarea.placeholder = question.required ? "Required response" : "Optional response";
    textarea.value = draft.answers[question.id];
    block.append(title, textarea);
    questions.append(block);
  }
  section.append(questions);
  const footer = document.createElement("div");
  footer.className = "gate-footer";
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary";
  submit.textContent = "Submit answers";
  footer.append(submit);
  section.append(footer);
  submit.addEventListener("click", () => {
    const answers = {};
    for (const question of gate.questions) {
      answers[question.id] = section.querySelector(`textarea[name="${CSS.escape(question.id)}"]`)?.value ?? "";
    }
    void submitGateAnswers(run, answers, submit, "Answers submitted. The coordinator is resuming the run.");
  });
  section.addEventListener("input", (event) => {
    if (event.target instanceof HTMLTextAreaElement) {
      autosizeTextarea(event.target);
      if (event.target.name) draft.answers[event.target.name] = event.target.value;
    }
  });
  autosizeGateTextareas(section);
  return section;
}

function renderGate(run) {
  elements.actionPanel?.classList.toggle("gate-active", Boolean(run.gate));
  if (!run.gate) {
    elements.actionTitle.textContent = "User action";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const symbol = document.createElement("div");
    symbol.className = "empty-symbol";
    symbol.textContent = run.status === "blocked" ? "!" : "✓";
    const title = document.createElement("strong");
    title.textContent = run.status === "blocked" ? "Run needs intervention" : "No operator action required";
    const copy = document.createElement("p");
    copy.textContent = run.status === "blocked"
      ? "Review the errors on this tab, then retry or cancel the run."
      : "The coordinator will surface the next decision here.";
    empty.append(symbol, title, copy);
    elements.action.replaceChildren(empty);
    return;
  }

  elements.actionTitle.textContent = run.gate.title;
  const draft = ensureGateDraft(run.id);
  let node;
  if (run.gate.id === "clarify-brief") {
    node = run.gate.reflect ? renderReflectGate(run, run.gate, draft) : renderFlatBriefGate(run, run.gate, draft);
  } else if (run.gate.id.startsWith("clarify-questions-")) {
    node = renderGrillGate(run, run.gate, draft);
  } else if (run.gate.id.startsWith("specification-approval-")) {
    node = renderSpecificationGate(run, run.gate, draft);
  } else if (run.gate.id === "publish-approval") {
    node = renderPublishGate(run, run.gate, draft);
  } else {
    node = renderQuestionGate(run, run.gate, draft);
  }
  if (draft.gateFeedback) {
    const feedback = document.createElement("div");
    feedback.className = "gate-feedback";
    feedback.textContent = draft.gateFeedback;
    node.prepend(feedback);
    draft.gateFeedback = "";
  }
  elements.action.replaceChildren(node);
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
  if (event.kind?.startsWith("run.blocked") || event.kind?.startsWith("run.stalled")) item.className = "event-error";
  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const message = document.createElement("span");
  message.textContent = event.message;
  item.append(time, message);
  return item;
}

async function loadSettings() {
  settingsState = await request("/api/settings");
  renderSettings();
}

function renderSettings() {
  if (!settingsState) return;
  const config = settingsState.config;
  elements.settingsRuntimeForm.replaceChildren(
    field("Coordinator URL", "coordinatorUrl", config.coordinatorUrl),
    field("Runner image", "runnerImage", config.runnerImage),
    field("Agent deadline (ms)", "agentDeadlineMs", String(config.agentDeadlineMs)),
    field("Default model", "models.default", config.models?.default ?? ""),
    field("Publication remote", "publication.remote", config.publication?.remote ?? "origin"),
    checkboxField("Draft pull requests", "publication.draft", Boolean(config.publication?.draft)),
    settingsSubmit("Save runtime settings", saveRuntimeSettings),
  );
  elements.settingsModelsForm.replaceChildren(
    ...(settingsState.roles || []).flatMap((role) => [field(`${words(role)} model`, `models.${role}`, config.models?.[role] ?? "", false)]),
    settingsSubmit("Save model overrides", saveModelSettings),
  );
  renderGuidanceRoles(settingsState.guidanceRoles || []);
}

function field(label, name, value, required = true) {
  const node = document.createElement("label");
  node.textContent = label;
  const input = document.createElement("input");
  input.name = name;
  input.value = value ?? "";
  if (required) input.required = true;
  node.append(input);
  return node;
}

function checkboxField(label, name, checked) {
  const node = document.createElement("label");
  node.className = "check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.checked = checked;
  const text = document.createElement("span");
  text.innerHTML = `<strong>${label}</strong>`;
  node.append(input, text);
  return node;
}

function settingsSubmit(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary full";
  button.textContent = label;
  button.onclick = () => void handler(button);
  return button;
}

function readNestedForm(form) {
  const values = Object.fromEntries(new FormData(form));
  const config = {};
  for (const [key, value] of Object.entries(values)) {
    const parts = key.split(".");
    let cursor = config;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      cursor[part] = cursor[part] ?? {};
      cursor = cursor[part];
    }
    const leaf = parts.at(-1);
    if (leaf === "draft") cursor[leaf] = value === "on";
    else if (leaf === "agentDeadlineMs") cursor[leaf] = Number(value);
    else cursor[leaf] = String(value).trim();
  }
  return config;
}

async function saveRuntimeSettings(button) {
  button.disabled = true;
  elements.settingsResult.textContent = "Saving…";
  try {
    const config = readNestedForm(elements.settingsRuntimeForm);
    settingsState = await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config }) });
    elements.settingsResult.textContent = "Runtime settings saved.";
    renderSettings();
    await loadSetup();
  } catch (error) {
    elements.settingsResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function saveModelSettings(button) {
  button.disabled = true;
  elements.settingsResult.textContent = "Saving…";
  try {
    const partial = readNestedForm(elements.settingsModelsForm);
    const models = { ...(settingsState.config.models ?? {}), ...(partial.models ?? {}) };
    for (const [role, model] of Object.entries(models)) {
      if (role !== "default" && !String(model ?? "").trim()) delete models[role];
    }
    settingsState = await request("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { models } }) });
    elements.settingsResult.textContent = "Model overrides saved.";
    renderSettings();
  } catch (error) {
    elements.settingsResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderGuidanceRoles(roles) {
  if (!roles.length) {
    elements.guidanceRoles.replaceChildren(Object.assign(document.createElement("div"), { className: "empty-inline", textContent: "No roles found." }));
    return;
  }
  elements.guidanceRoles.replaceChildren(...roles.map((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `guidance-role${entry.role === guidanceRole ? " active" : ""}`;
    button.dataset.role = entry.role;
    const name = document.createElement("span");
    name.textContent = entry.role;
    const source = document.createElement("small");
    source.textContent = entry.hasOverride ? words(entry.source) : "Packaged";
    button.append(name, source);
    button.onclick = () => void selectGuidanceRole(entry.role);
    return button;
  }));
}

async function selectGuidanceRole(role) {
  guidanceRole = role;
  renderGuidanceRoles(settingsState?.guidanceRoles || []);
  elements.guidanceDetail.innerHTML = '<div class="empty-inline">Loading guidance…</div>';
  guidanceDoc = await request(`/api/guidance/roles/${encodeURIComponent(role)}`);
  renderGuidanceDetail();
}

function renderGuidanceDetail() {
  if (!guidanceDoc) return;
  elements.guidanceDetail.replaceChildren();
  const title = document.createElement("h4");
  title.textContent = guidanceDoc.role;
  const meta = document.createElement("p");
  meta.className = "settings-copy";
  meta.textContent = `Source: ${words(guidanceDoc.source)}`;
  const editor = document.createElement("textarea");
  editor.id = "guidance-editor";
  editor.spellcheck = false;
  editor.value = guidanceDoc.body || "";
  const scope = document.createElement("label");
  scope.className = "settings-copy";
  scope.textContent = "Save to ";
  const select = document.createElement("select");
  select.id = "guidance-scope";
  select.append(
    Object.assign(document.createElement("option"), { value: "home", textContent: "Harness home" }),
    Object.assign(document.createElement("option"), { value: "project", textContent: "Selected project" }),
  );
  scope.append(select);
  const actions = document.createElement("div");
  actions.className = "setup-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "primary";
  save.textContent = "Save guidance";
  save.onclick = () => void saveGuidance(save);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "secondary";
  reset.textContent = "Reset override";
  reset.onclick = () => void resetGuidance(reset);
  actions.append(save, reset);
  const preview = document.createElement("details");
  preview.className = "setup-log";
  preview.innerHTML = "<summary>Prompt preview</summary>";
  const pre = document.createElement("pre");
  pre.textContent = guidanceDoc.promptPreview || "";
  preview.append(pre);
  elements.guidanceDetail.append(title, meta, editor, scope, actions, preview);
}

async function saveGuidance(button) {
  if (!guidanceRole) return;
  button.disabled = true;
  elements.settingsResult.textContent = "Saving guidance…";
  try {
    const body = document.querySelector("#guidance-editor")?.value ?? "";
    const scope = document.querySelector("#guidance-scope")?.value ?? "home";
    const payload = { body, scope };
    if (scope === "project") {
      const projectId = elements.projectSelect.value;
      if (!projectId) throw new Error("Select a project in the sidebar before saving project-scoped guidance.");
      payload.projectId = projectId;
    }
    guidanceDoc = await request(`/api/guidance/roles/${encodeURIComponent(guidanceRole)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    settingsState.guidanceRoles = (await request("/api/guidance/roles")).roles;
    renderGuidanceRoles(settingsState.guidanceRoles);
    renderGuidanceDetail();
    elements.settingsResult.textContent = `Saved guidance for ${guidanceRole}.`;
  } catch (error) {
    elements.settingsResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function resetGuidance(button) {
  if (!guidanceRole) return;
  button.disabled = true;
  try {
    const scope = document.querySelector("#guidance-scope")?.value ?? "home";
    const query = scope === "project" && elements.projectSelect.value ? `?projectId=${encodeURIComponent(elements.projectSelect.value)}` : "";
    guidanceDoc = await request(`/api/guidance/roles/${encodeURIComponent(guidanceRole)}${query}`, { method: "DELETE" });
    settingsState.guidanceRoles = (await request("/api/guidance/roles")).roles;
    renderGuidanceRoles(settingsState.guidanceRoles);
    renderGuidanceDetail();
    elements.settingsResult.textContent = `Reset guidance for ${guidanceRole}.`;
  } catch (error) {
    elements.settingsResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function showSettings(tab = settingsTab) {
  settingsTab = tab;
  for (const button of document.querySelectorAll(".settings-tab")) {
    button.classList.toggle("active", button.dataset.settingsTab === tab);
  }
  document.querySelector("#settings-runtime").classList.toggle("hidden", tab !== "runtime");
  document.querySelector("#settings-models").classList.toggle("hidden", tab !== "models");
  document.querySelector("#settings-guidance").classList.toggle("hidden", tab !== "guidance");
  elements.workspaceMain.classList.add("settings-open");
  elements.settingsPanel.classList.remove("hidden");
  void loadSettings().catch((error) => { elements.settingsResult.textContent = error.message; });
}

function hideSettings() {
  elements.workspaceMain.classList.remove("settings-open");
  elements.settingsPanel.classList.add("hidden");
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

elements.projectSelect.onchange = () => {
  preferredBaseBranch = "";
  void loadProjectBranches(elements.projectSelect.value);
};
elements.baseBranchSelect.onchange = () => {
  preferredBaseBranch = elements.baseBranchSelect.value;
};

elements.startForm.onsubmit = async (event) => {
  event.preventDefault();
  const submit = elements.startForm.querySelector("button[type=submit]");
  submit.disabled = true;
  elements.startResult.textContent = "Starting run…";
  try {
    const values = Object.fromEntries(new FormData(elements.startForm));
    const baseBranch = String(values.baseBranch ?? "").trim();
    if (!baseBranch) throw new Error("Choose a base branch.");
    const run = await request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: values.projectId, idea: values.idea, fresh: values.fresh === "on", baseBranch }) });
    elements.ideaInput.value = "";
    autosizeIdeaInput();
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
  elements.ideaInput?.focus({ preventScroll: true });
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
elements.settingsToggle.onclick = () => showSettings("runtime");
elements.settingsClose.onclick = () => hideSettings();
document.querySelectorAll(".settings-tab").forEach((button) => {
  button.addEventListener("click", () => showSettings(button.dataset.settingsTab));
});
document.querySelectorAll(".run-tab").forEach((button) => {
  button.addEventListener("click", () => showRunTab(button.dataset.runTab));
});
showRunTab("overview");

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

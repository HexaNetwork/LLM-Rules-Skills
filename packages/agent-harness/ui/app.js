const runs = document.querySelector("#runs");
const action = document.querySelector("#action");
const runActions = document.querySelector("#run-actions");
const events = document.querySelector("#events");
const diagnostics = document.querySelector("#diagnostics");
const connection = document.querySelector("#connection");
const projectSelect = document.querySelector("#project");
const projectForm = document.querySelector("#add-project");
const projectResult = document.querySelector("#project-result");
const startForm = document.querySelector("#start-run");
const startResult = document.querySelector("#start-result");
let selected;

async function request(url, options) {
  const response = await fetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function loadProjects(selectId) {
  const values = await request("/api/projects");
  projectSelect.replaceChildren(...values.map((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.name} — ${project.repositoryPath}`;
    return option;
  }));
  if (selectId) projectSelect.value = selectId;
  startForm.querySelector("button").disabled = values.length === 0;
}

async function loadRuns() {
  const values = await request("/api/runs");
  runs.replaceChildren(...values.map((run) => {
    const button = document.createElement("button");
    button.textContent = `${run.status} · ${run.currentStep} · ${run.id.slice(0, 8)}`;
    if (run.id === selected) button.classList.add("selected");
    button.onclick = () => selectRun(run.id);
    return button;
  }));
}

async function selectRun(id) {
  selected = id;
  await loadRuns();
  const run = await request(`/api/runs/${id}`);
  diagnostics.textContent = JSON.stringify({ id: run.id, status: run.status, step: run.currentStep, revision: run.revision }, null, 2);
  events.replaceChildren(...run.events.map(eventNode));
  renderRunActions(run);
  if (!run.gate) { action.textContent = run.status === "blocked" ? "Inspect diagnostics, then retry or cancel." : "No operator action is required."; return; }
  const form = document.createElement("form");
  form.append(Object.assign(document.createElement("h3"), { textContent: run.gate.title }));
  for (const question of run.gate.questions) { const label = document.createElement("label"); label.textContent = question.prompt; const textarea = document.createElement("textarea"); textarea.name = question.id; textarea.required = question.required; label.append(textarea); form.append(label); }
  const submit = document.createElement("button"); submit.textContent = "Submit"; form.append(submit);
  form.onsubmit = async (event) => { event.preventDefault(); try { const answers = Object.fromEntries(new FormData(form)); await command(id, "submit-answers", { gateId: run.gate.id, answers }); action.textContent = "Submitted."; } catch (error) { action.textContent = error.message; } };
  action.replaceChildren(form);
}

function renderRunActions(run) {
  runActions.replaceChildren();
  if (["blocked", "stalled"].includes(run.status)) runActions.append(actionButton("Retry", () => command(run.id, "retry-turn")));
  if (!["completed", "cancelled", "failed"].includes(run.status)) runActions.append(actionButton("Cancel", () => command(run.id, "cancel-run"), "danger"));
}

function actionButton(label, handler, className) {
  const button = document.createElement("button");
  button.textContent = label;
  if (className) button.className = className;
  button.onclick = async () => { button.disabled = true; try { await handler(); button.textContent = `${label} requested`; } catch (error) { button.textContent = error.message; button.disabled = false; } };
  return button;
}

function command(runId, kind, payload = {}) {
  return request(`/api/runs/${runId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, payload }) });
}

projectForm.onsubmit = async (event) => {
  event.preventDefault(); projectResult.textContent = "Adding…";
  try {
    const body = Object.fromEntries(new FormData(projectForm));
    const project = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await loadProjects(project.id); projectResult.textContent = `Added ${project.name}.`;
  } catch (error) { projectResult.textContent = error.message; }
};

startForm.onsubmit = async (event) => {
  event.preventDefault(); startResult.textContent = "Starting…";
  try {
    const values = Object.fromEntries(new FormData(startForm));
    const run = await request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: values.projectId, idea: values.idea, fresh: values.fresh === "on" }) });
    startForm.querySelector("textarea").value = ""; startResult.textContent = `Started ${run.id.slice(0, 8)}.`; await loadRuns(); await selectRun(run.id);
  } catch (error) { startResult.textContent = error.message; }
};

function eventNode(event) { const item = document.createElement("li"); item.textContent = `${new Date(event.createdAt).toLocaleTimeString()} ${event.message}`; return item; }
const source = new EventSource("/api/events"); source.onopen = () => connection.textContent = "live"; source.onerror = () => connection.textContent = "reconnecting"; source.onmessage = (message) => { const event = JSON.parse(message.data); if (event.runId === selected) events.append(eventNode(event)); void loadRuns(); };
void Promise.all([loadProjects(), loadRuns()]).catch((error) => { connection.textContent = error.message; });

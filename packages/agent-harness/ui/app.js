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
};

let selected;
let projects = new Map();

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
  elements.startForm.querySelector("button").disabled = values.length === 0;
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
  renderRunActions(run);
  renderGate(run);
  closeMobileNav();
}

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
    submit.disabled = projects.size === 0;
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
  if (event.runId === selected) {
    const previousEmpty = elements.events.querySelector(".empty-event");
    if (previousEmpty) previousEmpty.remove();
    elements.events.append(eventNode(event));
    elements.events.scrollTop = elements.events.scrollHeight;
  }
  void loadRuns();
};

void Promise.all([loadProjects(), loadRuns()]).catch((error) => {
  elements.connection.className = "connection reconnecting";
  elements.connection.lastChild.textContent = ` ${error.message}`;
});

const runs = document.querySelector("#runs");
const action = document.querySelector("#action");
const events = document.querySelector("#events");
const diagnostics = document.querySelector("#diagnostics");
const connection = document.querySelector("#connection");
let selected;

async function loadRuns() {
  const values = await fetch("/api/runs").then((response) => response.json());
  runs.replaceChildren(...values.map((run) => {
    const button = document.createElement("button");
    button.textContent = `${run.status} · ${run.currentStep} · ${run.id.slice(0, 8)}`;
    button.onclick = () => selectRun(run.id);
    return button;
  }));
}

async function selectRun(id) {
  selected = id;
  const run = await fetch(`/api/runs/${id}`).then((response) => response.json());
  diagnostics.textContent = JSON.stringify({ id: run.id, status: run.status, step: run.currentStep, revision: run.revision }, null, 2);
  events.replaceChildren(...run.events.map(eventNode));
  if (!run.gate) { action.textContent = run.status === "blocked" ? "Inspect diagnostics, then retry or cancel." : "No operator action is required."; return; }
  const form = document.createElement("form");
  form.append(Object.assign(document.createElement("h3"), { textContent: run.gate.title }));
  for (const question of run.gate.questions) { const label = document.createElement("label"); label.textContent = question.prompt; const textarea = document.createElement("textarea"); textarea.name = question.id; textarea.required = question.required; label.append(textarea); form.append(label); }
  const submit = document.createElement("button"); submit.textContent = "Submit"; form.append(submit);
  form.onsubmit = async (event) => { event.preventDefault(); const answers = Object.fromEntries(new FormData(form)); await fetch(`/api/runs/${id}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "submit-answers", payload: { gateId: run.gate.id, answers } }) }); action.textContent = "Submitted."; };
  action.replaceChildren(form);
}

function eventNode(event) { const item = document.createElement("li"); item.textContent = `${new Date(event.createdAt).toLocaleTimeString()} ${event.message}`; return item; }
const source = new EventSource("/api/events"); source.onopen = () => connection.textContent = "live"; source.onerror = () => connection.textContent = "reconnecting"; source.onmessage = (message) => { const event = JSON.parse(message.data); if (event.runId === selected) events.append(eventNode(event)); void loadRuns(); };
void loadRuns();

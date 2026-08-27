import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentTurnRequest, AgentTurnResult, ArtifactRecord, DurableCommand, EventRecord, JsonObject, Project, Run, RunError, RunStatus, StepTransition, TurnRecord, UserAnswers, UserGate } from "./types.js";

const SCHEMA_VERSION = 1;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export class Store {
  readonly artifactsRoot: string;
  private readonly db: DatabaseSync;

  private constructor(readonly home: string, db: DatabaseSync) {
    this.db = db;
    this.artifactsRoot = path.join(home, "artifacts");
  }

  static async open(home: string): Promise<Store> {
    await mkdir(path.join(home, "artifacts"), { recursive: true });
    const db = new DatabaseSync(path.join(home, "control.sqlite"));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const store = new Store(home, db);
    store.initialize();
    return store;
  }

  close(): void { this.db.close(); }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, repository_path TEXT NOT NULL UNIQUE,
        base_branch TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), workflow_id TEXT NOT NULL,
        current_step TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
        input_json TEXT NOT NULL, effective_config_json TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, priority INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT, lease_expires_at TEXT, error TEXT, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS commands_queue ON commands(status, priority DESC, created_at);
      CREATE TABLE IF NOT EXISTS step_states (
        run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL, state_json TEXT NOT NULL,
        output_json TEXT, transition_json TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL,
        action_key TEXT NOT NULL UNIQUE, session_id TEXT, request_json TEXT NOT NULL, output_json TEXT,
        usage_json TEXT, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gates (
        id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL,
        gate_json TEXT NOT NULL, answers_json TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, answered_at TEXT
        , PRIMARY KEY(run_id,id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
        data_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL,
        name TEXT NOT NULL, path TEXT NOT NULL, media_type TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(run_id, step_id, name)
      );
      CREATE TABLE IF NOT EXISTS actions (
        action_key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL,
        request_json TEXT NOT NULL, result_json TEXT, status TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
    if (row && Number(row.value) !== SCHEMA_VERSION) throw new Error(`Unsupported harness database schema ${row.value}. Run \"agent-harness reset-home\" for the development home.`);
    if (!row) this.db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
  }

  addProject(input: { name: string; repositoryPath: string; baseBranch: string; settings?: JsonObject }): Project {
    const project: Project = { id: randomUUID(), name: input.name, repositoryPath: path.resolve(input.repositoryPath), baseBranch: input.baseBranch, createdAt: now() };
    this.db.prepare("INSERT INTO projects(id,name,repository_path,base_branch,settings_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(project.id, project.name, project.repositoryPath, project.baseBranch, json(input.settings ?? {}), project.createdAt);
    return project;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM projects ORDER BY created_at").all() as Row[]).map(projectFromRow);
  }

  getProject(id: string): Project {
    const row = this.db.prepare("SELECT * FROM projects WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Project not found: ${id}`);
    return projectFromRow(row);
  }

  projectSettings(id: string): JsonObject {
    const row = this.db.prepare("SELECT settings_json FROM projects WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Project not found: ${id}`);
    return parse(row.settings_json);
  }

  createRun(input: { projectId: string; workflowId: string; firstStep: string; input: JsonObject; effectiveConfig: JsonObject }): Run {
    const stamp = now();
    const run: Run = { id: randomUUID(), projectId: input.projectId, workflowId: input.workflowId, currentStep: input.firstStep, status: "queued", revision: 0, input: input.input, createdAt: stamp, updatedAt: stamp };
    this.transaction(() => {
      this.db.prepare("INSERT INTO runs(id,project_id,workflow_id,current_step,status,input_json,effective_config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(run.id, run.projectId, run.workflowId, run.currentStep, run.status, json(run.input), json(input.effectiveConfig), stamp, stamp);
      this.appendEvent(run.id, "run.created", "Run created", { workflowId: run.workflowId });
    });
    return run;
  }

  getRun(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error(`Run not found: ${id}`);
    return runFromRow(row);
  }

  listRuns(): Run[] { return (this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as Row[]).map(runFromRow); }
  effectiveConfig(runId: string): JsonObject { const row = this.db.prepare("SELECT effective_config_json FROM runs WHERE id=?").get(runId) as Row; return parse(row.effective_config_json); }

  setRunStatus(runId: string, status: RunStatus, message?: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE runs SET status=?,revision=revision+1,updated_at=? WHERE id=?").run(status, now(), runId);
      if (message) this.appendEvent(runId, `run.${status}`, message);
    });
  }

  outputs(runId: string): Record<string, unknown> {
    const rows = this.db.prepare("SELECT step_id,output_json FROM step_states WHERE run_id=? AND output_json IS NOT NULL").all(runId) as Row[];
    return Object.fromEntries(rows.map((row) => [String(row.step_id), parse(row.output_json)]));
  }

  enqueueCommand(runId: string, kind: string, payload: JsonObject, idempotencyKey: string, priority = 0): DurableCommand {
    const existing = this.db.prepare("SELECT * FROM commands WHERE idempotency_key=?").get(idempotencyKey) as Row | undefined;
    if (existing) return commandFromRow(existing);
    const command: DurableCommand = { id: randomUUID(), runId, kind, payload, status: "queued", idempotencyKey, priority, createdAt: now() };
    this.db.prepare("INSERT INTO commands(id,run_id,kind,payload_json,status,idempotency_key,priority,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(command.id, runId, kind, json(payload), command.status, idempotencyKey, priority, command.createdAt);
    this.appendEvent(runId, "command.queued", `Queued ${kind}`, { commandId: command.id });
    return command;
  }

  leaseNextCommand(owner: string, leaseMs: number): DurableCommand | undefined {
    return this.transaction(() => {
      const stamp = now();
      this.db.prepare("UPDATE commands SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE status='leased' AND lease_expires_at < ?").run(stamp);
      const row = this.db.prepare("SELECT * FROM commands WHERE status='queued' ORDER BY priority DESC,created_at LIMIT 1").get() as Row | undefined;
      if (!row) return undefined;
      const expires = new Date(Date.now() + leaseMs).toISOString();
      const changed = this.db.prepare("UPDATE commands SET status='leased',lease_owner=?,lease_expires_at=? WHERE id=? AND status='queued'").run(owner, expires, String(row.id)).changes;
      if (!changed) return undefined;
      this.db.prepare("UPDATE runs SET lease_owner=?,lease_expires_at=? WHERE id=?").run(owner, expires, String(row.run_id));
      return commandFromRow({ ...row, status: "leased", lease_owner: owner, lease_expires_at: expires });
    });
  }

  leaseNextCancellation(owner: string, leaseMs: number): DurableCommand | undefined {
    return this.transaction(() => {
      const stamp = now();
      this.db.prepare("UPDATE commands SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE kind='cancel-run' AND status='leased' AND lease_expires_at < ?").run(stamp);
      const row = this.db.prepare("SELECT * FROM commands WHERE status='queued' AND kind='cancel-run' ORDER BY priority DESC,created_at LIMIT 1").get() as Row | undefined;
      if (!row) return undefined;
      const expires = new Date(Date.now() + leaseMs).toISOString();
      const changed = this.db.prepare("UPDATE commands SET status='leased',lease_owner=?,lease_expires_at=? WHERE id=? AND status='queued'").run(owner, expires, String(row.id)).changes;
      return changed ? commandFromRow({ ...row, status: "leased", lease_owner: owner, lease_expires_at: expires }) : undefined;
    });
  }

  renewLease(commandId: string, owner: string, leaseMs: number): boolean {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    return this.db.prepare("UPDATE commands SET lease_expires_at=? WHERE id=? AND lease_owner=? AND status='leased'").run(expires, commandId, owner).changes === 1;
  }

  finishCommand(commandId: string, owner: string, error?: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT run_id FROM commands WHERE id=? AND lease_owner=?").get(commandId, owner) as Row | undefined;
      if (!row) throw new Error(`Command lease lost: ${commandId}`);
      this.db.prepare("UPDATE commands SET status=?,error=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?")
        .run(error ? "failed" : "completed", error ?? null, now(), commandId);
      this.db.prepare("UPDATE runs SET lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND lease_owner=?").run(String(row.run_id), owner);
    });
  }

  saveTransition(runId: string, stepId: string, state: unknown, transition: StepTransition<unknown, unknown>, status: RunStatus): void {
    const stamp = now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO step_states(run_id,step_id,state_json,transition_json,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(run_id,step_id) DO UPDATE SET state_json=excluded.state_json,transition_json=excluded.transition_json,updated_at=excluded.updated_at`)
        .run(runId, stepId, json(state), json(transition), stamp);
      this.db.prepare("UPDATE runs SET status=?,revision=revision+1,updated_at=? WHERE id=?").run(status, stamp, runId);
      this.appendEvent(runId, `step.${transition.type}`, `${stepId}: ${transition.type}`, { stepId });
    });
  }

  stepRecord(runId: string, stepId: string): { state: unknown; output?: unknown; transition?: StepTransition<unknown, unknown> } | undefined {
    const row = this.db.prepare("SELECT * FROM step_states WHERE run_id=? AND step_id=?").get(runId, stepId) as Row | undefined;
    return row ? { state: parse(row.state_json), output: row.output_json ? parse(row.output_json) : undefined, transition: row.transition_json ? parse(row.transition_json) : undefined } : undefined;
  }

  completeStep(runId: string, stepId: string, output: unknown, nextStep?: string): void {
    const stamp = now();
    this.transaction(() => {
      this.db.prepare("UPDATE step_states SET output_json=?,transition_json=?,updated_at=? WHERE run_id=? AND step_id=?")
        .run(json(output), json({ type: "complete", output }), stamp, runId, stepId);
      this.db.prepare("UPDATE runs SET current_step=?,status=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(nextStep ?? stepId, nextStep ? "queued" : "completed", stamp, runId);
      this.appendEvent(runId, "step.completed", `${stepId} completed`, { stepId, nextStep });
    });
  }

  previousOutput(runId: string, workflowSteps: readonly string[], currentStep: string): unknown {
    const index = workflowSteps.indexOf(currentStep);
    if (index <= 0) return this.getRun(runId).input;
    return this.stepRecord(runId, workflowSteps[index - 1]!)?.output;
  }

  createTurn(runId: string, stepId: string, actionKey: string, request: AgentTurnRequest): AgentTurnRequest {
    const existing = this.db.prepare("SELECT request_json FROM turns WHERE action_key=?").get(actionKey) as Row | undefined;
    if (existing) return parse(existing.request_json);
    const stamp = now();
    this.db.prepare("INSERT INTO turns(id,run_id,step_id,action_key,session_id,request_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(request.turnId, runId, stepId, actionKey, request.sessionId ?? null, json(request), "starting", stamp, stamp);
    return request;
  }

  turnResult(actionKey: string): AgentTurnResult | undefined {
    const row = this.db.prepare("SELECT id,session_id,output_json,usage_json FROM turns WHERE action_key=? AND status='completed'").get(actionKey) as Row | undefined;
    return row ? { turnId: String(row.id), sessionId: String(row.session_id), output: parse(row.output_json), usage: row.usage_json ? parse(row.usage_json) : undefined } : undefined;
  }

  finishTurn(actionKey: string, result: AgentTurnResult): void {
    this.db.prepare("UPDATE turns SET session_id=?,output_json=?,usage_json=?,status='completed',updated_at=? WHERE action_key=?")
      .run(result.sessionId, json(result.output), json(result.usage), now(), actionKey);
  }
  failTurn(actionKey: string, status: "stalled" | "blocked", error: string): void { this.db.prepare("UPDATE turns SET status=?,error=?,updated_at=? WHERE action_key=?").run(status, error, now(), actionKey); }

  turns(runId?: string): TurnRecord[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM turns WHERE run_id=? ORDER BY created_at").all(runId)
      : this.db.prepare("SELECT * FROM turns ORDER BY created_at").all();
    return (rows as Row[]).map(turnFromRow);
  }

  saveGate(runId: string, stepId: string, gate: UserGate): void {
    this.db.prepare(`INSERT INTO gates(id,run_id,step_id,gate_json,status,created_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(run_id,id) DO UPDATE SET gate_json=excluded.gate_json,status='open'`)
      .run(gate.id, runId, stepId, json(gate), "open", now());
  }
  answerGate(runId: string, answers: UserAnswers): void {
    const changed = this.db.prepare("UPDATE gates SET answers_json=?,status='answered',answered_at=? WHERE id=? AND run_id=? AND status='open'").run(json(answers), now(), answers.gateId, runId).changes;
    if (!changed) throw new Error(`Gate is not open: ${answers.gateId}`);
  }
  openGate(runId: string): UserGate | undefined { const row = this.db.prepare("SELECT gate_json FROM gates WHERE run_id=? AND status='open' ORDER BY created_at DESC LIMIT 1").get(runId) as Row | undefined; return row ? parse(row.gate_json) : undefined; }

  recordAction(runId: string, key: string, kind: string, request: unknown): unknown | undefined {
    const row = this.db.prepare("SELECT result_json,status FROM actions WHERE action_key=?").get(key) as Row | undefined;
    if (row?.status === "completed") return parse(row.result_json);
    if (!row) this.db.prepare("INSERT INTO actions(action_key,run_id,kind,request_json,status,updated_at) VALUES(?,?,?,?,?,?)").run(key, runId, kind, json(request), "working", now());
    return undefined;
  }
  finishAction(key: string, result: unknown): void { this.db.prepare("UPDATE actions SET result_json=?,status='completed',updated_at=? WHERE action_key=?").run(json(result), now(), key); }

  appendEvent(runId: string | undefined, kind: string, message: string, data?: unknown): EventRecord {
    const stamp = now();
    const result = this.db.prepare("INSERT INTO events(run_id,kind,message,data_json,created_at) VALUES(?,?,?,?,?)").run(runId ?? null, kind, message, json(data), stamp);
    return { id: Number(result.lastInsertRowid), runId, kind, message, data, createdAt: stamp };
  }
  events(after = 0, runId?: string): EventRecord[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM events WHERE id>? AND run_id=? ORDER BY id LIMIT 500").all(after, runId)
      : this.db.prepare("SELECT * FROM events WHERE id>? ORDER BY id LIMIT 500").all(after);
    return (rows as Row[]).map((row) => ({ id: Number(row.id), runId: row.run_id ? String(row.run_id) : undefined, kind: String(row.kind), message: String(row.message), data: row.data_json ? parse(row.data_json) : undefined, createdAt: String(row.created_at) }));
  }

  async writeArtifact(runId: string, stepId: string, name: string, content: string, mediaType = "text/plain"): Promise<string> {
    const directory = path.join(this.artifactsRoot, runId, stepId);
    await mkdir(directory, { recursive: true });
    const target = path.join(directory, name);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(temporary, target);
    this.db.prepare(`INSERT INTO artifacts(id,run_id,step_id,name,path,media_type,created_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(run_id,step_id,name) DO UPDATE SET path=excluded.path,media_type=excluded.media_type,created_at=excluded.created_at`)
      .run(randomUUID(), runId, stepId, name, target, mediaType, now());
    return target;
  }
  async readArtifact(runId: string, stepId: string, name: string): Promise<string> { const row = this.db.prepare("SELECT path FROM artifacts WHERE run_id=? AND step_id=? AND name=?").get(runId, stepId, name) as Row | undefined; if (!row) throw new Error(`Artifact not found: ${name}`); return readFile(String(row.path), "utf8"); }
  artifacts(runId: string): ArtifactRecord[] {
    return (this.db.prepare("SELECT * FROM artifacts WHERE run_id=? ORDER BY step_id,name").all(runId) as Row[]).map((row) => ({
      id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), name: String(row.name), path: String(row.path), mediaType: String(row.media_type), createdAt: String(row.created_at),
    }));
  }

  runErrors(runId: string): RunError[] {
    const errors: RunError[] = [];
    for (const turn of this.turns(runId)) {
      if (!turn.error) continue;
      errors.push({
        id: turn.actionKey,
        source: "agent",
        stepId: turn.stepId,
        role: turn.role,
        message: turn.error,
        createdAt: turn.updatedAt,
      });
    }
    const stepRows = this.db.prepare("SELECT step_id,transition_json,updated_at FROM step_states WHERE run_id=?").all(runId) as Row[];
    for (const row of stepRows) {
      const transition = row.transition_json ? parse<StepTransition<unknown, unknown>>(row.transition_json) : undefined;
      if (transition?.type !== "blocked") continue;
      errors.push({
        id: `${runId}/${String(row.step_id)}/blocked`,
        source: "step",
        stepId: String(row.step_id),
        message: transition.error.message,
        detail: transition.error.detail,
        createdAt: String(row.updated_at),
      });
    }
    for (const row of this.db.prepare("SELECT id,error,completed_at,created_at FROM commands WHERE run_id=? AND error IS NOT NULL ORDER BY completed_at DESC").all(runId) as Row[]) {
      errors.push({
        id: `command:${String(row.id)}`,
        source: "command",
        message: String(row.error),
        createdAt: String(row.completed_at ?? row.created_at),
      });
    }
    const run = this.getRun(runId);
    if (["blocked", "stalled"].includes(run.status)) {
      const latest = this.db.prepare("SELECT message,created_at FROM events WHERE run_id=? AND kind IN ('run.blocked','run.stalled') ORDER BY id DESC LIMIT 1").get(runId) as Row | undefined;
      if (latest && !errors.some((entry) => entry.message === String(latest.message))) {
        errors.unshift({
          id: `${runId}/status`,
          source: "run",
          stepId: run.currentStep,
          message: String(latest.message),
          createdAt: String(latest.created_at),
        });
      }
    }
    return errors.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

type Row = Record<string, unknown>;
function projectFromRow(row: Row): Project { return { id: String(row.id), name: String(row.name), repositoryPath: String(row.repository_path), baseBranch: String(row.base_branch), createdAt: String(row.created_at) }; }
function runFromRow(row: Row): Run { return { id: String(row.id), projectId: String(row.project_id), workflowId: String(row.workflow_id), currentStep: String(row.current_step), status: String(row.status) as RunStatus, revision: Number(row.revision), input: parse(row.input_json), createdAt: String(row.created_at), updatedAt: String(row.updated_at) }; }
function commandFromRow(row: Row): DurableCommand { return { id: String(row.id), runId: String(row.run_id), kind: String(row.kind), payload: parse(row.payload_json), status: String(row.status) as DurableCommand["status"], idempotencyKey: String(row.idempotency_key), priority: Number(row.priority), leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined, leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : undefined, createdAt: String(row.created_at) }; }
function turnFromRow(row: Row): TurnRecord {
  const request = parse<AgentTurnRequest>(row.request_json);
  return { id: String(row.id), runId: String(row.run_id), stepId: String(row.step_id), actionKey: String(row.action_key), role: request.role, sessionId: row.session_id ? String(row.session_id) : undefined, request, output: row.output_json ? parse(row.output_json) : undefined, usage: row.usage_json ? parse(row.usage_json) : undefined, status: String(row.status) as TurnRecord["status"], attempt: Number(row.attempt), error: row.error ? String(row.error) : undefined, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

# Lean agent harness rebuild

## Status

Proposed clean-slate replacement of `@hexanetwork/agent-harness`.

This plan is intentionally destructive. There is one user, old harness runs do
not need to survive, and no compatibility layer will be built. The package name,
CLI name, and product goal stay; the implementation and durable state format do
not.

## Mandate

Build a harness that reliably takes an idea or ticket to a reviewed, verified,
published change in an existing or fresh project.

The system must be:

- container-only for agent and project command execution;
- project-language neutral;
- resumable at every agent and human boundary;
- single-writer and idempotent;
- composed from self-contained workflow steps;
- explicit when blocked, never silently downgraded;
- small enough that one person can understand the complete control flow;
- free of old-run readers, migrations, alternate runtimes, feature flags, and
  compatibility adapters.

The rebuild is successful when a complete live run can be interrupted at any
point, restarted, and continued without repeating completed work or requiring
manual state repair.

## Product boundary

### The harness owns

- project registration;
- fresh-project creation;
- per-run Git worktrees;
- language-neutral environment planning;
- OCI image build and cache;
- run-container creation and replacement;
- agent session start and resume;
- workflow state and user gates;
- project setup and command execution;
- verification, commit, push, and pull-request creation;
- durable audit events and concise diagnostics;
- one local dashboard and one CLI client.

### The harness does not own

- language-specific project detection code;
- hard-coded Node, Java, Python, Gradle, Maven, npm, or other project setup;
- agent-driven mutation of harness source or the shared runner image;
- automatic infrastructure repair;
- multiple orchestration/plugin systems;
- migration of old harness state;
- execution outside containers;
- a production fake-agent mode;
- hidden fallback from live execution to fake execution;
- project-specific workflow forks in harness code.

## Operator journeys

### Existing project

1. Register a repository and select a base branch.
2. Create a detached per-run worktree.
3. Start the clarification and specification workflow in the neutral runner.
4. Resolve a project environment from repository evidence and confirmed intent.
5. Build or reuse the environment image and run setup/health checks.
6. Implement, review, verify, and commit bounded tasks in the run container.
7. Run scenario and final validation.
8. Push a delivery branch and open a pull request.

### Fresh project

1. Register an empty directory or create a new project registration.
2. Create an empty per-run worktree/repository.
3. Clarify the product intent and select the stack through normal user gates.
4. Produce an environment specification from the confirmed plan.
5. Build the environment image.
6. Scaffold the project inside the run worktree.
7. Continue through implementation, validation, and publication exactly like an
   existing project.

Fresh projects do not receive a language-packed bootstrap image. The bootstrap
contains only the agent runner and generic operating-system tools.

## Target topology

```text
Browser / CLI
      |
      | short commands; never waits for an agent turn
      v
Single coordinator process
      |-- HTTP API + server-sent events
      |-- durable command queue
      |-- one lease per run
      |-- workflow engine
      |-- SQLite control-plane state
      |-- Git and Docker control
      |
      v
One replaceable container per active run
      |-- harness agent runner
      |-- generated project environment
      |-- /workspace -> run worktree
      `-- project commands and agent tools
```

There is one coordinator. The dashboard and CLI do not boot their own lifecycle
instances. The CLI talks to the coordinator API. If the coordinator is not
running, the CLI reports that fact and exits.

The host retains Docker, Git, durable state, and publication credentials. Only
the run worktree and the Cursor credential enter the run container. The Docker
socket, harness database, control checkout, sibling runs, and publication token
never enter it.

## Runtime components

Use ordinary TypeScript modules and constructor injection. Remove Cordis and the
plugin loader. The production runtime should have these modules only:

1. `Coordinator` — owns startup, shutdown, queue consumption, and per-run leases.
2. `Store` — owns SQLite transactions and artifact paths.
3. `WorkflowEngine` — applies generic step transitions.
4. `ContainerRuntime` — builds images and creates, executes in, inspects, and
   destroys run containers.
5. `AgentRuntime` — starts/resumes Cursor sessions and persists turn results.
6. `EnvironmentManager` — resolves, validates, builds, sets up, and health-checks
   project environments.
7. `GitRuntime` — owns worktrees, commits, branches, pushes, and pull requests.
8. `ApiServer` — validates short commands and streams events.
9. `Workflows` — the product-specific step definitions described below.

No module registry, dynamic plugin discovery, trusted-row model, dual providers,
or service-locator context is needed.

## Durable state

Use one SQLite database under the harness home. Store large prompts, outputs,
logs, and generated documents as files addressed from database rows.

Minimum tables:

| Table | Purpose |
| --- | --- |
| `projects` | Repository registrations and external project settings |
| `runs` | Immutable identity, current workflow/step, status, and revision |
| `commands` | Durable operator commands and their processing status |
| `step_states` | Current JSON state for each workflow step |
| `turns` | Agent turn identity, session id, request, output, and status |
| `gates` | Questions and exact submitted answers |
| `events` | Ordered operator-facing lifecycle and diagnostic events |
| `artifacts` | Names and paths for generated documents and evidence |

Every state change occurs in one transaction. A transaction may enqueue the next
command, but external work never occurs inside a transaction.

There is no schema migration framework. The rebuilt package accepts only its new
database. At cutover, delete the old harness home. During development, a schema
mismatch fails with one instruction: reset the development harness home.

## Command and lease model

HTTP mutations append a command and return `202 Accepted` immediately. Examples:

- `start-run`
- `submit-answers`
- `retry-turn`
- `cancel-run`
- `publish-run`

The coordinator leases a command and the associated run. Only the lease holder
may transition that run. Leases contain an owner id and expiry and are renewed by
the coordinator. On restart, expired leases are reclaimed.

Each external action has a stable idempotency key:

```text
runId / stepId / actionKind / ordinal
```

Reprocessing a command reconciles that action rather than creating another
agent turn, commit, image build, push, or pull request.

## Workflow step contract

Each step is a self-contained persisted state machine. It owns its input,
internal state, agent turns, user gates, validation, and output. It does not call
another step or directly update the run's current-step pointer.

```ts
type StepTransition<State, Output> =
  | { type: "invoke-agent"; state: State; request: AgentTurnRequest }
  | { type: "run-command"; state: State; request: ContainerCommand }
  | { type: "await-user"; state: State; gate: UserGate }
  | { type: "complete"; output: Output }
  | { type: "blocked"; error: StepError };

interface WorkflowStep<Input, State, Output> {
  readonly id: string;
  start(input: Input): StepTransition<State, Output>;
  onAgent(state: State, result: AgentTurnResult): StepTransition<State, Output>;
  onCommand(state: State, result: CommandResult): StepTransition<State, Output>;
  onUser(state: State, answers: UserAnswers): StepTransition<State, Output>;
}
```

Handlers are pure apart from schema validation. The engine persists the returned
transition and performs the requested external action. A step cannot access the
database, Docker, Git, the dashboard, or global lifecycle state.

The engine performs at most one external action per leased command. Completing
one step enqueues entry into the next step instead of recursively running it in
the same HTTP request or call stack.

## Complete workflow

Replace the current thirteen-phase default workflow with six cohesive steps.
These are still bounded and resumable; consolidation removes artificial phase
handoffs without creating a monolith.

### 1. Clarify

Owns the current reflect and grill behavior:

- restate the idea/ticket;
- identify assumptions, scope, users, and unknowns;
- show an editable brief gate;
- start one griller session;
- present structured question batches;
- submit exact answers back to the same conversation;
- repeat until the griller explicitly reports no unresolved material unknowns;
- produce `ClarifiedBrief`.

The fog register is step state, not global run state. Questions have one current
shape; remove legacy `choices`, `recommended`, and alternate field parsing.

### 2. Specify

Owns glossary, plan, PRD, scenarios, and approval:

- create the shared vocabulary needed by the work;
- produce an implementation plan;
- produce the concise product/technical requirements;
- produce acceptance scenarios;
- show one editable approval gate;
- send requested changes back to the appropriate persisted session;
- produce `ApprovedSpecification`.

Documents remain separate artifacts, but their orchestration is one step.

### 3. Provision environment

Owns environment resolution for both existing and fresh projects:

- prefer an explicit external project environment specification when present;
- otherwise invoke an environment-planner agent in the neutral runner with the
  repository mounted read-only and the approved specification;
- produce one strict `EnvironmentSpec`;
- validate the spec against generic container policy;
- build/reuse an image keyed by the complete spec and runner-image digest;
- start the run container;
- run setup commands;
- run health checks;
- persist the spec, build log, image digest, and health evidence;
- produce `ReadyEnvironment`.

The host has no manifest-to-language switch statements. The environment planner
may infer any toolchain from repository evidence or a fresh-project plan.

```ts
type EnvironmentSpec = {
  containerfile: string;
  setupCommands: string[];
  healthcheckCommands: string[];
  caches: Array<{ name: string; containerPath: string }>;
};
```

The generated Containerfile must extend the language-neutral harness runner
base. It installs the selected project toolchain as project data, not harness
logic. Generated specs live in the external run artifacts unless the operator
explicitly chooses to commit one to the project.

On failure, show the failed build/setup command and bounded log. Retry reruns the
same spec. Changing the spec is an explicit new environment-planning turn; there
is no image-fixer role and no mutation of the shared runner Dockerfile.

### 4. Implement

Owns slicing and the per-task loop:

- create ordered, bounded tasks from the approved specification;
- for a fresh project, include scaffolding as the first task;
- start one implementer session per task;
- run the task's relevant verification command in the run container;
- start an independent reviewer session;
- send verification or review findings back to the implementer session;
- repeat within one configured attempt limit;
- commit an approved task using host Git;
- move to the next task;
- produce `ImplementedChange`.

Task state, attempt counts, verification evidence, implementer session id, and
reviewer session id belong to this step. Reviewers never share the implementer
conversation.

### 5. Validate

Owns scenario testing, optional coverage, repair, and final review:

- execute the approved acceptance scenarios;
- run the project's configured full verification commands;
- run coverage only when the approved specification requires it;
- obtain an independent final review;
- if findings are actionable, resume a bounded final-repair implementer turn;
- rerun affected validation and final review;
- produce `ValidatedChange` with exact command evidence.

Remove the separate `scenario-test`, `crystallize`, and `final-review` lifecycle
phases. They are internal states of this step.

Environment failures never enter an implementation repair loop. They transition
back to an explicit environment gate with diagnostics.

### 6. Publish

Owns deterministic publication:

- require a clean worktree and successful `ValidatedChange`;
- generate editable PR title/body from existing artifacts;
- create the delivery branch;
- push exactly once;
- create or reconcile exactly one pull request;
- record branch, commit, and pull-request URL;
- destroy the run container;
- produce `PublishedChange` and complete the run.

Git push and PR creation are idempotent host operations. An agent may draft text,
but it never receives publication credentials or runs publication commands.

### Ticket workflow

Do not retain a second partial state machine. A ticket is an alternate workflow
definition using the same steps with pre-supplied inputs:

```text
clarify -> specify -> provision-environment -> implement -> validate -> publish
```

Steps may complete immediately when their required approved artifact was
supplied at run creation. This keeps one execution model.

## Agent turn protocol

An agent turn has one canonical request and one canonical result envelope. Do
not accept Markdown fences, alternate legacy JSON, aliases, or free-form success
objects.

```ts
type AgentTurnRequest = {
  turnId: string;
  role: string;
  sessionId?: string;
  prompt: string;
  outputSchema: JsonSchema;
};

type AgentTurnResult = {
  turnId: string;
  sessionId: string;
  output: unknown;
  usage?: Usage;
};
```

Persist the request before invocation. Persist the structured result immediately
when received, before stream disposal, usage lookup, or container cleanup. Once
the result is durable, cleanup failure cannot change the turn to failed.

For conversational steps, persist the provider session id explicitly in step
state. Resume that session for the next turn. If the provider can no longer
resume it, create a new session using the persisted canonical prompt plus the
step's exact prior questions and answers. This is the sole recovery behavior,
not a provider-specific compatibility branch.

Structured-output failure returns to the same session with validation errors and
one bounded correction attempt. Exhaustion blocks the step with the raw output
available for inspection.

## Timeout, cancellation, and recovery

One owner controls the agent deadline: the coordinator. Remove nested host,
Docker-process, SDK, disposal, stream, and usage-reconciliation deadlines from
the critical path.

Track these states:

- `queued`
- `starting`
- `working`
- `awaiting_user`
- `stalled`
- `blocked`
- `cancelled`
- `completed`

Heartbeats update observability but do not create another state machine. A turn
deadline stops the worker process and marks the turn `stalled`; it does not
delete durable state. Retry uses the same turn id and reconciles provider state
before starting anything new.

Cancellation is a durable high-priority command. The coordinator records it,
terminates the current worker, destroys the run container, and marks the run
cancelled. Repeating cancellation is harmless.

On coordinator startup:

1. reclaim expired leases;
2. reconcile nonterminal turns by stable turn id;
3. consume any durable result already received;
4. recreate missing run containers from `EnvironmentSpec` when needed;
5. continue queued commands.

Recovery never converts a durable successful result into a blocked run merely
because a process disappeared afterward.

## Container and environment rules

### Neutral runner image

The shared runner image contains only:

- the Cursor agent runtime;
- the harness worker protocol;
- Git, a shell, CA certificates, and basic filesystem/process tools;
- a non-root user and `/workspace` mount point.

It contains no project language or build system. A runtime needed internally by
the Cursor SDK is part of the harness implementation and must not drive project
environment decisions.

### Project image

Every project image extends the runner base through the generated
`EnvironmentSpec`. The spec may install any project toolchain. The coordinator
does not interpret those commands beyond policy validation and execution.

### Build and cache

- Build the runner image during explicit install/update, not ordinary launch.
- Tag it by package version and record its immutable digest.
- Cache project images by runner digest plus normalized environment-spec hash.
- Use only spec-declared named caches.
- Never mount arbitrary host cache directories.
- Never rebuild because the dashboard opened.
- Never let an agent overwrite the shared runner Dockerfile.

### Health

A run becomes executable only after container creation, setup, and every health
check succeeds. Missing Docker, credentials, image, or health evidence is a
visible startup failure. It never selects a fake or host-local runtime.

## API and UI

Keep the UI focused on five surfaces:

1. Projects and new run.
2. Current run status and the next required action.
3. Editable user gate.
4. Step timeline with concise logs/evidence.
5. Environment and agent-turn diagnostics.

Replace the monolithic generated page with small static modules served by the
same process. No frontend framework is required. Use server-sent events for
updates and a normal fetch for commands. A dropped browser connection has no
effect on execution.

The UI never embeds orchestration rules. It renders typed API resources and
submits commands. There is no separate UI job queue or in-memory run state.

## Configuration

Use one external configuration file and optional per-project overrides. Keep
only operator choices:

- model selection by role;
- one agent-turn deadline;
- implementation and final-repair attempt limits;
- Docker build concurrency;
- publication defaults;
- optional explicit `EnvironmentSpec`;
- verification/coverage overrides when the project needs them.

Read configuration when a command is accepted and persist the effective values
needed by that command. Do not maintain settings audit logs, frozen component
graphs, hashes for compatibility, or live mutation semantics spread throughout
the engine.

## Guidance and schemas

Retain useful role guidance as product assets, but normalize it during the
rebuild:

- one guidance file per actual role;
- one strict output schema per role;
- no hidden rule or skill injection;
- no aliases for removed role names;
- no duplicated output contracts in worker code and phase code;
- no project-specific language in packaged guidance.

The environment-planner guidance explicitly forbids assuming a language and
requires repository/brief evidence for every toolchain choice.

## Deletion ledger

The clean-slate branch deletes or replaces the following rather than wrapping
it:

### Runtime and composition

- `src/boot.ts`, `src/context.ts`, and the Cordis profile/plugin composition;
- Cordis dependencies from `package.json`;
- the service-locator `ctx.*` execution model;
- production fake-agent provider and scripted replies;
- host-local `sandbox.mode = "none"`;
- dynamic workflow bundles and phase registration machinery;
- recursive phase hopping;
- startup orphan-recovery code tied to progress files and PID probing.

### Old phases and compatibility shapes

- the entire current `src/phases/` implementation after behavior is expressed
  in the six new workflow steps;
- deprecated question fields and normalization;
- legacy worker stdout parsing;
- legacy session and activity fallbacks;
- role-agent ids hidden in general artifacts;
- old run-state readers and pre-rewrite ignore paths;
- settings audits and live-settings refresh on every advance.

### Environment and execution

- image-fixer role, image-repair plugin, run-specific Dockerfile mutation, and
  all associated UI and tests;
- language-specific packages in the neutral runner image;
- Gradle-specific sandbox behavior in the generic container runtime;
- shell-wrapper compatibility machinery where a direct container command works;
- nested timeout/watchdog/reconciliation layers;
- automatic fake mode when Docker or credentials are absent;
- worker builds and `npm install` during normal dashboard launch.

### UI, scripts, and documentation

- the current monolithic `src/ui/page.ts`;
- duplicate CMD, PowerShell, and shell orchestration logic where the packaged CLI
  can perform the operation directly;
- launcher settings migration;
- superseded ADRs and plans describing removed runtimes, migrations, frozen
  configuration, provider brokers, old TDD loops, and legacy fallbacks;
- tests whose only purpose is to preserve removed behavior.

Git history is the archive. Do not move deleted production code into an
`archive`, `legacy`, `v2`, or compatibility directory.

## Code retained by concept, not by default

The rebuild may reuse small proven functions only after they fit the new
contracts without compatibility branches:

- safe per-run worktree creation/removal;
- mount-policy validation;
- atomic artifact-file writing;
- deterministic Git commit/publish helpers;
- useful role guidance;
- strict output validators;
- environment-neutral process termination.

Do not port a module merely because tests exist for it.

## Delivery strategy

Work on one clean-slate branch. Tag the last pre-rebuild commit for reference,
then rewrite the existing package in place. Do not create `agent-harness-v3`, a
parallel CLI, a feature flag, or a compatibility facade.

### Slice 0 — destructive baseline

- record the accepted architecture in one replacement design document;
- tag the pre-rebuild commit;
- remove old source, old tests, superseded plans/ADRs, and obsolete dependencies;
- keep only guidance/templates and small utilities explicitly selected above;
- create the new package skeleton and one `reset-home` development command.

Gate: the package builds with no Cordis, legacy, fake-runtime, local-runtime, or
image-repair references.

### Slice 1 — coordinator and durable engine

- implement SQLite schema, transactions, command queue, leases, and events;
- implement the pure step contract and one test-only scripted `AgentDriver`;
- implement immediate-return API commands and event streaming;
- implement coordinator restart recovery.

Gate: deterministic tests prove exactly-once transitions across process restart,
duplicate commands, and expired leases.

### Slice 2 — container and environment provisioning

- build the neutral runner image;
- implement the strict worker protocol and single coordinator-owned deadline;
- implement `ContainerRuntime` and generic isolation policy;
- implement environment-planner role, `EnvironmentSpec`, image caching, setup,
  and health checks;
- cover existing and empty repositories.

Gate: mandatory Docker tests build an arbitrary generated environment, recreate
its container, preserve the worktree, and prove isolation. Docker absence must
report skipped tests as skipped locally and fail the release lane.

### Slice 3 — clarify and specify

- implement the complete Clarify step with multi-batch session resume;
- implement Specify with glossary, plan, PRD, scenarios, and editable approval;
- add the minimal dashboard gate experience;
- verify browser disconnect and coordinator restart during every boundary.

Gate: an existing and a fresh project reach an approved specification through
real containers; no synchronous HTTP request spans an agent turn.

### Slice 4 — implement

- implement task slicing, per-task sessions, container verification, independent
  review, repair, and host commits;
- include fresh-project scaffolding as task work;
- make every task action idempotent.

Gate: restart and container-loss tests at implementation, verification, review,
repair, and commit boundaries produce neither duplicate turns nor duplicate
commits.

### Slice 5 — validate and publish

- implement scenario/full verification, optional coverage, final review, and
  bounded final repair;
- implement deterministic branch/push/PR publication;
- complete dashboard diagnostics and cancellation.

Gate: existing-project and fresh-project live golden paths reach exactly one pull
request from a clean start.

### Slice 6 — final rip-out audit

- search for `legacy`, `fallback`, fake production providers, local execution,
  old phase names, image repair, Cordis, migrations, and deprecated fields;
- remove unused settings, files, dependencies, tests, scripts, and documentation;
- measure source/module count and simplify any component that grew beyond one
  clear responsibility;
- rewrite README and installation instructions around the only supported path.

Gate: the deletion and acceptance checklists below pass from a fresh clone.

## Test strategy

### Pure tests

- every step transition for valid and invalid agent, command, and user results;
- schema rejection without legacy normalization;
- environment policy validation;
- idempotency-key generation;
- Git publication reconciliation.

### Coordinator integration tests

- duplicate answer submission;
- duplicate retry and publish commands;
- restart before and after every persisted transition;
- expired lease recovery;
- durable agent result followed by worker cleanup failure;
- cancellation during start, work, and user wait;
- no recursive multi-step advancement.

The scripted agent driver exists only in tests and is injected directly. There
is no environment variable that turns the production application into a fake
system.

### Mandatory Docker tests

- image build from `EnvironmentSpec`;
- container recreation from persisted spec and digest;
- setup and health-check failure diagnostics;
- timeout terminates the worker without corrupting state;
- only `/workspace` and declared named caches are mounted;
- no Docker socket, harness home, sibling run, control checkout, or publication
  secret is visible;
- existing and fresh repositories both work;
- control checkout remains unchanged.

Tests must call the framework's skip mechanism when Docker is intentionally
optional. Returning early from a test is forbidden. The release command sets
Docker as required, so unavailable Docker fails the lane.

### Live acceptance tests

Before release, run the real Cursor provider through these cases:

1. Existing project, complete idea-to-PR run.
2. Empty project, complete idea-to-PR run.
3. Multi-batch clarification with user answers and session resume.
4. Coordinator restart during an agent turn.
5. Container destruction between agent turns.
6. Provider result received followed by worker/disposal hang.
7. Verification failure followed by implementer repair.
8. User cancellation during a live turn.

Capture turn ids, session ids, image digests, commands, and final URLs. Usage and
cost telemetry may be absent without failing execution.

## Acceptance checklist

### Simplicity

- One production coordinator process.
- One production agent provider.
- One container-only execution path.
- One database and one state model.
- One step-transition contract.
- One question schema and one worker result envelope.
- Six workflow steps covering the complete product loop.
- No recursive phase runner or long-running HTTP mutation.

### Environment

- Neutral runner contains no project language toolchains.
- Host contains no language/manifests switch statements.
- Existing and fresh projects resolve environments through the same contract.
- Environment spec, image digest, setup, and health evidence are durable.
- Missing infrastructure blocks explicitly; it never changes execution mode.

### Recovery

- Restart at every external boundary is safe.
- Duplicate commands are harmless.
- A durable provider result is never discarded because cleanup failed.
- Missing containers are recreated from durable environment state.
- Agent conversations resume, with one canonical transcript reconstruction when
  provider-side resume is unavailable.

### No legacy

- No old state import, migration, compatibility reader, or schema alias.
- No fake-agent or host-local production fallback.
- No image repair or self-modifying runner image.
- No Cordis/plugin compatibility layer.
- No deprecated fields or alternate response parsing.
- No archived legacy source inside the package.
- No stale ADR or README instruction presented as current behavior.

### Golden path

- A fresh install performs an existing-project live run to one pull request.
- A fresh install performs an empty-project live run to one pull request.
- Both runs survive forced coordinator and container interruption.
- The operator never edits state files, kills orphan processes manually, or
  guesses whether a timeout actually completed.

## Cutover

The cutover instructions are deliberately short:

1. Stop the old dashboard.
2. Delete the old external harness home and old run containers/images.
3. Install/build the new package and neutral runner image.
4. Start the coordinator.
5. Register projects again.
6. Run the two live acceptance paths.

There is no rollback/migration mechanism in the new code. The pre-rebuild Git tag
is sufficient historical recovery for the sole operator during development.

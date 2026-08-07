# Agent Harness roadmap

## Shipped in v2

- Durable idea-to-feature state machine with bounded transitions and explicit retry
- Wayfinder destination, decision tickets, frontier, fog, and out-of-scope model
- Local Markdown map/issues/tasks as the default tracker
- Offline full-document storage and deterministic lexical retrieval
- Optional fail-soft Graphify traversal for structural repository lookup
- Complete work packets with bounded resumable wayfinding episodes and no provider-session dependency for recovery
- Exact HITL question/answer persistence
- Tracer-bullet task planning and sequential dependency execution
- Per-run TDD toggle with harness-owned RED/GREEN evidence
- Deterministic command gates and bounded implementation/review repair
- Deterministic prompts by default, with optional small-model compilation and small-model commit/PR writing
- Clean-tree, branch, commit, push, and optional `gh pr create` ownership
- Frozen per-run configuration and non-waiting run locks
- Authenticated loopback dashboard for runs, questions, evidence, artifacts, and local knowledge

## Deliberately deferred

### External tracker adapters

Implement GitHub, Linear, and Jira behind `TrackerPort`. Preserve the map-as-index rule and native blocking/claim semantics where available.

### Parallel task execution

Use isolated worktrees or patch sandboxes per frontier task, with explicit conflict detection and an integration gate. Sequential execution remains the safe default.

### Semantic retrieval

Add an optional local embedding backend only when it demonstrably improves retrieval. The lexical index remains the offline, deterministic baseline and source store.

### CI observation and merge policy

Observe remote checks after push and support explicit merge policies. v2 stops at an opened pull request and never auto-merges.

### Additional agent providers

Implement provider adapters behind `AgentBackend`. All must honor abort signals and the existing work-packet/session contract.

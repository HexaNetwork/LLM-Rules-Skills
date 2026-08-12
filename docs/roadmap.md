# Agent Harness roadmap

## Shipped in v2

- Durable idea-to-feature state machine with bounded transitions and explicit retry
- Editable reflect gate, then a grill-me interview over a visible open-unknowns register
- Local Markdown brief/resolutions/unknowns/tasks as the default tracker
- Offline full-document storage and deterministic lexical retrieval
- Optional fail-soft Graphify traversal for structural repository lookup
- Complete work packets with bounded resumable grill episodes and no provider-session dependency for recovery
- Exact HITL question/answer persistence, batched independent questions, skip/park, and operator notes
- Tracer-bullet task planning and sequential dependency execution
- Intent-first workflow: scenario planning, implement-first tasks, run-level scenario tests / coverage / final review (supersedes per-run TDD toggle)
- Deterministic command gates and bounded implementation/review repair
- Ordered config-owned verification commands and targeted-test templates; tasks only provide validated filters
- Deterministic prompts by default, with optional small-model compilation and small-model commit/PR writing
- Clean-tree, branch, commit, push, and optional `gh pr create` ownership
- Frozen per-run configuration and non-waiting run locks
- Authenticated loopback dashboard for runs, questions, evidence, artifacts, and local knowledge

## Deliberately deferred

### External tracker adapters

Implement GitHub, Linear, and Jira behind `TrackerPort`. Preserve the map-as-index rule and native blocking/claim semantics where available.

### Parallel task execution

Per-run isolated worktrees (control root vs execution root, late delivery branches, narrowed locks) shipped under [ADR 0010](./adr/0010-per-run-worktrees.md). What remains deferred is **parallel frontier tasks inside one run** — multiple task worktrees/patch sandboxes with explicit conflict detection and an integration gate. Sequential task execution inside a run remains the safe default.

### Semantic retrieval

Add an optional local embedding backend only when it demonstrably improves retrieval. The lexical index remains the offline, deterministic baseline and source store.

### CI observation and merge policy

Observe remote checks after push and support explicit merge policies. v2 stops at an opened pull request and never auto-merges.

### Additional agent providers

Implement provider adapters behind `AgentBackend`. All must honor abort signals and the existing work-packet/session contract.

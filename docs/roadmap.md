# Agent Harness roadmap

## Shipped in v2

- Durable idea-to-feature state machine with bounded transitions and explicit retry
- Editable reflect gate, then a grill-me interview over a visible open-unknowns register
- Local Markdown brief/resolutions/unknowns/tasks as the default tracker
- Offline full-document storage and deterministic lexical retrieval
- Optional fail-soft CodeGraph traversal for structural repository lookup
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
- Docker-only Cordis runtime (ADRs 0016/0017): one maintained digest-pinned
  worker image, per-run named-volume workspaces, authenticated host-owned state
  RPC, seed/result bundles, quarantine import, host-only publication, and
  conservative recovery/cleanup

## Deliberately deferred

### Docker networking hardening

The Docker-only runtime uses explicit `bridge` networking (filesystem
isolation, **not** exfiltration-proof). Provider/package-registry allowlisted
egress remains deferred as a separate hardening step.

### External tracker adapters

Implement GitHub, Linear, and Jira behind `TrackerPort`. Preserve the map-as-index rule and native blocking/claim semantics where available.

### Parallel task execution

Per-run named-volume workspaces and late host-owned publication shipped under
[ADRs 0016](./adr/0016-docker-only-host-owned-state.md) and
[0017](./adr/0017-cordis-composed-docker-runtime.md). What remains deferred is
**parallel frontier tasks inside one run**—multiple isolated task sandboxes with
explicit conflict detection and an integration gate. Sequential task execution
inside a run remains the safe default.

### Semantic retrieval

Add an optional local embedding backend only when it demonstrably improves retrieval. The lexical index remains the offline, deterministic baseline and source store.

### CI observation and merge policy

Observe remote checks after push and support explicit merge policies. v2 stops at an opened pull request and never auto-merges.

### Additional agent providers

Implement provider adapters behind `AgentBackend`. All must honor abort signals and the existing work-packet/session contract.

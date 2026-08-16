# Agent Harness roadmap

## Shipped in the fresh modular harness

The current topology is defined by
[ADR 0018](./adr/0018-fresh-modular-harness.md):

- One Cordis-composed host process owns workflow, durable state, Git,
  publication, the dashboard, and Docker lifecycle.
- Every run gets one Linux container with its linked worktree bound at
  `/workspace`. The container is recreated after a crash and destroyed on
  completion or cancellation.
- `CURSOR_API_KEY` is passed directly in the run-container environment.
  `GITHUB_TOKEN`, harness home, sibling runs, the Docker socket, and the
  control checkout never enter the container.
- Run identity pins only the run id, workflow bundle, worktree, and base SHA.
  Project and profile settings are live and are re-read on every start,
  continue, answer, and retry, with effective settings appended to the audit.
- The external harness home owns project registration, live settings, run
  state, sessions, artifacts, and guidance. Target repositories stay free of
  harness-owned files.
- Real phase plugins own `enter`, `advance`, and `onAnswer`; workflow bundles
  compose phase lists without a second state machine.
- The default intent-first loop covers reflect, batched grill, glossary,
  verification settings, planning, scenarios, implementation, scenario tests,
  optional coverage, final review, and host-owned publication.
- The authenticated loopback dashboard and CLI are clients of the same run
  lifecycle.
- Required isolation evidence is deterministic: mount list, absence of host
  secrets, and an unchanged control checkout. Live Cursor smoke is opt-in and
  is neither a CI nor launch gate.

The fresh harness intentionally has no provider proxy, proof tuple, custom CA,
frozen configuration, config fixer, worker state RPC, Docker-clone workspace,
or pre-rewrite run migration.

## Deliberately deferred

### Docker networking hardening

The run container provides filesystem and process isolation, not
exfiltration-proof networking. Provider/package-registry allowlisted egress
remains deferred as a separate hardening step.

### External tracker adapters

Implement GitHub, Linear, and Jira behind `TrackerPort`. Preserve the map-as-index rule and native blocking/claim semantics where available.

### Parallel task execution

Runs already have independent linked worktrees and containers. What remains
deferred is **parallel frontier tasks inside one run**, with explicit conflict
detection and an integration gate. Sequential task execution inside a run
remains the safe default.

### Semantic retrieval

Add an optional local embedding backend only when it demonstrably improves retrieval. The lexical index remains the offline, deterministic baseline and source store.

### CI observation and merge policy

Observe remote checks after push and support explicit merge policies. v2 stops at an opened pull request and never auto-merges.

### Additional agent providers

Add agent-provider plugins behind the bounded agent invocation service. Every
provider must preserve the complete work-packet, cancellation, and audit
contracts.

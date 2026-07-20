# Agent Harness roadmap

This file records deliberate v1 exclusions and later extension ports. Do not silently reintroduce these into v1.

## v1 boundary (shipped)

- Contract-deterministic orchestration (schema-valid artifacts, explicit gates, bounded retries)
- Local YAML/Markdown and GitHub API source adapters
- Mandatory project config + `prepare` → `approve` → `execute` / `resume`
- AFK-only tasks
- Sequential DAG scheduling in an isolated worktree/branch
- One durable worker + one independent verifier per task
- Strict Cursor Allowlist mode
- Optional browser acceptance probes
- GitHub tracker sync + verified PR open (no auto-merge / no direct issue close)
- Crash-safe resume and repeatability benchmark

## Deferred extensions

### HITL triage

Promote `RESEARCHABLE` tasks to `AFK_READY` when missing facts can be resolved from code, contracts, or tests. Never promote `DECISION_REQUIRED` tasks; those remain human-gated.

### Additional tracker adapters

Linear, Jira, Azure DevOps, and other issue systems via the same frozen-manifest contract. Keep tracker-specific hierarchy and label mapping in project config, not core concepts.

### Parallel task execution

Run independent ready tasks concurrently with resource budgets and conflict detection. Requires stronger worktree or patch isolation than sequential v1.

### Auto-merge and issue closure

Merge verified PRs and close issues after CI/human policy. v1 stops at opening a verified PR and synchronizing tracker status.

### Exact-code reproducibility

Require bit-identical source trees across repeated runs. v1 measures contract-level repeatability (gates, paths, retries, blocked reasons), not identical code.

### Silent model fallback / dynamic gate discovery

Do not swap models or invent validation commands at runtime. Models and gates are pinned in project config and frozen into the run manifest.

### Authoritative hook allow/deny

When Cursor SDK hooks gain programmatic allow/deny verdicts, replace classifier-adjacent convenience with hard enforcement. Until then, Allowlist + sandbox + orchestrator-owned gates remain the security story.

### Multi-repo / monorepo matrix runs

Coordinate related tasks across multiple repositories with a shared manifest. v1 targets one repository root per run.

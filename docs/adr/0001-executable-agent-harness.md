# ADR 0001: Executable Agent Harness owns the implementation loop

## Status

Superseded by [ADR 0002](0002-durable-wayfinder-harness.md).

## Context

The prose `/implement-auto` skill described a multi-agent loop, but the parent chat agent still interpreted unstructured reports, owned retries, and tracked state in conversation. That made AFK implementation non-deterministic and prone to review-agent explosions.

## Decision

Ship a TypeScript CLI (`@hexanetwork/agent-harness`, binary `agent-harness`) that owns stages, persisted state, command gates, retry budgets, and stop conditions. Cursor SDK agents receive bounded work packets and return schema-validated reports.

**Chat and the local UI are clients.** The lifecycle coordinator (`agent-harness run`) is the source of truth for intake → risk-based refinement → policy approval → TDD-enforced execute → parallel Spec/Standards review → publish (commits + push + open PR, no auto-merge).

Opt-in entry is `/harness-run` (skill) or the loopback UI — not an always-applied redirect of ordinary implementation requests. Legacy `prepare` / `approve` / `execute` remain for staged operators.

## Consequences

- Requires `CURSOR_API_KEY` for real agents and optional `GITHUB_TOKEN` for tracker I/O
- LLM-Rules-Skills becomes a mixed markdown + npm workspace
- Exact code reproducibility is out of scope; contract-level repeatability is the v1 metric
- Legacy `/implement-auto` prose loop remains only as an explicit fallback
- Pauses only for `DECISION_REQUIRED` / `DESTRUCTIVE_RISK`; researchable gaps are auto-resolved when validation passes

# ADR 0001: Executable Agent Harness owns the implementation loop

## Status

Accepted

## Context

The prose `/implement-auto` skill described a multi-agent loop, but the parent chat agent still interpreted unstructured reports, owned retries, and tracked state in conversation. That made AFK implementation non-deterministic and prone to review-agent explosions.

## Decision

Ship a TypeScript CLI (`@hexanetwork/agent-harness`) that owns stages, persisted state, command gates, retry budgets, and stop conditions. Cursor SDK agents receive bounded work packets and return schema-validated reports. Project skills become operators of the CLI, not the orchestration source of truth.

## Consequences

- Requires `CURSOR_API_KEY` for real agents and optional `GITHUB_TOKEN` for tracker I/O
- LLM-Rules-Skills becomes a mixed markdown + npm workspace
- Exact code reproducibility is out of scope; contract-level repeatability is the v1 metric
- Legacy `/implement-auto` prose loop remains only as an explicit fallback

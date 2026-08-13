# ADR 0014: Provider-neutral repository intelligence broker with ordered fallback

## Status

Accepted; extends [ADR 0005](0005-scope-gated-shared-knowledge.md) structural context and the packet budget authority in [ADR 0007](0007-bounded-work-packets.md). Scope gates and [ADR 0006](0006-role-aware-guidance-retrieval.md) guidance selection remain outside this seam.

## Context

Work packets already inject structural repository context beside scoped document retrieval. That path was hard-wired to CodeGraph (`knowledge.codegraph`, `workflow.codegraphCharacters`, CodeGraph-named audits and CLI/UI controls). Replacing or adding a second structural provider forced harness-wide renames and risked leaking provider vocabulary into frozen run configs and packet audits.

Operators also need concurrent per-run worktrees ([ADR 0010](0010-per-run-worktrees.md)). A provider that keys indexes by repository basename or a global registry alias can attach the wrong graph when two checkouts share a name. Soft failure must still leave document/guidance retrieval intact when every structural provider misses or is unavailable.

## Decision

- **Own structural lookup behind a deep broker module** under `packages/agent-harness/src/infrastructure/repository-intelligence/`. Callers (notably `RetrievalOrchestrator` / `LocalKnowledgeBase`) depend on provider-neutral request, result, attempt, and lifecycle audit types—not on GitNexus or CodeGraph APIs.
- **Model typed capabilities** (`search`, `symbol-context`, `impact`, `trace`, `change-impact`) with ordered adapter routes in config. Only routed capabilities run; empty routes return `capability-unrouted`. Unsupported capabilities are not emulated. Packet retrieval initially uses `search`.
- **Route with first-success fallback.** A usable artifact stops traversal. Miss, failure, timeout, unavailable executable, or missing index advances to the next provider. Every attempt is recorded in a neutral audit (`providerId`, outcome, reason, generation, duration).
- **Separate provider lifecycle from document indexing.** `prepare()` eagerly builds indexes for the first provider on each route. Fallback providers refresh lazily under the shared-index lock when traversal reaches them. Source-path changes mark capable adapters stale; primaries refresh immediately, fallbacks on next use.
- **Adapt providers locally.** Ship `GitNexusAdapter` (direct CLI: `analyze` with index-only flags; `query` / `context` with absolute `--repo` workspace identity) and `CodeGraphAdapter` (`init` / `sync` / `explore` / `node`). Shared argument-array executable runner only—no MCP lifecycle, no shell strings. Multi-worktree safety requires path identity, not registry basename.
- **Persist neutral vocabulary.** Config uses `knowledge.repositoryIntelligence` (providers + routes + roles + source extensions) and `workflow.repositoryContextCharacters`. Packet sources, omissions, cache keys, and audits carry `providerId` / `repository:<id>` rather than hard-coded CodeGraph names. Live and frozen configs still *read* legacy `knowledge.codegraph` / `knowledge.graphify` and `workflow.codegraphCharacters` / `graphifyCharacters` via migration; new writes use only the neutral shape. Migrated CodeGraph-era configs keep CodeGraph as the sole routed provider with GitNexus disabled so historical behavior does not silently change.
- **Treat generated indexes as Git-ignored artifacts.** Ensure `.gitnexus/` and `.codegraph/` are ignored (repository-local exclude when needed); refuse tracked index trees. Document retrieval continues when all structural providers fail.

## Consequences

- Adding a provider is an adapter plus route/config/tests; harness knowledge, packet, and lifecycle code stay on the broker contract.
- Default new configs route `search` / `symbol-context` as `[gitnexus, codegraph]`. Operators who only install CodeGraph still fall through; document-only projects set `knowledge.repositoryIntelligence.enabled: false` (deploy `--no-repository-intelligence`).
- Operators must install CLIs separately (`gitnexus`, `codegraph`); the harness verifies executables and builds indexes during run setup and after verified source commits, but does not vendor either tool.
- ADR 0005 scope filtering and ADR 0006 guidance packs stay unchanged: repository intelligence is current-workspace structural context only and never bypasses document visibility gates.
- UI/CLI surfaces should prefer repository-intelligence enablement and per-provider health over CodeGraph-only labels; temporary compatibility aliases at request edges are acceptable until neutralized.

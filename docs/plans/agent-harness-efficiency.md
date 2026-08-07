# Agent Harness — determinism & token-efficiency remediation plan

**Status:** proposed
**Scope:** `packages/agent-harness`
**Origin:** full-package review of the deterministic/agent boundary, packet construction, RAG, and Graphify.

## Problem statement

The harness draws its deterministic/agent boundary correctly at the architectural level: the
harness owns git, process execution, the task graph, retry budgets, and path scoping; agents only
emit JSON. The failures are all at the *payload* level.

1. `workflow.contextCharacters` budgets only `guidance + context` — the small part of the packet.
   `packet.input` is unbounded and dominates cost.
2. `renderPrompt` serialises content that the packet already carries.
3. Roles that need no retrieval still pay for it.
4. Identical retrieval work is repeated 3× per task and again on every repair attempt.
5. Graphify is never prepared on the CLI path, and its query shaper strips the tokens a code
   search most needs.
6. Two lexical-scoring defects skew ranking.

The through-line: **anything that enters a prompt must pass a deterministic budget, and any
deterministic work whose inputs are unchanged must not be repeated.**

## Guiding principles for this work

- **One budget authority.** A single function decides what a packet may contain, per section, in
  characters. No caller assembles prompt content ad hoc.
- **Deterministic beats agentic wherever output is mechanical.** If a fallback already produces
  acceptable output, the model call is a cost, not a feature.
- **Retrieval is a pure function of `(query, options, index-generation)`.** Pure functions get
  memoised.
- **Degrade loudly in the audit, quietly in the prompt.** Every omission already lands in
  `packets/*.retrieval.json`; keep that property for every new cap introduced here.

## Phasing

| Phase | Theme | Ships |
| --- | --- | --- |
| 1 | Packet budget & prompt de-duplication | Items 1–4 |
| 2 | Retrieval caching & Graphify correctness | Items 5–8 |
| 3 | Scoring, guards, and workflow cleanups | Items 9–13 |

Phases are independently shippable. Phase 1 delivers the large majority of the token saving and
should land first with its own tests before Phase 2 begins.

---

# Phase 1 — Packet budget and prompt de-duplication

## Item 1 — Stop sending command evidence twice, uncapped

**Symptom.** All three worker roles pass the whole `BuildTask` as `input`
([`engine.ts:576-591`](../../packages/agent-harness/src/engine.ts#L576-L591),
[`engine.ts:631-650`](../../packages/agent-harness/src/engine.ts#L631-L650),
[`engine.ts:700-716`](../../packages/agent-harness/src/engine.ts#L700-L716)).
`BuildTask.evidence` accumulates `CommandEvidence` entries holding `stdout` and `stderr` capped at
20,000 chars each ([`commands.ts:97-108`](../../packages/agent-harness/src/commands.ts#L97-L108)) —
40k chars per entry. It is then sent a *second* time in the same packet as
`evidenceOutput(task.evidence)` (implementer, test-writer) or `commandEvidence: task.evidence`
(reviewer). A task on its third implementation attempt plausibly carries ~10 entries: roughly 400k
characters of `task.evidence` plus ~80k of `evidenceOutput`, all inlined by
`JSON.stringify(packet, null, 2)`. Cost grows precisely when a task is struggling.

**Change.**

1. Add to `commands.ts`:
   ```ts
   /** Newest-first, budgeted rendering of command evidence for a prompt. */
   export function recentEvidenceOutput(
     evidence: CommandEvidence[],
     options: { entries?: number; charactersPerEntry?: number } = {},
   ): string
   ```
   Defaults: `entries: 2`, `charactersPerEntry: 2_000`. Select the last `entries` items, render each
   as today but tail-slice the combined `stderr\nstdout` to `charactersPerEntry`. Rationale for
   tail-slicing: assertion failures and stack traces live at the end of test output; the head is
   framework banner noise.
2. Add a `taskForPacket(task: BuildTask): Omit<BuildTask, "evidence">`-shaped projection in
   `engine.ts` that drops `evidence` and truncates `description` / `acceptanceCriteria` entries to a
   sane bound. Every worker `input` uses the projection.
3. Rewrite the three call sites:
   - test-writer: `input: { task: taskForPacket(task), priorCommandOutput: recentEvidenceOutput(task.evidence) }`
   - implementer: `input: { task: taskForPacket(task), verifiedCommandOutput: recentEvidenceOutput(task.evidence), reviewFeedback: task.reviewSummary }`
   - reviewer: `input: { task: taskForPacket(task), changedFiles, commandEvidence: recentEvidenceOutput(task.evidence) }`
     — note this changes `commandEvidence` from an array to a rendered string; update
     `expectedOutput` prose only if it referenced the shape (it does not).
4. Keep `evidenceOutput` exported for the tracker/UI, or delete it if Item 3 removes its last
   caller. Check `ui/server.ts` and `tracker.ts` before deleting.

**Deliberately unchanged.** `CommandEvidence` on `RunState` keeps full 20k stdout/stderr. That is
the durable audit record and costs nothing at prompt time. Only the *packet projection* shrinks.

**Tests.**
- New `tests/unit/packet-budget.test.ts`: build a `BuildTask` with 10 synthetic evidence entries of
  20k stdout each; assert the rendered implementer prompt is under a fixed ceiling (e.g. 60k chars)
  and that `state.json` still contains the full evidence.
- `recentEvidenceOutput` unit tests: entry selection is newest-first; tail-slicing keeps the last
  bytes; empty array returns `""`.

**Risk.** A reviewer that previously saw every gate result now sees the last two. Mitigate by always
including the most recent *failing* entry plus the most recent entry overall, rather than a blind
tail — implement that as the selection rule.

## Item 2 — Introduce a single packet budget authority

**Symptom.** `agent.ts:145-155` budgets `context` against `contextCharacters` minus guidance, but
nothing budgets `input`, and no caller can see the total.

**Change.**

1. Extend `workflow` config in [`config.ts`](../../packages/agent-harness/src/config.ts) with:
   ```yaml
   workflow:
     contextCharacters: 12000     # existing: guidance + retrieved context
     inputCharacters: 24000       # new: serialized packet.input ceiling
     graphifyCharacters: 3000     # new: see Item 8
   ```
   All three get zod defaults so existing frozen run configs parse unchanged.
2. Add `src/packet.ts` exporting `buildWorkPacket(...)`, moving the assembly currently inlined in
   `AgentCoordinator.invokeInternal`. It takes guidance, retrieval results, and raw input; applies
   the guidance budget, the context budget, and a new input budget; and returns
   `{ packet, budgetAudit }` where `budgetAudit` records every truncation with a reason.
3. Input budgeting: serialise `input`, and if over budget, truncate the *longest string leaf*
   iteratively until under budget, recording each truncation. This preserves object structure —
   which schemas and prompts depend on — rather than cutting the JSON mid-token.
4. Persist `budgetAudit` into the existing `packets/*.retrieval.json` sibling (rename the file's
   top-level shape to `{ retrieval, budget }`) so there is one audit artifact, not two.

**Why a new module.** `agent.ts` is 765 lines and already owns backend orchestration, output
harvesting, and session persistence. Packet assembly is a separable concern with its own budget
rules and deserves direct unit tests without a backend fixture.

**Tests.** `tests/unit/packet-budget.test.ts` covers: input under budget passes through byte-identical;
input over budget truncates the longest leaf first; the audit names every truncated path;
guidance + context + input never jointly exceed the configured sum.

## Item 3 — Remove retrieval from roles that cannot use it

**Symptom.** `engine.message()` ([`engine.ts:787-806`](../../packages/agent-harness/src/engine.ts#L787-L806))
passes no `knowledgeQuery`, so `agent.ts:121-122` synthesises
`${objective} ${JSON.stringify(input).slice(0,4000)}` — a JSON-punctuation blob — and runs both a
lexical search (up to 6 × 2,000 chars) and a guidance selection (up to 6,000 chars). ~18k characters
of retrieved project documentation to write one commit subject line, once per task.

**Change.**

1. Add `retrieval?: boolean` to `InvokeInput` (default `true`).
2. In `invokeInternal`, when `retrieval === false`, skip both `selectGuidanceWithAudit` and
   `searchWithAudit` entirely and record `{ skipped: "retrieval-disabled" }` in the audit.
3. Set `retrieval: false` on the `message-writer` invocation and on the `prompt-builder` invocation
   (the latter already receives the full packet; retrieving *for* it is circular).
4. Remove the `${objective} ${JSON.stringify(input)}` default query fallback altogether. Every
   remaining caller supplies `knowledgeQuery` explicitly; make the field required in `InvokeInput`
   when `retrieval` is not `false`, enforced by a TypeScript discriminated union so a future caller
   cannot silently reintroduce a JSON-blob query.

**Follow-on decision (recommended, flag for confirmation).** With `retrieval: false` the commit
message call is cheap, but it is still a full model round-trip per task for output the deterministic
fallback already produces acceptably (`feat: ${task.title}` + description). Recommend gating it
behind `workflow.generateCommitMessages: false` by default, keeping the model call for the PR body
in `publish()` where the summarisation across tasks has real value. This is a behaviour change, so
it ships as config with the current behaviour available.

**Tests.** Extend `tests/integration/workflow.test.ts` to assert the persisted `message-writer`
packet has empty `guidance` and `context`. Add a case asserting the deterministic commit subject when
`generateCommitMessages: false`.

## Item 4 — De-duplicate guidance and stop pretty-printing the packet

**Symptom.** [`prompts.ts:49-62`](../../packages/agent-harness/src/prompts.ts#L49-L62) emits
`renderGuidance(packet)` — the full excerpts, human-readably — and then
`JSON.stringify(packet, null, 2)`, which contains `packet.guidance` with the same excerpts. Up to
6,000 characters duplicated on every invocation, and `null, 2` adds indentation across the whole
payload.

**Change.**

1. In `renderPrompt`, serialise a packet view with `guidance` omitted:
   ```ts
   const { guidance: _rendered, ...packetForJson } = packet;
   ```
   and use `JSON.stringify(packetForJson)` — compact, no indent.
2. `renderPromptBuilderPrompt` gets the same treatment; it currently serialises the packet whole and
   its own instructions reference "selected guidance block", so render guidance once via
   `renderGuidance` there too.
3. `renderContinuationPrompt` does not duplicate, but it re-sends the full guidance block on every
   grill turn inside an already-warm provider session. Change it to send guidance only when the
   selected guidance set differs from the previous turn's. This requires threading the previous
   turn's guidance source list through `GrillEpisode` — add
   `guidanceFingerprint?: string` (a hash of selected sources) to `GrillEpisodeSchema` in
   `domain.ts`, defaulted so old run files parse.

**Tests.** `tests/unit/prompts.test.ts` currently asserts `renderPrompt(packet)` *contains* the rule
source and excerpt — those still pass. Add assertions that the excerpt appears exactly once
(`split(excerpt).length === 2`) and that the output contains no `\n    "` indentation artifact.

---

# Phase 2 — Retrieval caching and Graphify correctness

## Item 5 — Memoise retrieval within a run

**Symptom.** `test-writer`, `implementer`, and `reviewer` build an identical query
(`[task.title, task.description, ...task.acceptanceCriteria].join(" ")`), and each repair attempt
rebuilds it again. Each invocation independently full-parses and zod-validates `chunks.json` and
`documents.json` ([`knowledge.ts:608-640`](../../packages/agent-harness/src/knowledge.ts#L608-L640)),
spawns a `graphify query` subprocess, makes an embedding round-trip for the query vector, and runs
`scoreText` over the entire content of every guidance document
([`knowledge.ts:557-559`](../../packages/agent-harness/src/knowledge.ts#L557-L559)).

**Change.**

1. **Index-level cache in `LocalKnowledgeBase`.** Cache parsed `documents` and `chunks` in memory,
   keyed by an *index generation* token. Derive the generation from the `mtimeMs` + `size` of
   `documents.json` and `chunks.json` (one `stat` per load — cheap and correct across the CLI/UI
   split where a UI refresh can rewrite the index under a long-lived process). Invalidate on
   `refresh()` and `upsertText()` directly.
2. **Result-level cache.** Memoise `searchWithAudit` and `selectGuidanceWithAudit` on
   `(query, JSON.stringify(options), generation)`. Bound the map at ~64 entries with FIFO eviction so
   a long run cannot grow it without limit.
3. **Query-vector cache.** In `LocalEmbeddingIndex.search`, memoise the query embedding on
   `(query, provider, endpoint, model)` for the process lifetime.
4. **Graphify result cache.** In `GraphifyRepositoryLookup`, memoise `search` on the *shaped* query
   plus graph mtime, so the three per-task roles share one subprocess spawn and repairs reuse it.

**Expected effect.** Roughly two-thirds fewer Graphify subprocess spawns and embedding calls, and the
index parse drops from once-per-invocation to once-per-index-generation.

**Tests.** New `tests/unit/retrieval-cache.test.ts` using a counting `GraphifyRunner` stub: two
identical `searchWithAudit` calls invoke the runner once; a call after `refresh()` invokes it again;
a call with a different query invokes it again. Assert the cached result is deep-equal, not aliased
(callers mutate `excerpt` via slicing).

**Risk.** Stale results if the index changes without touching mtime. The generation token includes
`size` to reduce that, and `refresh()` invalidates explicitly. Acceptable.

## Item 6 — Prepare Graphify on the CLI path

**Symptom.** `prepareGraphifyForRun` is called only from
[`ui/server.ts:242`](../../packages/agent-harness/src/ui/server.ts#L242). `agent-harness start`
([`cli.ts:154-158`](../../packages/agent-harness/src/cli.ts#L154-L158)) goes straight to
`engine.start`, so on a fresh checkout every CLI run silently degrades to
`skippedReason: "graph-missing"` and loses all structural retrieval. The README claims the harness
verifies both the command and the graph "before the first agent step of each new run".

**Change.**

1. Move the call into `HarnessEngine.start`, before `knowledge.refresh()`, behind a
   `prepareGraphify = true` parameter mirroring the existing `refreshKnowledge` parameter.
2. `ui/server.ts` passes `prepareGraphify: false` for its own start call (it already runs preparation
   inside the visible job queue where progress is reported) and keeps its explicit
   `prepareGraphifyForRun` call — the UI needs the staged progress messages, and holding a browser
   request open through a first graph build is exactly what the existing comment warns against.
3. Inject the runner through `HarnessDependencies` so tests can stub it rather than shelling out.

**Tests.** `tests/integration/workflow.test.ts` gains a case asserting a stubbed preparation runs on
`engine.start` and that a preparation failure surfaces as a `run.blocked` with a readable message
rather than a silent degradation.

## Item 7 — Rebuild the Graphify stopword list

**Symptom.** [`graphify.ts:17-240`](../../packages/agent-harness/src/graphify.ts#L17-L240) strips
`test`, `tests`, `testing`, `interface`, `security`, `code`, `file`, `path`, `repository`, `issue`,
`bug`, `document`, `readme` — precisely the tokens a structural code query needs. It also carries
domain leakage from one specific deployment target: `player`, `facing`, `player-facing`, `fog`,
`map`, `route`, `destination`. Stripping `player` in a game repository — the README's own deploy
example is a game playground — silently guts recall. Because `isUsableGraphifyQuery` requires ≥2
surviving tokens, an over-filtered query is dropped entirely rather than degraded. The list also
contains duplicate entries (`please`, `should`, `must`, `then`, `once`, `into`), evidence it grew by
accretion.

**Change.**

1. Split into two exported constants:
   - `ENGLISH_STOPWORDS` — articles, pronouns, auxiliaries, prepositions, conjunctions only.
   - `HARNESS_META_STOPWORDS` — words that describe the harness's own process and are noise in *any*
     project: `objective`, `acceptance`, `criteria`, `resolution`, `recommendation`, `ticket`,
     `grill`, `packet`. Keep this list short and defensible.
2. **Delete** the code-domain words (`test*`, `interface`, `security`, `code`, `file`, `path`,
   `repository`, `issue`, `bug`, `document*`, `readme`, `implementation`, `architecture`) and the
   game-domain words (`player*`, `fog`, `map`, `route`, `destination`).
3. Add config `knowledge.graphify.stopwords: string[]` (default `[]`), merged over the built-ins, so
   a project can tune noise without a harness release.
4. De-duplicate; add a unit test asserting the two built-in lists are disjoint and contain no
   duplicates, so accretion cannot recur silently.

**Tests.** Extend `tests/unit/graphify.test.ts`: `buildGraphifyQuery("player inventory
SettlementWindow")` retains `player` and `inventory`; a query of pure English stopwords still shapes
to `""`; a project-configured stopword is honoured.

## Item 8 — Give Graphify an explicit sub-budget

**Symptom.** The Graphify result is prepended at score 1
([`knowledge.ts:498-502`](../../packages/agent-harness/src/knowledge.ts#L498-L502)) and the budget
loop fills greedily in order, so with `queryBudgetTokens: 1200` (~5,000 chars) Graphify can consume
~40% of the 12,000-char context budget before a single document chunk is considered. Ordering, not
policy, decides the split.

**Change.**

1. Use the `workflow.graphifyCharacters` setting added in Item 2 (default 3,000). In
   `buildWorkPacket`, truncate the Graphify excerpt to that ceiling *before* the general context loop
   runs, and record the truncation in the budget audit.
2. Remove `reflector` — and, on the same reasoning, `griller` — from the default
   `REPOSITORY_LOOKUP_ROLES` in [`config.ts:7-14`](../../packages/agent-harness/src/config.ts#L7-L14).
   The reflector restates an idea into scope/assumptions/unknowns; structural graph context is
   near-zero value there for a subprocess plus ~1,200 tokens on every new run. Both remain
   configurable for projects that want them.
3. Gate the post-commit `graphify update` ([`engine.ts:749`](../../packages/agent-harness/src/engine.ts#L749))
   on whether the committed paths include at least one file with a source extension. A docs-only
   commit should not trigger a 120s graph rebuild.

**Tests.** `tests/unit/config.test.ts` asserts the new default role list. A packet test asserts a
5,000-char Graphify excerpt is capped at 3,000 and that document chunks still make it into `context`.

---

# Phase 3 — Scoring, guards, and workflow cleanups

## Item 9 — Fix the IDF denominator and de-duplicate query terms

**Symptom.** In [`knowledge.ts:412-427`](../../packages/agent-harness/src/knowledge.ts#L412-L427),
document frequency is computed over `allowedChunks` (post scope/visibility/guidance filtering) but
the IDF numerator uses `chunks.length` (the unfiltered total):

```ts
Math.log(1 + chunks.length / (1 + (documentFrequency.get(term) ?? 0)))
```

Because `excludeGuidance: true` is the default, filtering routinely removes a large fraction of
chunks, so IDF is systematically inflated and the ratio is not a meaningful corpus statistic.
Separately, `terms` from `tokenize(query)` is not de-duplicated, and the scoring loop iterates it
directly — so a word repeated in the query counts once per occurrence. Since worker queries
concatenate title + description + acceptance criteria, repetition is guaranteed, and ranking skews
toward whichever word the planner happened to repeat.

**Change.**
1. Use `allowedChunks.length` as the numerator.
2. De-duplicate: `const terms = [...new Set(tokenize(query))]`.

**Risk — this changes ranking.** Scores are asserted in
[`tests/unit/knowledge.test.ts`](../../packages/agent-harness/tests/unit/knowledge.test.ts) and
[`tests/unit/retrieval.test.ts`](../../packages/agent-harness/tests/unit/retrieval.test.ts).
Expect to update expected score values. *Relative ordering* assertions should be preserved —
if any ordering assertion flips, stop and investigate rather than updating the expectation, because
a flip means the fix changed which document a worker sees.

**Tests.** Add a direct unit test: two chunks where one contains a query term repeated three times
and the other contains three distinct query terms; assert the multi-term chunk ranks higher after the
fix (it does not before).

## Item 10 — Loosen the per-source cap for the top source

**Symptom.** `maxChunksPerSource: 1` with `relevanceFloor: 0.55` is aggressive: the single document
that definitively answers a query contributes exactly one 2,000-char chunk.

**Change.** Allow the highest-ranked source 2 chunks and every other source 1, i.e. change
`diversifyBySource` to take `{ maxPerSource, maxForTopSource }`. Default `maxForTopSource: 2`,
configurable. Omissions continue to be audited with reason `per-source-cap`.

**Note.** This *increases* tokens slightly. It is included because Phase 1 frees far more budget than
this consumes, and under-retrieval causes repair loops, which are the most expensive failure mode in
the system. Ship it after Phase 1 is measured, not before.

## Item 11 — Deterministic guard on implementer test tampering

**Symptom.** `isTestPath` is enforced for the test-writer
([`engine.ts:592-596`](../../packages/agent-harness/src/engine.ts#L592-L596)), but "Do not weaken,
delete, or bypass tests" for the implementer is prompt-only
([`prompts.ts:32-36`](../../packages/agent-harness/src/prompts.ts#L32-L36)). This is exactly the
class of constraint that belongs on the deterministic side — the harness already has the diff.

**Change.**

1. Record the test files the test-writer touched on the task (`testPaths: string[]` on
   `BuildTaskSchema`, defaulted for old artifacts).
2. After the implementer's GREEN run, compare `git diff --name-only` against `testPaths`. If a
   recorded test file changed during implementation, treat it like a failed gate: record evidence,
   route back to `implementing` with an explicit repair message naming the file, and consume an
   implementation attempt.
3. Gate on `config.git.enabled` — with git off, fall back to the agent's reported `changedFiles`,
   the same degradation `writeTests` already accepts.

**Tests.** `tests/integration/workflow.test.ts`: a fake implementer that reports a test file gets
routed back to `implementing` with the failure recorded, and exhausts to `failed` after the budget.

## Item 12 — Replace the legacy configuration-hash enumeration

**Symptom.** [`engine.ts:922-936`](../../packages/agent-harness/src/engine.ts#L922-L936) enumerates
hand-written legacy config shapes to keep old runs resumable. Two optional fields already produce
four variants; this grows combinatorially with every migration and will eventually be wrong.

**Change.**

1. Write an explicit `configVersion` (integer, bumped on each shape migration) into the frozen
   `config.json` alongside the existing hash, and store it on `RunState`.
2. On resume, compare `configVersion` first. If it matches, compare the hash. If the version is
   older, accept the run and record a `run.config_migrated` event naming the version delta — the
   frozen snapshot is authoritative for that run regardless.
3. Delete `configurationHashes` and its variant list.

**Tests.** `tests/unit/config.test.ts` (or a new `run-config.test.ts`): a run frozen at an older
`configVersion` resumes and emits the migration event; a run whose hash mismatches *within* the same
version is still refused.

## Item 13 — Stop counting agent-free transitions against `maxStepsPerRun`

**Symptom.** `maxStepsPerRun: 25` versus ~7 steps per task (`pending → writing_tests → red →
implementing → verifying → reviewing → committing`) plus reflect, grill turns, plan, and publish.
A four-task plan yields mid-flight via `run.yielded`
([`engine.ts:90-96`](../../packages/agent-harness/src/engine.ts#L90-L96)) and needs a manual
`continue`. Some of those steps — notably `case "red"` at
[`engine.ts:560`](../../packages/agent-harness/src/engine.ts#L560) — are pure state transitions that
make no agent call and no shell call.

**Change.** Have `advanceOne` return whether the step consumed a bounded resource (agent invocation
or shell command), and only decrement the step budget for those. Raise the default to 40 in the same
change, since the budget now means "expensive operations" rather than "state transitions".

**Tests.** `tests/unit/reliability.test.ts`: a run consisting only of free transitions does not
yield; a run of N agent calls yields at the configured budget.

---

## Cross-cutting: measurement

Without a baseline none of this is verifiable. Before Phase 1 lands:

1. Add `tests/unit/packet-size.test.ts` that constructs a representative worst-case task (10 evidence
   entries, full guidance, full context) and snapshots the rendered prompt length for each role.
2. Add a `agent-harness status --run-id <id> --json` field summing `usage.inputTokens` across
   `sessions/*.json` — the data is already persisted by
   [`usageRecord`](../../packages/agent-harness/src/agent.ts#L581-L594) and surfaced by
   `reportedTotal`, it is simply not aggregated.

Report before/after on a single real run. The expectation from Items 1–4 is a large reduction in
worst-case per-invocation input, concentrated on repair attempts; treat any measured result that
contradicts that as a signal the diagnosis was wrong, not as a number to explain away.

## Documentation to update

- `packages/agent-harness/README.md`: the retrieval-budget section (new `inputCharacters` /
  `graphifyCharacters`), the Graphify preparation claim (true for both entry points after Item 6),
  the default `graphify.roles`, and the commit-message behaviour if Item 3's follow-on ships.
- `docs/adr/0007-bounded-work-packets.md`: record the decision that a single budget authority owns
  every byte entering a prompt, and that evidence is durable in state but projected for packets.
  This is a real architectural constraint future work must not erode, which is what the ADR series is
  for.
- `packages/agent-harness/src/config.ts` `defaultConfigYaml()` must gain every new key with its
  comment, since deployments are generated from it.

## Sequencing note

Items 9 and 10 change retrieval ranking; Items 1–4 change packet size. Landing them together makes a
regression in either impossible to attribute. Keep the phases as separate commits with the
measurement from the cross-cutting section run between them.

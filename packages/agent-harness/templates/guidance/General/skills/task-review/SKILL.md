---
name: task-review
description: Per-task production review of a harness work-packet diff along Standards and Spec axes. Use during executing-phase task review when unit tests and scenario tests are authored in later run phases. Do not block on missing tests or scenario IDs.
roles: [task-reviewer]
disable-model-invocation: true
---

Two-axis review of the work-packet diff for one executing-phase task:

- **Standards** — does the production change conform to this repo's documented coding standards?
- **Spec** — does the production change match the work-packet `input.task` (title, description, acceptance criteria)?

Both axes run as **parallel sub-agents** so they don't pollute each other's context. This skill aggregates into the harness JSON contract only.

Tests are authored later in `scenario_testing` (scenario-writer) and `crystallizing` (unit-test-writer). Missing tests are expected. Do not fetch GitHub issues or ask for a fixed point.

## Process

### 1. Pin the packet diff

The packet already names the baseline. Use, in this order:

1. `input.reviewDiffBase` when present
2. `input.diff` as the primary evidence
3. `input.changedFiles` as the path list

Read every path in `input.diffOmittedFiles` from disk before commenting on it. Do not invent another baseline, merge-base, or `HEAD~1` comparison.

If the diff is empty and omitted files are empty, report that in `summary` and approve unless a listed omitted file shows a production defect.

### 2. Identify the spec source

The spec is `input.task` only: title, description, and acceptance criteria. Packet `scenarioIds` are tags for later phases, not a demand to implement tests now.

Ignore acceptance criteria whose only demand is tests, coverage, or scenario implementation. Those belong to `scenario_testing` / `crystallizing`.

### 3. Identify the standards sources

Discover anything in the repo that documents how code should be written:

- Selected `.mdc` rules, `AGENTS.md`, or the active agent environment's equivalent repository guidance
- `docs/DESIGN.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md` if present
- `CLAUDE.md` or `AGENTS.md` if present

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Send a single message with two `Task` tool calls (`subagent_type`: `generalPurpose`, `readonly`: true). Use the `general-purpose` subagent for both.

**Standards sub-agent prompt** — include:

- The packet diff (`input.diff`), `input.changedFiles`, `input.reviewDiffBase`, and `input.diffOmittedFiles` (tell it to read omitted files from disk).
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the production diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Do not treat missing tests as a standards failure. Under 400 words."

**Spec sub-agent prompt** — include:

- The packet diff and changed-file list.
- The work-packet `input.task` title, description, and acceptance criteria.
- Packet `scenarioIds` and `workflow.testPathPatterns` as context that tests come later.
- The brief: "Report: (a) production requirements the task asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the task line for each finding. Ignore acceptance criteria whose only demand is tests, coverage, or scenario implementation. Do not flag missing tests, missing scenario IDs, or absent files matching test path patterns. Under 400 words."

If `input.task` is missing, skip the Spec sub-agent and note that in `summary`.

### 5. Aggregate into harness JSON

Do **not** emit `## Standards` / `## Spec` markdown as the deliverable. Return exactly one raw JSON object:

```json
{
  "approved": true,
  "summary": "one-line outcome",
  "findings": [
    {
      "severity": "blocking",
      "kind": "production",
      "message": "what failed and where"
    }
  ]
}
```

`severity` is `blocking` or `advisory`. `kind` is `production`, `test-coverage`, `test-design`, `scenario-intent`, or `advisory`. Optional `taskIds` when a finding is task-scoped.

Map axis results into findings. Do not merge or rerank the two axes — keep each finding attributable to Standards or Spec in `message`.

## Out of scope (never blocking)

If mentioned at all, emit **advisory** findings only, with the kind in parentheses:

- No new files matching `workflow.testPathPatterns` (`test-coverage`)
- Acceptance criteria whose only demand is tests, coverage, or scenario implementation (`test-coverage` or `scenario-intent`)
- Packet `scenarioIds` with no tests yet (`scenario-intent`)
- `commands.verification` that passed without new tests — passing gates are not proof that tests exist, and not a reason to block when they do not (`test-coverage`)
- Later test-design advice for `scenario_testing` / `crystallizing` / unit-test-writer (`test-design`)

## Blocking

Block only for a demonstrable **production** correctness, security, or production-acceptance failure (`kind: production`, `severity: blocking`).

Standards judgement-call smells are advisory (`kind: advisory`) unless they are also a documented-standard breach that causes a production defect.

## Approval

Set `approved: true` when there are **zero** blocking `production` findings, even if tests are missing and even if advisory `test-coverage` / `test-design` / `scenario-intent` findings exist.

Set `approved: false` only when at least one blocking `production` finding remains.

Return exactly one raw JSON object. Do not use Markdown headings or code fences.

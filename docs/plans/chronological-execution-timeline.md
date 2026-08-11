# Chronological Execution Timeline

## Objective

Replace the Activity tab's context-first presentation with a chronological execution timeline that shows the actual order of agent invocations, verification commands, routing decisions, TDD transitions, and review outcomes.

Keep provider-context grouping as a secondary view for context-reuse and token analysis.

## Problem

The current Activity view groups invocation records by `providerSessionId` and sorts provider contexts newest-first. Calls from a retained RED or GREEN session therefore appear together even when verification, reviewer, or other calls occurred between them.

This hides the causal execution order and can make reviewer-directed repairs look like unnecessary agent calls.

Current implementation areas:

- Activity aggregation: `packages/agent-harness/src/application/agent-activity.ts`
- Run-detail loading: `packages/agent-harness/src/ui/http/run-reads.ts`
- Activity rendering: `packages/agent-harness/src/ui/client/render-run.ts`
- Activity styles: `packages/agent-harness/src/ui/app.ts`
- UI unit tests: `packages/agent-harness/tests/unit/ui-app.test.ts`
- UI integration tests: `packages/agent-harness/tests/integration/ui.test.ts`

## Scope

This is observational UI and data-model work only. Do not change TDD routing, completion guards, repair budgets, agent prompts, or retry behavior as part of this task.

## Proposed experience

Add two Activity views:

1. **Execution sequence** — default
2. **Provider contexts** — the existing grouped presentation

The execution sequence should be one globally chronological list, for example:

```text
01  10:31:04  RED writer         initial               done
02  10:34:18  Verification       tdd:green             passed
03  10:34:22  Reviewer           initial               blocking
04  10:39:47  Routing            production → GREEN
05  10:39:48  GREEN implementer  final repair          green
06  10:45:10  Routing            GREEN → RED reassessment
07  10:45:11  RED writer         continuation          done
08  10:46:02  Verification       final gates           passed
09  10:46:04  Reviewer           initial               blocking
```

### Agent invocation rows

Display:

- Global sequence number
- Timestamp
- Role
- Task title or task ID
- TDD round, when applicable
- Invocation kind
- New or reused provider context
- Context turn
- Trigger summary
- Structured result such as `continue`, `done`, `green`, `approved`, or `blocking`
- Token use
- An **Inspect invocation** action

### Non-agent rows

Display important operations inline between invocations:

- Verification command or gate and its pass/fail result
- Review repair route
- TDD round started or completed
- RED completion declaration
- Final-repair routing
- Failure or budget exhaustion

Use expandable details for command output, review findings, handoff summaries, and identifiers.

## Data model

### 1. Add a flat timeline collection

Extend the activity response without removing `providerContexts`:

```ts
type ActivityTimelineEntry =
  | {
      type: "invocation";
      sequence: number;
      occurredAt: string;
      invocation: InvocationSummary;
    }
  | {
      type: "transition";
      sequence: number;
      occurredAt: string;
      event: string;
      eventSequence?: number;
      taskId?: string;
      round?: number;
      summary: string;
      status?: "passed" | "failed" | "blocking" | "completed";
      from?: string;
      to?: string;
    };

type AgentActivity = {
  timeline: ActivityTimelineEntry[];
  providerContexts: ProviderContextGroup[];
  totals: {
    providerContexts: number;
    invocations: number;
    continuedInvocations: number;
    schemaRepairs: number;
  };
};
```

Do not derive global ordering from provider-context groups. Build it from the original invocation records and persisted run events.

### 2. Correlate invocation records and workflow events

Before implementation, inventory the exact names and payloads of relevant events in source and a representative `events.jsonl`. Prefer existing events over adding duplicates.

Likely relevant event families include:

- RED requested, observed, confirmed, and done
- GREEN requested and observed
- TDD round started and completed
- Verification passed or failed
- Review passed or failed
- Review repair routing
- Redundant invocation skipped
- Task failed or repair budget exhausted

Order entries by timestamp. Use persisted event sequence as the deterministic tie-breaker. Define an explicit fallback for historical invocation records that lack precise timestamps.

### 3. Expose structured invocation outcomes

Check whether current invocation artifacts expose role-specific results clearly enough for the timeline. If not, add a compact structured outcome at the invocation artifact-writing boundary:

```ts
outcome?: {
  status?: string;
  summary?: string;
  blockingCount?: number;
  repairRoute?: string;
};
```

Do not parse prompts or rendered prose in the browser to infer outcomes.

### 4. Preserve compatibility

Historical records may lack trigger metadata, invocation kind, task ID, provider session ID, or structured outcomes. Render useful fallbacks and never fail the whole timeline because one record is incomplete.

## Backend implementation

1. Inventory persisted event and invocation-artifact fields.
2. Add timeline entry types in `agent-activity.ts`.
3. Preserve the existing behavior of `buildAgentActivity()` for provider-context groups.
4. Add a timeline builder that normalizes invocation records and selected workflow events.
5. Sort normalized entries chronologically and assign stable global sequence numbers.
6. Update `run-reads.ts` to load and supply the required event records.
7. Add structured outcomes at the artifact-writing boundary only if existing data is insufficient.
8. Ensure transition and command rows do not affect agent invocation counts or token totals.

## Frontend implementation

1. Add an Activity view switch: **Execution sequence** / **Provider contexts**.
2. Make **Execution sequence** the default.
3. Extract the current context renderer into a dedicated function without changing its behavior.
4. Add a renderer for chronological timeline entries.
5. Reuse the existing invocation inspector for invocation rows.
6. Add expandable details for verification and routing rows.
7. Give RED, GREEN, reviewer, verification, and routing rows distinct but restrained visual treatment.
8. Present `NEW CONTEXT` and `REUSED CONTEXT · turn N` as row metadata rather than as the primary grouping.
9. Preserve token warnings and schema-repair indicators.

Client-side state is sufficient for the selected view. Persistence across page reloads is optional.

## Tests

### Activity aggregation unit tests

Cover:

- Invocations from different provider contexts interleave chronologically.
- Retained RED turns remain separated by intervening GREEN, verification, and reviewer activity.
- Identical timestamps use a deterministic tie-breaker.
- Provider-context grouping remains unchanged.
- Transition rows do not alter invocation or token totals.
- Historical records without trigger or outcome metadata remain renderable.
- Schema-repair invocations remain linked and marked repaired.

### UI rendering tests

Assert:

- Execution sequence is the default view.
- Global sequence numbers render.
- Role, task, round, trigger, result, context reuse, and tokens render.
- Verification and routing rows appear between the correct agent calls.
- Provider-context view remains available.
- **Inspect invocation** opens the correct artifact from a chronological row.
- Switching views does not unnecessarily lose expanded-row state.

### Integration regression

Create a scripted sequence matching the confusing run:

```text
RED done
→ verification
→ reviewer blocking production
→ GREEN final repair
→ RED reassessment
→ verification
→ reviewer blocking test coverage
```

Assert that the activity API and UI report exactly that order. Also assert:

- Both RED calls share the provider context when it is reused.
- Their context-turn numbers are correct.
- They are not adjacent in the execution-sequence view.
- The reviewer repair route appears between the reviewer and GREEN invocation.

## Acceptance criteria

- The default Activity view reflects actual execution order across roles.
- A user can determine why each invocation occurred without reading raw run files.
- Retained sessions do not collapse non-contiguous calls into a misleading visual sequence.
- Verification and routing decisions appear at the correct points.
- Every agent invocation remains inspectable.
- Provider-context grouping remains available.
- Agent invocation counts and token totals remain unchanged.
- Historical runs continue to render.
- Typecheck, unit tests, integration tests, and relevant UI tests pass.

## Delivery guidance

Implement the smallest useful version first:

1. Flat chronological invocation sequence
2. Inline reviewer-routing and verification events
3. View switch preserving the existing context view
4. Structured outcomes only where current artifacts cannot supply them

Avoid building a generic event-visualization framework. The timeline only needs enough event types to explain agent calls and harness routing.

## Repository baseline

Start from commit `b108b86`, which cleanly reverts the experimental TDD repair-routing changes while preserving the earlier guidance work.

# Agent Harness glossary

Use these terms consistently in code, prompts, artifacts, and operator messages.

**Run** — One durable idea-to-feature workflow identified by `runId`. Its `state.json` is authoritative.

**Destination** — The concrete end state that bounds a Wayfinder map. Every decision points toward it.

**Map** — The low-resolution index containing the destination, decision gists, unresolved fog, and out-of-scope notes. It does not duplicate full ticket answers.

**Decision ticket** — One precise question whose answer clears part of the route. Types are `research`, `prototype`, and `grilling`.

**Fog** — In-scope uncertainty that is not yet precise enough to become a decision ticket.

**Frontier** — Open, unblocked, unclaimed tickets whose blockers are resolved.

**AFK** — Work an agent may perform without human authority.

**HITL** — Work requiring a human to speak for intent, preference, credentials, or another decision the model cannot own.

**Human question** — A persisted HITL prompt with decision context, two to four mutually exclusive options and their tradeoffs, plus one explicit recommendation and rationale. Free-form answers remain valid.

**Tracer-bullet task** — A narrow but complete implementation slice that is independently verifiable and fits one fresh model context.

**Work packet** — The complete, persisted input to exactly one model invocation: objective, constraints, task input, retrieved context, artifact pointers, and output contract.

**Session** — One bounded model invocation with its exact submitted prompt, provider identifiers, output, and available usage telemetry persisted under `sessions/`.

**Wayfinding episode** — A bounded provider conversation reused across several navigation, AFK-decision, and human Q→A sessions. It is capped by model turns and may be resumed for context/cache efficiency; complete packets remain the recovery fallback.

**Handoff** — A complete packet plus explicit pointers to prior artifacts. It can seed a fresh context or recover an episode whose provider checkpoint is unavailable.

**Local tracker** — Human-readable `map.md`, `issues/*.md`, and `tasks/*.md` stored with a run when no external tracker is configured.

**Local knowledge base** — Full local document storage plus a deterministic lexical chunk index used to retrieve relevant context into work packets. It may add bounded CodeGraph traversal output for repository relationships; the graph is a regenerable projection, not durable run state.

**Dashboard** — The authenticated loopback browser client for the harness engine and persisted artifacts. It may issue actions but never owns lifecycle state.

**RED evidence** — A harness-run targeted test command that fails meaningfully before implementation and does not time out or fail because no tests were found.

**GREEN evidence** — A harness-run targeted test command that exits successfully after implementation.

**Gate** — A configured command the harness runs and records. Agents may react to gate output but cannot self-attest that a gate passed.

**Repair budget** — The finite number of test, implementation, review, schema, or fog-expansion attempts. Exhaustion creates a blocked run.

**Blocked run** — A stopped, inspectable state with the failure and prior phase recorded. Retrying is explicit.

**Prompt compiler** — Optional small-model session that turns a work packet into a downstream prompt without changing scope. Its failure falls back to the deterministic renderer.

**Message writer** — Small-model role that drafts commit and pull-request text. The harness runs all git and `gh` commands.

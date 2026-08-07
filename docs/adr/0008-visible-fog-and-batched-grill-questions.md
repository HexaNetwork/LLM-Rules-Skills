# ADR 0008: A visible unknowns register and batched grill questions

## Status

Accepted; amends the interview interaction model of [ADR 0004](0004-bounded-resumable-wayfinding-episodes.md)

## Context

The grill-me interview replaced wayfinding, but it dropped a property the Wayfinder map had: the human could see named-but-unresolved regions — the fog. Grill-me exposes only what it asks right now.

Two costs follow from that.

The interview has no observable length. The dashboard shows a count of resolutions with no denominator, because nothing in the run state knows what is still open. The human cannot tell whether they are two questions from planning or twelve, and the only way to find out is to keep answering.

Every question is also a separate model round-trip. `grill()` found exactly one answered-but-unresolved question, invoked the griller, and returned exactly one next question. Ten decisions meant ten sequential invocations, each with the human waiting on a full provider call before they could give an answer they often already knew.

The reflector already produced a structured `unknowns: string[]`, which `formatReflectRestatement` flattened into prose that nothing ever re-parsed. The seed for a fog register was being generated and discarded.

## Decision

- Add an **open-unknowns register** to `RunState`. Every griller turn returns a draft list of what it still needs resolved, including things it has not yet asked about. The engine — not the griller — owns each entry's `status` (`fog`, `asked`, `parked`, `resolved`), because only the engine knows what was asked or skipped.
- Reconcile the register as a re-projection, not an append-only log: one answer often collapses several latent unknowns and opens new ones. An entry absent from the incoming list becomes `resolved`; `parked` is sticky until the griller re-asks it. Entries are never deleted, only transitioned, so the register reads as a stable history.
- Seed the register from `ReflectOutput.unknowns` at the reflect gate, so it is populated before the first question is asked.
- Let a griller turn return **1..N questions** (`workflow.grillQuestionsPerBatch`, three by default). N is a **ceiling, not a target**: only mutually independent questions — where one answer would not change how another is phrased — may share a turn. When the next decision genuinely forks on an answer, the griller returns a single question.
- Answer and park a whole batch in one state transition. Each answered question yields its own resolution; parked questions yield none and leave their unknown `parked`.
- Compute staleness once per batch from a shared `askedAt`, replacing per-question staleness, which is meaningless when a human answers one question immediately and another twenty minutes later.
- Accept unprompted human input mid-interview as **operator notes**, consumed as authoritative input on the next griller turn and optionally seeding a human-authored fog entry.
- Keep the flat `reflectBrief.confirmed` string authoritative for the griller while storing the structured reflector output alongside it, so the dashboard can offer a section-wise editor without changing the griller's input contract.
- Give the dashboard a change `signature` (state revision, job status, event sequence) so polling short-circuits instead of refetching and re-serializing the full run detail every 1.8 seconds.

## Consequences

- The human can see how much interview remains, and the resolution metric gains a real denominator. This is the property the fog provided and grill-me had lost.
- Independent decisions cost one round-trip instead of three, and the human answers at their own pace rather than waiting between questions.
- Batching trades away some adaptivity: a question asked alongside another cannot be informed by that other's answer. Making N a ceiling rather than a target confines this to decisions the griller judges orthogonal, but the judgment is the model's and a poor batch produces a worse interview than a poor single question. This is the main quality risk of the change and is worth watching in real runs.
- "Accept all recommendations" makes a fast path out of a visible set of recommendations. It is honest in that every recommendation is on screen when it is clicked, but it does invite rubber-stamping if it becomes habit.
- Partial batch submission blocks rather than silently auto-parking unanswered questions: dropping an interview answer implicitly is worse than asking for an explicit skip.
- `RunState` additions all carry schema defaults, so run files written before this change still parse and resume; `CONFIG_VERSION` is bumped for the new workflow setting.
- The register is a projection of the griller's judgment, not ground truth. It can be wrong or incomplete in the same way any model output can, and it is not a commitment that the interview ends after the listed entries.

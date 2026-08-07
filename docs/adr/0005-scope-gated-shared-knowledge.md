# ADR 0005: Scope-gated retrieval permits shared knowledge without default project leakage

## Status

Accepted

## Context

Skills and rules are useful across projects, but project documentation can contain conventions and implementation detail that must not be injected into an unrelated project's model context. Sending every document to every agent wastes tokens and makes accidental cross-project guidance likely.

## Decision

The local knowledge index stores scope and visibility metadata with every document and chunk.

- `global` documents are eligible for every query.
- `project` documents are eligible for the active `knowledge.projectId`.
- A document from another project is eligible only when the caller explicitly names that project and its visibility is `shared`.
- `private` and `restricted` project documents cannot cross the project gate in the local implementation.
- A configured `knowledge.sharedIndexDirectory` allows multiple project roots to write to one index; document identity includes scope, project id, and source path to avoid collisions.
- Filtering occurs before lexical document-frequency calculation and scoring, so an excluded document cannot influence either results or relevance scores.

## Consequences

- Existing string knowledge sources remain compatible and are interpreted as private sources of the configured project.
- The current implementation is an offline lexical RAG pilot; embeddings and a remote authorization-aware retrieval service remain replaceable extensions.
- A cross-project CLI query is intentional and auditable in shell history, but a future remote service must authenticate the caller and perform authorization independently of client-provided project ids.

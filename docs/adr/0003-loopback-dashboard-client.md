# ADR 0003: The dashboard is an authenticated loopback client

## Status

Accepted

## Context

Operators need one place to create and observe runs, answer human questions, inspect test output and session handoffs, recover blocked work, and search local knowledge. A second in-memory workflow model would reintroduce the split-brain recovery problems the durable harness was designed to remove.

## Decision

- Ship a dependency-free dashboard from the harness process and bind it only to `127.0.0.1`.
- Generate a fresh bearer token for each server process and require it for every API request.
- Treat `.agent-harness/runs/<runId>/state.json` and its companion artifacts as authoritative; the UI owns no durable lifecycle state.
- Route mutations through the same engine methods used by the CLI and serialize them in one bounded queue.
- Allow the UI to read only whitelisted run artifacts and add knowledge only from paths contained by the configured workspace.
- Keep the CLI as an equivalent headless and automation interface.

## Consequences

- Closing or refreshing the browser cannot lose or corrupt a run.
- A CLI command and the dashboard observe the same checkpoints, events, questions, and evidence.
- The server is intentionally local rather than a remotely deployable multi-user control plane.
- Horizontal workers, remote authentication, and distributed queue semantics remain out of scope until there is a concrete need.
- Visible-tab polling is an observation aid only. It must preserve operator chrome (scroll offsets, open disclosures, in-progress HITL drafts) so background refresh never masquerades as a full page reload; see `packages/agent-harness/docs/ui-polling.md`.

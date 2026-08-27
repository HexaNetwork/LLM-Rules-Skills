# Agent harness design

`@hexanetwork/agent-harness` is one container-only, durable path from an idea or ticket to a reviewed pull request.

## Product surface

The **WebUI is the product**. A single operator should be able to install prerequisites, register projects, start and steer runs, answer gates, inspect evidence, recover from failures, and publish — without opening a terminal except to start the coordinator once.

The HTTP/SSE API is the authority. The static dashboard in `ui/` is the reference client and must expose every operator-facing capability the API offers. The CLI is a thin optional client for automation and bootstrap (`serve`, development resets). New operator features land in the API and WebUI first; CLI parity is optional and must never be required for normal use.

If an action exists only on the CLI, that is a product gap — not an intentional split.

## Architecture

The production topology is deliberately small: one coordinator owns a SQLite control plane, a durable command queue, per-run leases, six pure workflow steps, Docker/Git control, and one HTTP/SSE API. The WebUI and CLI are clients of that API; they never create their own coordinator.

Each run has a detached worktree and at most one replaceable project container. Clarification, specification, and environment planning execute through the neutral runner. Project setup, implementation, review, and validation execute inside the generated project image. The host never executes project commands, and containers never receive the Docker socket, harness database, control checkout, sibling runs, or publication credentials.

State changes are SQLite transactions. External actions have stable `run/step/kind/ordinal` keys and are reconciled before execution. Each leased command performs at most one external action. Pure completion enqueues the next command instead of recursing. Provider output is stored before schema handling or cleanup-sensitive work.

The supported workflow is `clarify -> specify -> provision-environment -> implement -> validate -> publish`. Tickets use the same steps with pre-supplied input. There are no production fake agents, host execution modes, migrations, compatibility readers, dynamic plugins, image repair, or language detection switches.

The database schema version is exact. During development, an incompatible home is reset with `agent-harness reset-home` (WebUI control for this is planned). Git history is the archive for the pre-rebuild system.

### Known WebUI gaps

These API capabilities exist but are not yet exposed in the dashboard. They should be treated as backlog, not CLI-only features:

- **Publish run** — `publish-run` command (CLI: `agent-harness publish`)
- **Workflow selection** — API accepts `workflowId`; UI always uses the default workflow
- **Per-run config overrides** — API accepts `config`; UI does not
- **Reset harness home** — development wipe (`reset-home`) is CLI-only today

## WebUI surfaces

The dashboard is organized around five operator surfaces (see also `docs/plans/lean-harness-rebuild.md`):

1. **Setup** — Docker daemon check and neutral runner image build.
2. **Projects and new run** — register repositories, pick base branch, start fresh or existing-project runs.
3. **Operator gate** — submit required answers; retry or cancel blocked runs (publish control planned).
4. **Timeline and telemetry** — live events, agent sessions, token/cost usage, step outputs, artifacts.
5. **Diagnostics** — durable run state for recovery and support.

The UI renders typed API resources and submits commands. It does not embed orchestration rules or maintain a separate in-memory run model.

## Related documents

| Document | Scope |
| --- | --- |
| `packages/agent-harness/design.md` (this file) | Current rebuild: topology, product surface, runtime rules |
| `docs/plans/lean-harness-rebuild.md` | Full rebuild plan: mandate, durable state, API/UI spec, deletion ledger |
| `docs/adr/0001-executable-agent-harness.md` | Original harness decision (pre-rebuild; historical) |
| `docs/adr/0018-fresh-modular-harness.md` | Modular workflow direction (partially superseded by lean rebuild) |
| `GLOSSARY.md` | Shared terms (`Project`, run lifecycle vocabulary) |

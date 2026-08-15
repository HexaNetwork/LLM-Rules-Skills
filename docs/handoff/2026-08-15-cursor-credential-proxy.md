# Handoff: Cursor credential proxy

**Date:** 2026-08-15
**Branch:** `harness/cleanup-published`
**Status:** in-progress

## Summary

This session tested the recoded Docker-only agent harness against `D:\Dev\LLM\Emperor-Test-Harness`, proved that mounting a Cursor credential file into the worker is unsafe, and replaced that design with an implemented host-owned HTTPS provider proxy. The latest live proof validates host-only credential ownership, the Linux sandbox, TLS, provider access, auth injection, and the create/send/stream/wait phases, but the initial run still ends with `Connection stalled`, leaving resume/cancel/dispose unproven. Agent `07e2acec-18f0-4f71-8614-d785c15acbb9` ("Diagnose persistent stream stall") is **IN PROGRESS**; production remains fail-closed.

## Goal

Run the Docker-only agent harness for real against `D:\Dev\LLM\Emperor-Test-Harness` without exposing a Cursor API credential to the worker or delegated tools. The first run encountered the intentional release block on `CURSOR_API_KEY` secret-file mounting, so the scope expanded from a live smoke test to proving the credential boundary and implementing a host-owned provider broker capable of supporting the complete Cursor SDK lifecycle.

## Accomplished

- Ran a real Cursor credential-isolation smoke with a temporary, session-only key. The parent Cursor read path exposed the exact credential bytes while a delegated read was denied; because the worker and tools share UID 10001, file modes cannot protect a worker-readable key. Production secret-file mounting was therefore disabled unconditionally.
- Planned and implemented the host-owned provider proxy described in `docs/plans/cursor-credential-host-proxy.md`. The real key stays in the host process; the worker receives only a short-lived, run-scoped broker token and the public CA.
- Added host TLS/CA lifecycle, an HTTPS listener with a `host.docker.internal` SAN, exact route authorization, upstream auth substitution, redirect rejection, redaction and metadata-only audit, broker-token renewal/revocation, proof-aware runtime status and CLI output, an SDK 1.0.27 contract recorder, a recorder that runs in the hardened Linux worker image, and exact proof-tuple gating.
- Fixed the live smoke iteratively:
  1. Rebuilt a stale worker image and corrected mangled report-sentinel redaction.
  2. Allowed the Cursor Linux sandbox to use `seccomp=unconfined` while retaining dropped capabilities.
  3. Routed SDK model-list `GET /v1/models` to `api.cursor.com` and AgentService/auth traffic to `api2.cursor.sh`.
  4. Moved contract recording from Windows into the exact hardened Linux worker image.
  5. Narrowly allowed `POST /aiserver.v1.BidiService/BidiAppend`.
  6. Changed BidiAppend from request/response buffering to bounded incremental streaming with backpressure, abort handling, and limits.
- Latest live proof tuple before the active investigation: worker `sha256:d7b472a68aeec6652ed988aed2e0970d3a61f2575867fdfa73d21a5fecabd574`, SDK 1.0.27, contract v5, proxy v3. Host-only-key, Linux sandbox runtime, TLS, live provider request, and auth injection all passed; create/send/stream/wait reported true. BidiAppend returned 200 and was classified as streaming, but `Connection stalled` prevented resume/cancel/dispose from going green.
- Verification completed before the active investigation changes: typecheck and build passed; 21 focused unit tests and 5 integration streaming tests passed. Earlier full runs passed 614 unit tests, 33 integration tests, and Docker isolation; these earlier results do not necessarily validate changes currently being made by the in-progress investigation.

## Key decisions

- Never mount or otherwise materialize `CURSOR_API_KEY` in the Docker worker. The live proof showed that a worker-readable file is also readable from Cursor's parent tool path under the shared UID.
- Keep the provider credential host-only and treat the run-scoped broker token as an agent-readable, short-lived capability with narrow authorization, renewal, and revocation.
- Allow only provider routes demonstrated by the pinned SDK contract. Do not broadly allowlist observed bootstrap or analytics routes.
- Keep production fail-closed until create/send/stream/wait/resume/cancel/dispose are all green for the exact tuple of worker image, SDK 1.0.27, contract/proxy versions, model, and TLS identity.
- Use bounded incremental streaming for BidiAppend so the proxy preserves duplex behavior, backpressure, aborts, and limits instead of buffering to EOF.

## Current state

### Git

- **Branch:** `harness/cleanup-published`
- **Uncommitted:** yes — the repo-state snapshot before adding this handoff had 23 modified tracked paths and 20 untracked status entries; this handoff adds one untracked file. There was no staged diff. The unstaged tracked diff was 23 files, 1,226 insertions, and 68 deletions; untracked files are not represented in that stat. The working tree contains extensive mixed changes, and not every path should be attributed to this feature.
- **Recent commits:** `ffcd3ea Update harness tests for Docker-only host and worker ownership.`; `9d5fd19 Separate host run bootstrap/control from worker workflow runtime.`; `f4b2926 Drop local-worktree config, domain, and git infrastructure.`
- **Session commits:** none — no commit was requested or made by this parent session.

### Code areas touched

| Area | Notes |
|------|-------|
| `docs/plans/cursor-credential-host-proxy.md` | Host-owned credential-proxy plan, threat boundary, transport contract, and proof requirements. |
| `packages/agent-harness/src/infrastructure/provider-proxy/` | Cursor route contract, HTTPS listener, TLS/CA handling, proxy authorization, redaction, audit, and streaming. |
| `packages/agent-harness/src/application/cursor-*` | Isolation probe, SDK contract recorder, live proof orchestration, and smoke child. |
| `packages/agent-harness/src/application/worker-provider-credentials.ts` | Run-scoped broker-token issue, renewal, and revocation flow. |
| `packages/agent-harness/src/worker/provider-protocol.ts` and `src/ui/http/routes/worker-provider.ts` | Worker/host provider protocol and host routes. |
| `packages/agent-harness/src/infrastructure/container/container-spec.ts`, `src/application/docker-worker-session.ts`, and `src/worker/run-worker.ts` | Hardened Linux worker wiring, CA/broker delivery, sandbox settings, and fail-closed execution. |
| `packages/agent-harness/src/application/execution-runtime-status.ts` and `src/cli/create-cli.ts` | Proof-aware status and the `cursor-provider-smoke` CLI surface. |
| `packages/agent-harness/tests/{unit,integration,docker}/` | Credential isolation, contract, TLS, proxy, worker routes, streaming, and proof coverage. |

## Open items

- [ ] Wait for and consume the result from agent `07e2acec-18f0-4f71-8614-d785c15acbb9` ("Diagnose persistent stream stall"). It is adding metadata-only chunk/first-byte diagnostics, verifying true duplex behavior, and determining whether a narrowly required bootstrap route or HTTP Connect header/timeout semantics cause the stall. Do not assume its result before it completes.
- [ ] Rebuild the harness/worker image if the investigation changes runtime code, then rerun `execution cursor-provider-smoke --repository "D:\Dev\LLM\Emperor-Test-Harness" --force --json` with a new temporary session-only key. Require meaningful progress counters plus create/send/stream/wait/resume/cancel/dispose all green for the exact proof tuple.
- [ ] Clear and revoke the temporary key immediately after every live run; never persist or copy its value into source, logs, handoffs, or run state.
- [ ] If diagnostics establish that another route is essential, add only that exact method/path/origin with a contract test and metadata-only audit evidence. Do not broadly allowlist the currently denied routes.
- [ ] Rerun typecheck/build, focused proxy/streaming tests, and the relevant full unit/integration/Docker suites after the active investigation lands.
- [ ] Keep production execution disabled until the proof tuple is fully green, then disentangle feature changes from unrelated working-tree changes before any commit is requested.

## Blockers

The live SDK run still ends with `Connection stalled`. That prevents resume/cancel/dispose from being proven and therefore blocks production enablement. The persistent-stream-stall investigation is active and its result is not yet known.

## Context for next session

Read `docs/plans/cursor-credential-host-proxy.md` first. The critical invariant is that the real Cursor key never crosses into the worker, while the worker-visible broker token authorizes only one run and the exact pinned provider contract.

The exact denied routes observed so far are:

- `DashboardService/GetUserPrivacyMode`
- `ServerConfigService/GetServerConfig`
- `AnalyticsService/BootstrapStatsig`
- `DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam`
- `AnalyticsService/TrackEvents`

Their presence alone is not evidence that they are required. Use the active investigation's metadata-only first-byte/chunk/progress evidence to decide whether any single route must be added. Preserve redirect rejection, redaction, origin pinning, bounded streaming, backpressure, abort behavior, and proof-tuple checks.

The latest proof's create/send/stream/wait booleans are useful but insufficient: the rerun must show actual progress counters and all lifecycle phases, including resume/cancel/dispose, must be green. Revoke and clear each temporary live-test key after use.

## References

- `docs/plans/cursor-credential-host-proxy.md`
- `docs/plans/docker-only-state-service.md`
- `docs/adr/0016-docker-only-host-owned-state.md`
- `docs/adr/0017-cordis-composed-docker-runtime.md`
- No tracker issue or pull request links were mentioned in this session.

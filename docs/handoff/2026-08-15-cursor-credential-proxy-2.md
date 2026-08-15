# Handoff: Cursor provider stream stall

**Date:** 2026-08-15
**Branch:** `harness/cleanup-published`
**Status:** blocked

## Summary

This session continued the Docker-only Cursor credential-proxy work from
`docs/handoff/2026-08-15-cursor-credential-proxy.md`. It fixed a real
half-duplex proxy defect and strengthened the release proof with metadata-only
byte progress, but two live proofs still ended with `Connection stalled`
before resume/cancel/dispose. Production remains fail-closed.

The latest proof shows that the host-only credential boundary, hardened Linux
worker, TLS, authentication exchange, model discovery, ServerConfig request,
and BidiAppend upload all work. No AgentService `RunSSE` download is ever
opened, so the next investigation should focus on the pinned SDK bridge
protocol/transport rather than broadening the route allowlist.

## Goal

Finish the new container workflow against
`D:\Dev\LLM\Emperor-Test-Harness`: keep the real Cursor credential host-only,
make the provider proxy faithfully support the pinned SDK lifecycle, and
enable production only when create/send/stream/wait/resume/cancel/dispose are
all proven for the exact release tuple.

## Accomplished

- Reproduced the streaming defect with the deterministic integration test
  `forwards delayed BidiAppend chunks before EOF and aborts upstream on client
  disconnect`. Before the fix it timed out after 40 seconds and left teardown
  hanging.
- Identified the defect as Node Fetch's `duplex: "half"` path not providing the
  required full-duplex behavior while the request upload remained open.
- Replaced the production BidiAppend transport with native Node HTTP(S), while
  retaining injectable Fetch behavior for unit tests. The proxy now exposes
  upstream response bytes before request EOF and preserves bounded demand,
  byte limits, idle/total timeouts, abort propagation, redirect rejection,
  fixed origins, and authorization substitution.
- Added a native non-streaming production transport with `agent: false` to
  avoid pooled upstream sockets; test-injected Fetch remains supported.
- Extended provider proof operations with metadata-only `requestBytes`,
  `responseBytes`, and `durationMs`. The proof now requires positive
  BidiAppend upload progress plus positive AgentService RunSSE download
  progress; selecting a streaming route alone cannot pass.
- Ran full verification after the duplex fix: 627 unit tests and 36 integration
  tests passed. The required Docker suite passed 8 tests, although its
  credential-gated files skipped without environment configuration.
- Explicitly ran the maintained-image Docker provider contract using worker
  digest `sha256:8e490bb73782bf4c52c53f19690b29f1d9edac47b96ca9dec8ac4253c0f929bc`;
  both the Linux SDK-helper check and trusted
  `host.docker.internal` HTTPS check passed.
- After the latest route/transport changes, focused verification passed:
  15 provider unit tests, 4 HTTPS integration tests, typecheck, build, worker
  rebuild, and the sandbox isolation probe.
- Rebuilt the current maintained worker as
  `agent-harness-worker:local@sha256:6bb198f64465440f528b8e698b982c0d4f8b249324f422dd0246c6c67c52d92c`.
- Ran two real credential-gated proofs with temporary clipboard-delivered
  keys. The key was never printed or passed as an argument, and the
  environment, clipboard, proof containers, and interrupted wrappers were
  cleared afterward.

## Live proof evidence

### Contract v6 / proxy v4

- Worker:
  `sha256:8e490bb73782bf4c52c53f19690b29f1d9edac47b96ca9dec8ac4253c0f929bc`
- Proof identity: `543baa118b240c40`
- Host-only key, Linux SDK runtime, TLS, live requests, and host auth injection
  passed.
- BidiAppend returned 200, sent 48 request bytes, returned 0 response bytes,
  and completed in 50 ms.
- No RunSSE request appeared. The initial SDK run ended
  `Connection stalled`; resume/cancel/dispose remained gaps.

### Contract v7 / proxy v4

- Worker:
  `sha256:6bb198f64465440f528b8e698b982c0d4f8b249324f422dd0246c6c67c52d92c`
- Proof identity: `9a7eeb9b42152b7a`
- Narrowly allowed
  `POST /aiserver.v1.ServerConfigService/GetServerConfig` as an experiment.
  It returned 200 with 12,715 response bytes.
- BidiAppend still returned 200 with 48 request bytes and 0 response bytes.
- No RunSSE request appeared and lifecycle behavior did not improve:
  create/send/stream/wait resolved, the run ended `Connection stalled`, and
  resume/cancel/dispose remained gaps.
- This disproves ServerConfig denial as the primary cause. The route is still
  present in the working tree but should not be treated as proven necessary.

## Key decisions

- Never mount, persist, or otherwise deliver `CURSOR_API_KEY` to the worker.
- Keep production fail-closed until the exact tuple has green lifecycle and
  stream-progress evidence.
- Do not allow Analytics, privacy, or team-settings routes merely because the
  SDK attempted them. Their denial has not been shown to cause the stall.
- Treat BidiAppend as an upload channel that may legitimately return an empty
  response. Require response progress from an AgentService RunSSE operation
  instead of requiring BidiAppend response bytes.
- Investigate SDK bridge headers, trailers, secondary transport seams, and
  process handles before adding another provider route.

## Current state

### Git

- **Branch:** `harness/cleanup-published`
- **Uncommitted:** yes — 24 tracked paths are reported modified and 21
  untracked status entries existed before this handoff. The unstaged textual
  tracked diff is 23 files with 1,226 insertions and 68 deletions; there is no
  staged diff. The tree contains mixed pre-existing and credential-proxy work,
  and untracked files are not included in that stat.
- **Recent commits:** `ffcd3ea Update harness tests for Docker-only host and
  worker ownership.`; `9d5fd19 Separate host run bootstrap/control from worker
  workflow runtime.`; `f4b2926 Drop local-worktree config, domain, and git
  infrastructure.`
- **Session commits:** none.

### Code areas touched

| Area | Notes |
|------|-------|
| `packages/agent-harness/src/infrastructure/provider-proxy/cursor-provider-proxy.ts` | Native streaming and buffered transports, limits, aborts, and metadata-only counters. |
| `packages/agent-harness/src/infrastructure/provider-proxy/cursor-provider-contract.ts` | Current tuple is contract v7/proxy v4; provisional ServerConfig route added. |
| `packages/agent-harness/src/application/cursor-provider-contract-recorder.ts` | Requires BidiAppend upload and RunSSE download byte progress. |
| `packages/agent-harness/src/application/cursor-provider-proof.ts` | Persists redacted byte/duration operation metadata. |
| `packages/agent-harness/tests/integration/cursor-provider-https.test.ts` | Deterministic full-duplex and client-abort regression coverage. |
| `packages/agent-harness/tests/unit/cursor-provider-{proxy,contract-recorder}.test.ts` | Exact-route, auth, streaming, limit, and proof-progress coverage. |
| `docs/plans/cursor-credential-host-proxy.md` | Existing threat model, stop conditions, and proof requirements. |

## Open items

- [ ] Inspect the pinned SDK 1.0.27 bundle/native helper and compare direct
      versus proxied metadata: request header names, response header names,
      trailers, connection lifecycle, and any second transport not honoring
      `CURSOR_BACKEND_URL`. Do not record bodies or credential values.
- [ ] Determine why no `/agent.v1.AgentService/RunSSE` or
      `/aiserver.v1.AgentService/RunSSE` request starts after BidiAppend
      succeeds. Add one falsifiable probe at a time.
- [ ] Remove the provisional ServerConfig route if it is not independently
      required; its successful response did not change the failure.
- [ ] Fix the `cursor-provider-smoke` process-handle leak. Both live commands
      printed their final JSON but stayed alive until their PowerShell process
      trees were terminated. Docker proof containers had already exited.
- [ ] Rerun the full unit/integration/Docker suites after the latest v7/native
      buffered changes; the full 627/36 result predates those final edits.
- [ ] Rerun
      `execution cursor-provider-smoke --repository "D:\Dev\LLM\Emperor-Test-Harness" --force --json`
      only after adding targeted diagnostics or a protocol fix. Require
      BidiAppend upload bytes, RunSSE download bytes, and all seven lifecycle
      phases green.
- [ ] Clear the host environment and clipboard immediately after every proof,
      remove disposable proof containers, and revoke the temporary key in the
      Cursor dashboard.
- [ ] Complete the plan's direct/delegated absence and capability-abuse checks
      after the lifecycle proof is green.

## Blockers

The pinned SDK still reports `Connection stalled` after a successful auth
exchange, model list, ServerConfig response, and BidiAppend upload. No RunSSE
download request reaches the proxy, so resume/cancel/dispose cannot be proven.
The exact missing SDK bridge protocol behavior is not yet identified.

The live smoke CLI also retains process handles after printing its result,
requiring external termination and explicit credential cleanup.

## Context for next session

Read `docs/plans/cursor-credential-host-proxy.md` and this handoff before
editing. Start from the deterministic HTTPS regression and the latest v7 proof
operation list; do not reopen already-disproved theories about half-duplex
upload or ServerConfig denial.

The still-denied routes are:

- `DashboardService/GetUserPrivacyMode`
- `AnalyticsService/BootstrapStatsig`
- `DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam`
- `AnalyticsService/TrackEvents`

Their presence is not evidence that they are required. Preserve exact route
authorization, fixed origins, redirect rejection, key redaction, bounded
streaming, backpressure, abort handling, and release-tuple gating.

## References

- `docs/handoff/2026-08-15-cursor-credential-proxy.md`
- `docs/plans/cursor-credential-host-proxy.md`
- `docs/plans/docker-only-state-service.md`
- `docs/adr/0016-docker-only-host-owned-state.md`
- `docs/adr/0017-cordis-composed-docker-runtime.md`
- No tracker issue or pull request was used.

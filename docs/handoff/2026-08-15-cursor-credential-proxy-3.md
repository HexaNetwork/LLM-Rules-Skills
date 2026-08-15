# Handoff: Cursor provider lifecycle green

**Date:** 2026-08-15
**Branch:** `harness/cleanup-published`
**Status:** in-progress — lifecycle green; direct/delegated absence proof and native Linux lane remain

## Summary

The host-owned Cursor provider proxy completed its first fully green live proof
with contract v8 / proxy v5. The real key remained host-only, all seven SDK
lifecycle phases passed, and both the BidiAppend upload and RunSSE download
showed non-zero byte progress. Credential-free capability-abuse and container
topology coverage is green; behavioral direct/delegated agent searches still
need to be added to a future credential-gated host-proxy proof.

## Goal

Run the pinned Cursor SDK in the hardened Docker worker while keeping
`CURSOR_API_KEY` exclusively in host memory. Production remains gated on an
exact release-tuple proof and must never fall back to a worker environment
variable, argv value, secret file, workspace artifact, or mount containing the
real credential.

## Root cause of the two-day stall

- BidiAppend was correctly identified as a bidirectional upload channel, but
  AgentService RunSSE was still handled by the buffered response path.
  RunSSE is server-streaming: waiting for upstream EOF withheld every event
  from the SDK while the long-lived response waited for the SDK to advance.
  This formed the apparent `Connection stalled` deadlock.
- Proxy audit was emitted only when a request completed. The hung RunSSE
  request therefore left no audit entry, making earlier reports look as though
  the SDK had never opened RunSSE.
- The HTTP/2 hypothesis was disproved. SDK 1.0.27 completed through the pinned
  HTTP/1.1 BidiAppend + RunSSE transport while
  `ServerConfigService/GetServerConfig` remained denied. HTTP/2 passthrough is
  not required for this pinned contract.

## What changed in contract v8 / proxy v5

- RunSSE is classified and forwarded as a server-streaming route: its bounded
  request message remains buffered, but response headers and chunks are
  forwarded before upstream EOF.
- The SDK's `x-cursor-streaming` edge marker is preserved so the Cursor edge
  does not buffer RunSSE.
- Streaming audit now exposes metadata-only request progress before completion
  and a final byte/duration record when the stream closes. Bodies,
  authorization values, broker tokens, and key material remain excluded.
- BidiAppend remains the separately bounded bidirectional streaming route.
- `GetServerConfig` was removed from the allowlist. Denied Analytics,
  Dashboard, and ServerConfig requests return 404 and are tolerated by the
  pinned SDK.

## Green live proof evidence

- **Proof identity:** `b96436cfc9aa9260`
- **Worker image:**
  `agent-harness-worker:local@sha256:6bb198f64465440f528b8e698b982c0d4f8b249324f422dd0246c6c67c52d92c`
- **Compatibility:** Cursor SDK 1.0.27, contract v8, proxy v5
- **Lifecycle:** create, send, stream, wait, resume, cancel, and dispose all
  reported `ok`
- **Transport progress:** BidiAppend uploaded non-zero request bytes; RunSSE
  downloaded 7,648 response bytes
- **Credential custody:** host-only key check green;
  `keyDeliveredToWorker: false`
- **Denied, tolerated routes:** Analytics, Dashboard, and ServerConfig requests
  returned 404 without preventing lifecycle completion
- No credential value, authorization header, broker token, prompt body, or
  response body is recorded in this document or the redacted proof.

## Security checks completed without a live key

- Production recorder argv is foreground, digest-pinned, UID 10001,
  read-only, capability-dropped, sandbox-compatible, and fixed to the SDK smoke
  child. Its allowlisted environment contains the backend URL, broker token,
  model, public CA path, and `HOME`; it contains no `CURSOR_API_KEY`.
- Recorder mounts are limited to the workspace volume and public CA. No Cursor
  key file or host workspace is mounted, and key-shaped/credential-bearing argv
  is rejected.
- Broker credentials are 256-bit, hash-only at rest, and bound to run, worker,
  provider, protocol, generation, and expiry.
- Automated abuse checks reject missing, cross-run, cross-worker, expired,
  revoked, and wrong-protocol capabilities.
- Provider and state credentials are not interchangeable.
- Exact route/method classification rejects unlisted routes, encoded traversal,
  absolute URLs, scheme-relative URLs, and `CONNECT`.
- Redirects, caller authorization/cookies, oversized buffered and streaming
  bodies, stream timeouts, and excess concurrency fail closed.
- A recording upstream verifies caller authorization is removed and exactly
  one host-owned authorization value is injected. Exchanged Cursor session
  credentials remain host-only.
- Windows Docker Desktop reached the HTTPS broker through
  `host.docker.internal`, validated the host CA, used the maintained Linux x64
  helper, and did not expose the host canary in stdout or stderr.

## Verification run

- Final focused unit security suite: **40 passed, 0 failed, 0 skipped** across
  four files. This includes **15 passing proxy tests** after adding explicit
  absolute-URL, `CONNECT`, and concurrency-abuse assertions.
- Provider credential-separation integration test: **1 passed, 0 failed,
  0 skipped**.
- Docker provider/isolation command: Vitest reported **3 passed, 0 failed,
  0 framework-skipped**. Of those, **2 Docker checks actually executed and
  passed** (maintained helper and trusted HTTPS reachability); the historical
  direct/delegated secret-file test returned early because no live key was
  supplied, so it is a **logical credential-gated skip** despite Vitest
  counting the test as passed.
- No live credential-gated smoke was rerun.

## Key decisions

- Do not use the historical `cursor-credential-isolation` secret-file probe as
  evidence for the replacement architecture. It deliberately mounts the real
  key and tests the already-rejected same-UID filesystem boundary.
- Credential-free topology tests prove the real key is not configured for
  worker delivery; they do not substitute for behavioral direct/delegated
  agent-search evidence.
- Keep the exact route allowlist. Do not admit denied telemetry/dashboard
  routes merely because the SDK attempts them.
- Preserve release-tuple gating and host-only custody. Missing or mismatched
  proof remains a production blocker.

## Current state

### Git

- **Branch:** `harness/cleanup-published`
- **Uncommitted:** yes — the tree already contained mixed credential-proxy and
  unrelated work. This session added only focused provider-proxy test coverage,
  the plan status note, and this new handoff.
- **Recent commits:** `ffcd3ea Update harness tests for Docker-only host and
  worker ownership.`; `9d5fd19 Separate host run bootstrap/control from worker
  workflow runtime.`; `f4b2926 Drop local-worktree config, domain, and git
  infrastructure.`
- **Session commits:** none.

### Code areas touched

| Area | Notes |
|------|-------|
| `packages/agent-harness/tests/unit/cursor-provider-proxy.test.ts` | Added explicit absolute/scheme-relative URL, `CONNECT`, and concurrency capability-abuse assertions. |
| `docs/plans/cursor-credential-host-proxy.md` | Added a status-only verification note distinguishing green automated checks from residual live proof. |
| `docs/handoff/2026-08-15-cursor-credential-proxy-3.md` | Recorded the resolved stall, proof evidence, verification, and remaining work. |

## Open items

- [ ] Extend the replacement host-proxy proof with direct and delegated agent
      phases that search the worker-visible environment, argv, mounts,
      filesystem, `/proc`, workspace, logs/events, and exported artifacts for
      `CURSOR_API_KEY` or a reusable Cursor credential. Record booleans and
      redacted classifications only. This requires a future manually
      clipboard-delivered live key; do not infer it from the green lifecycle
      proof and do not rerun the secret-file probe.
- [ ] Add the native Linux `host-gateway` provider-contract lane. The completed
      proof and focused Docker checks cover Windows Docker Desktop.
- [ ] Decide whether required CI should treat internally gated Docker tests as
      explicit framework skips/failures; the current early-return pattern can
      make an unexecuted credential test appear passed.
- [ ] Complete Phase E cleanup: remove obsolete secret-file CLI/constants and
      stale bootstrap files only after preserving the historical failure
      explanation and upgrade behavior.
- [ ] Review state/RPC same-UID capability exposure as its own hardening item;
      it is intentionally separate from the provider credential boundary.

## Blockers

No blocker remains for the pinned v8/v5 SDK lifecycle. Full replacement-proof
completion is waiting on direct/delegated behavioral absence coverage and the
native Linux lane. The behavioral phases require a future live key supplied by
the user through the established clipboard-only procedure.

## Context for next session

Read `docs/plans/cursor-credential-host-proxy.md` and this handoff first. Start
from the green v8/v5 lifecycle and do not reopen HTTP/2, ServerConfig, or
BidiAppend full-duplex theories without contradictory evidence. Any new
absence phase belongs in the host-proxy proof container and must verify that no
real-key delivery surface exists; it must not mount a secret to prove that a
secret is absent.

## References

- `docs/handoff/2026-08-15-cursor-credential-proxy.md`
- `docs/handoff/2026-08-15-cursor-credential-proxy-2.md`
- `docs/plans/cursor-credential-host-proxy.md`
- `docs/plans/docker-only-state-service.md`
- `docs/adr/0016-docker-only-host-owned-state.md`
- `docs/adr/0017-cordis-composed-docker-runtime.md`

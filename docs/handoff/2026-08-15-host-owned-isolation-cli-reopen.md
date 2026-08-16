# Handoff: Host-owned isolation + CLI reopen leftovers

**Date:** 2026-08-15
**Branch:** `feat/host-owned-worker-isolation`
**Status:** complete

## Summary

Host-owned worker isolation is landed: disposable sandboxes bind the host worktree at `/workspace`, workers get only `HARNESS_RPC_URL` + `HARNESS_WORKER_TOKEN`, and legacy docker-clone / long-lived session / secret-mount / workflow-RPC paths were deleted. Same-session leftovers closed CLI reopen/resume onto `SandboxAgentBackend` with fail-closed host-side Cursor and exact image/model/TLS/SDK/proxy proof revalidation. The credential-gated live Cursor provider-proxy v9 smoke is now green, so production is no longer blocked on missing proof for that exact credential and compatibility tuple.

## Goal

Complete the host-owned worker isolation migration with no extra compatibility architecture, then clear leftovers: (1) CLI reopen helpers must not default to host `createCursorBackend`, (2) live Cursor remains fail-closed until HTTPS provider-proxy SDK/TLS proof is green.

Required end state: TaskExecutionService agent work through disposable `SandboxProvider` sandboxes; create → execute → destroy → revoke per invocation; host owns Git/lifecycle/push; no durable credentials in worker env/argv/fs/mounts; broker model-only (`["model"]`); security policy accepts host worktree bind at `/workspace` and rejects control-state/credential mounts.

## Accomplished

- Migration commit `43c9070`: UI `startWorker` → `SandboxAgentBackend` → `DockerSandboxProvider` create/exec/destroy + capability revoke; host worktree at `/workspace`; credentials on host provider proxy; broker model-only (`provider/cursor/bootstrap` + `renew`, capabilities `["model"]`).
- Deleted (not adapted): `ensureDockerWorkerSession` / `docker-worker-session`, `DockerCloneProvisioner`, `docker-clone` workspace kind, `docker-run-proxy`, `worker-workspace-provisioner`, `workspace-cleanup`, `RpcRunStatePort` / `RpcRunRepository`, secret-file Cursor path, durable worker state API.
- Leftovers commit `2a924a0`: CLI reopen/resume routes through disposable sandboxes; host-side execution fails closed; every production reopen revalidates exact image/model/TLS/SDK/proxy proof tuple.
- Provider proxy v9 live proof is green for image `agent-harness-worker:local@sha256:69257763091d60612e876eed5513ca2d91b45fc9b0fde7c8624ede16cbb94fcc`, model `composer-2.5`, TLS identity `sha256:4215992ef3925e6194f89be624035ed0ee55910aff86d596d2aee0fae6dd90e0`, SDK `1.0.27`, contract `cursor-sdk-1.0.27-linux-container-v9`, and proxy `5`.
- Proof identity `d3f35ab58153a1ed`, proved at `2026-08-16T01:06:15.752Z`, is present in the Emperor-Test-Harness external state root and passes the production cache loader, exact matcher, and assertion.
- Verification after migration: unit 611, integration 23, Docker isolation 5, typecheck clean.
- Verification after leftovers: unit 612, integration 23, Docker isolation+HTTPS proxy 7, acceptance 3, typecheck/build passed.
- Post-smoke verification: `npm run build` passed; targeted proof/wiring tests passed (2 files, 12 tests); a redacted production-module check loaded the external proof cache and accepted the exact tuple.

## Key decisions

- Rip-and-tear legacy paths instead of adapting them (no `docker-clone` / long-lived worker session compatibility).
- Do not implement knowledge/progress broker endpoints just because capability names existed — advertise `["model"]` only.
- Host owns lifecycle, Git commits, and push/publication; worker never holds Cursor/provider/Git credentials.
- Live Cursor production accepts only the exact green tuple, including the host-key fingerprint. Key rotation or revocation intentionally requires a new proof.

## Current state

### Git

- **Branch:** `feat/host-owned-worker-isolation`
- **Uncommitted:** no after this handoff update is committed
- **Recent commits:**
  - `2a924a0` Route CLI reopens through disposable sandboxes
  - `43c9070` Move agent work into disposable host-worktree sandboxes.
- **Remote:** not pushed

### Code areas touched

| Area | Notes |
|------|-------|
| Sandbox agent path | UI + CLI reopen via `SandboxAgentBackend` / `DockerSandboxProvider` |
| Provider broker | Model-only bootstrap/renew; credentials stay on host proxy |
| Security policy | Accept `/workspace` host-worktree bind; reject control-state/credential mounts |
| Legacy deletions | docker-clone, ensureDockerWorkerSession, secret mounts, workflow-RPC state ports |
| CLI reopen | No default host `createCursorBackend`; proof-tuple revalidation on reopen |

## Open items

- [ ] Revoke the temporary `CURSOR_API_KEY` in the Cursor dashboard; a future live credential will require a fresh matching proof.
- [ ] Push `feat/host-owned-worker-isolation` when ready (do not push as part of this handoff update).

## Blockers

None for the proof tuple that was smoked. A later key rotation/revocation changes the tuple and correctly fails closed until another live proof is recorded.

## Context for next session

- Prior handoff (migration only, pre-leftovers): `docs/handoff/2026-08-15-host-owned-worker-isolation.md`
- Plans/ADRs: `docs/plans/docker-only-state-service.md`, ADRs 0016/0017
- Vision invariants — do not regress: no secrets in worker; no `/run-state` or worker CAS/lease/snapshot; host commits/push/PR; disposable containers (destroy, never reattach); worker sees `/workspace` + `HARNESS_*` env only
- Pre-cutover `docker-clone` workspace.json records fail closed; finish/export those with an older harness if any remain
- The live SDK made some unclassified Dashboard/Analytics/ServerConfig requests that received expected `404 route_not_allowed` responses from the explicit allowlist; this did not fail the proof.
- Credential-absence diagnostics include `ConnectError: unimplemented [12]` stream-failure noise, while both direct and delegated checks still passed with no key-shaped credential observed.
- `execution status` run without `CURSOR_API_KEY` reports the host credential as unconfigured and cannot reconstruct the key-fingerprinted tuple. This is not a missing-proof result; production accepts the cached proof when the matching host credential is configured.
- Prefer reading this file over the earlier same-day handoff for CLI reopen + live-Cursor blocker state

## References

- `docs/handoff/2026-08-15-host-owned-worker-isolation.md` (migration-only snapshot)
- `docs/plans/docker-only-state-service.md`
- `docs/plans/agent-harness-legacy-sunset.md`

# Handoff: Host-owned worker isolation rip-and-tear

**Date:** 2026-08-15
**Branch:** `feat/host-owned-worker-isolation`
**Status:** completed

## Summary

End-to-end migration to host-owned worker isolation is implemented: disposable sandboxes bind the host worktree at `/workspace`, workers receive only `HARNESS_RPC_URL` + `HARNESS_WORKER_TOKEN`, durable state/Git/publication stay host-owned, and legacy docker-clone / long-lived session / secret-mount / workflow-RPC paths are deleted rather than adapted.

## Goal

Rip the container pipeline to disposable sandboxes over host Git worktrees, with a narrow model-only broker and no durable credentials in the worker.

## Accomplished

### Architecture

- Production UI `startWorker` advances `HarnessEngine` with `SandboxAgentBackend` → `DockerSandboxProvider.create` / `exec` / `destroy` / capability revoke per bounded invocation.
- Host worktree provisioner is the sole production workspace provider; `docker-clone` kind is rejected as pre-cutover.
- Worker broker routes expose only `provider/cursor/bootstrap` and `provider/cursor/renew`.
- Advertised worker capabilities reduced to `["model"]` (no knowledge/progress endpoints).
- Security policy accepts host-worktree bind at `/workspace` (+ public CA under `/run/agent-harness-public/`) and rejects `/run-state` and `/run/secrets` credential mounts.
- Host filesystem export no longer requires RPC chunk reconstruction when the bundle already exists on disk.

### Deleted compatibility

- `ensureDockerWorkerSession` / `docker-worker-session.ts`
- `DockerCloneProvisioner` / `docker-clone` workspace kind
- `docker-run-proxy.ts`, `worker-workspace-provisioner.ts`, `workspace-cleanup.ts`
- `RpcRunStatePort` / `RpcRunRepository`
- Secret-file Cursor path (`cursor-api-key-secret.ts`) and secret-mount container infrastructure
- Durable worker state API surface (snapshot/CAS/lease/bootstrap document)

### Tests / docs

- Unit: sandbox lifecycle + no durable credentials; isolation hardening; broker routes; schema/path updates
- Integration: provider broker routes
- Docker: isolation lane proves bind-mounted worktree + `HARNESS_*` env only + host publish
- ADRs 0016/0017, plan `docker-only-state-service.md`, and README updated
- Follow-up commit `2a924a0` routed CLI reopen/resume through disposable sandboxes and added exact production proof revalidation.
- The live Cursor provider-proxy v9 proof is green for the maintained image/model/TLS/SDK/protocol/contract/proxy tuple. The proof is reusable across host key rotation because credential identity is not part of the isolation boundary.

## Verification (this session)

```text
npm run test:unit          → 89 files / 611 tests passed
npm run test:integration   → 10 files / 23 tests passed
AGENT_HARNESS_REQUIRE_DOCKER=1 npx vitest run --config vitest.docker.config.ts tests/docker/isolation.test.ts
                           → 5 tests passed
npm run typecheck          → clean
```

## Residual concerns

- The authoritative follow-up state is in `docs/handoff/2026-08-15-host-owned-isolation-cli-reopen.md`; the earlier CLI reopen concern was resolved by `2a924a0`.
- Some unclassified Dashboard/Analytics/ServerConfig requests received expected allowlist `404 route_not_allowed` responses during the green live smoke.
- Credential-absence evidence passed with no key-shaped credential observed, despite non-fatal `ConnectError: unimplemented [12]` stream-failure diagnostic noise.
- Proof matching excludes host-key identity. Revoking or rotating the temporary key does not require a fresh isolation smoke; an invalid replacement key fails normal upstream authentication.
- Pre-cutover `docker-clone` workspace.json records fail closed and must be finished/exported with an older harness.

## Vision invariants — do not regress

1. No secrets in the worker (no `CURSOR_API_KEY`, no GH tokens, no secret files).
2. No `/run-state` mount and no worker CAS/lease/snapshot access.
3. Host commits and host push/PR.
4. Disposable containers; destroy and recreate, do not reattach.
5. Worker sees `/workspace` (bind-mounted host worktree) plus env tokens only.

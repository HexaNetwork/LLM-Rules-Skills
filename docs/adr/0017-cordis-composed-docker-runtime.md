# ADR 0017: Cordis-composed Docker-only runtime

## Status

**Superseded** by [ADR 0018](0018-fresh-modular-harness.md). Cordis composition
and a trusted host profile remain; the worker-as-second-harness, provider
proxy, proof-tuple launch gate, and disposable-per-invocation sandbox topology
do not. Kept for decision history.

Was: Accepted. Superseded the implementation topology in
[ADR 0016](0016-docker-only-host-owned-state.md).

## Decision

The harness is composed from trusted, host-installed
`@deepseek-ai/cordis` plugins. The only imperative bootstrap creates a root
context, mounts Loader with the Include and Group builtins, activates one
profile, validates required services, and disposes the partial tree on failure.
Production profiles disable HMR and reject duplicate, disabled, pending, or
untrusted required providers.

The host owns the product workflow and run lifecycle. Agent calls are effects:
each effect creates a sandbox, executes once against the host worktree mounted
at `/workspace`, destroys the sandbox, and revokes its capability.

The host profile owns filesystem state, lifecycle, host worktrees, the secured
Docker adapter, immutable environment image, credential issuer, headless control
server, Git commits, and publication. The dashboard is an optional adapter over
the same services. A sandbox owns only one provider invocation and its local
tool processes.

## Trust and security

- Profile rows and module specifiers are installed harness software. A target
  repository cannot add plugins, patches, setup commands, or module specifiers.
- Every production profile has exactly one security-policy provider. Docker
  `start` operations pass through the secured runtime adapter.
- The worker has one read-write host-worktree bind at `/workspace`. Public CA
  material may be mounted read-only under `/run/agent-harness-public/`.
- Control state and credentials must not appear in mounts, environment,
  arguments, or the workspace. The only harness capability configuration is
  `HARNESS_RPC_URL` plus `HARNESS_WORKER_TOKEN`.
- The root filesystem is read-only, the worker is non-root, all capabilities
  are dropped, `no-new-privileges` and positive resource limits are mandatory,
  host namespaces and the Docker socket are forbidden, and network mode is
  explicit.
- Durable state and publication credentials stay on the host. State RPC uses
  typed artifacts, CAS revisions, idempotency, leases, and fencing.

## Golden-path acceptance contract

A blocking real-Docker test creates a host worktree, executes inside a disposable
sandbox mounted at `/workspace`, destroys it, and proves the control checkout is
unchanged. Docker unavailability is a failure in that required lane, not a skip.
The credential-gated Cursor smoke remains separate.

The deterministic lane proves the production mount layout, workspace writes,
host-state absence, and credential-mount absence. It is not evidence about
Cursor filesystem tools or delegated tasks; the separate real-provider smoke
must prove those without ever mounting `CURSOR_API_KEY`.

The real-provider proof identity is the worker image digest, pinned SDK version,
provider protocol version, compatibility-contract version, proxy version,
model, and TLS identity. It is intentionally not bound to the host API key.
Those fields determine the sandbox, transport, and credential-custody behavior
the proof establishes; rotating the host-held key cannot alter that boundary.
An invalid, expired, or revoked key fails as an ordinary upstream
authentication error at runtime. It does not invalidate isolation evidence or
authorize fallback credential delivery.

The August 2026 real-provider smoke observed delegated denial, no conclusive
direct-parent denial, and exact credential bytes in provider-observed output.
The old report did not retain enough redacted event metadata to prove whether
those bytes came from the read result or another direct-phase SDK event, so the
diagnostic now records that source classification. This uncertainty fails
closed. Because the worker and its Cursor tools share UID 10001, file ownership
and mode bits cannot make a file readable to the worker process while denying
those tools. Secret-file delivery is therefore rejected as a product mechanism,
even if a later diagnostic smoke passes. Production `CURSOR_API_KEY` mounting
stays disabled until the worker uses non-filesystem delivery, such as a host
provider proxy that retains the credential and exposes only provider operations.

## Consequences

`agent-harness vnext dump-config` validates and renders the resolved profile
with secret redaction without starting Docker. Plugin listeners, registrations,
servers, intervals, and workers are effect-owned and have awaited disposal.
Pre-cutover runs are not reinterpreted: operators must finish/export or
explicitly discard them before the final default switch.

A green provider proof is reusable across host key rotation and harness
launches while its exact non-secret compatibility tuple remains unchanged.

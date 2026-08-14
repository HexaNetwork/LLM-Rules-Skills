# ADR 0017: Cordis-composed Docker-only runtime

## Status

Accepted. Supersedes the implementation topology in
[ADR 0016](0016-docker-only-host-owned-state.md); ADR 0016 remains the state,
fencing, and isolation contract.

## Decision

The harness is composed from trusted, host-installed
`@deepseek-ai/cordis` plugins. The only imperative bootstrap creates a root
context, mounts Loader with the Include and Group builtins, activates one
profile, validates required services, and disposes the partial tree on failure.
Production profiles disable HMR and reject duplicate, disabled, pending, or
untrusted required providers.

There are two independent state machines:

1. Host execution lifecycle: `created → image_ready → volume_ready →
   workspace_seeded → worker_starting → worker_ready → running → export_ready
   → settled`. A failed stage records retryability and the last successful
   stage. Every retry inspects labeled resources and validates identity before
   persisting completion; an RPC timeout is never evidence of success.
2. Product workflow: `new`, reflection/interview/planning/execution/scenario
   testing/crystallizing/final review/publication, and terminal states. Product
   advancement starts only after `worker_ready`.

The host profile owns filesystem state, lifecycle, the secured Docker adapter,
Git-bundle workspace source, immutable environment image, credential issuer,
headless control server, and publication. The dashboard is an optional adapter
over the same services. The worker profile owns RPC state, role and phase
registries, provider, knowledge, verification, result export, and the workflow
driver.

## Trust and security

- Profile rows and module specifiers are installed harness software. A target
  repository cannot add plugins, patches, setup commands, or module specifiers.
- Every production profile has exactly one security-policy provider. Docker
  `start` operations pass through the secured runtime adapter.
- The worker has one read-write named volume at `/workspace`; read-only
  bootstrap files may appear only under `/run/secrets`.
- The root filesystem is read-only, the worker is non-root, all capabilities
  are dropped, `no-new-privileges` and positive resource limits are mandatory,
  host namespaces and the Docker socket are forbidden, and network mode is
  explicit.
- Durable state and publication credentials stay on the host. State RPC uses
  typed artifacts, CAS revisions, idempotency, leases, and fencing.

## Golden-path acceptance contract

A blocking real-Docker test must run without a dashboard process. Starting from
an exact fixture commit, it uses the deterministic provider to edit and verify
inside the named volume, exports a hashed result bundle, imports it on the host,
reaches `completed`/`settled`, and proves the control checkout is byte-for-byte
unchanged. Docker unavailability is a failure in that required lane, not a
skip. The credential-gated Cursor smoke remains separate.

The deterministic lane proves the production mount layout with a real
mode-`000` fixture, workspace writes, and host-state absence, but it is not
evidence about Cursor filesystem tools or delegated tasks. Until a real Cursor
credential is supplied to the separate smoke lane and both direct and delegated
reads of the actual `/run/secrets/*` path are denied, `CURSOR_API_KEY` mounting
remains disabled. A missing credential, missing fixture, or skipped delegated
task is a failed proof; no fake provider result may satisfy this release gate.

## Consequences

`agent-harness vnext dump-config` validates and renders the resolved profile
with secret redaction without starting Docker. Plugin listeners, registrations,
servers, intervals, and workers are effect-owned and have awaited disposal.
Pre-cutover runs are not reinterpreted: operators must finish/export or
explicitly discard them before the final default switch.

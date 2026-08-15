# Agent-harness operation ownership

This matrix records the post-cutover RPC boundary. Worker control delivers
process and workflow commands; it is not a durable-state transport. The host
state API is the only RPC surface backed by `RunStatePort`.

## Worker-control RPC

| Operations | Ownership | Notes |
| --- | --- | --- |
| `health`, `status`, `shutdown` | Host lifecycle | Probe or stop the worker process over the control transport. `status` reads workflow phase but does not persist it. |
| `advance`, `initial_setup`, `retry`, `answer`, `note` | Worker control/workflow action | Deliver an allowlisted command to `WorkerHarnessRuntime`. |
| `confirm_grill`, `confirm_plan`, `confirm_verification`, `retry_verification_baseline` | Worker control/workflow action | Deliver workflow decisions; resulting durable mutations go through `RunStatePort`. |
| `resolve_installs`, `propose_fix`, `apply_fix`, `accept_tree` | Worker control/workflow action | Deliver recovery and verification commands. |
| `set_rag`, `set_repository_intelligence` | Worker control/workflow action | Change run workflow policy through the worker runtime. |
| `cancel`, `stop` | Worker control/workflow action | Trigger the worker behavior; cancellation and stop flags remain durable `RunStatePort` state. |
| `prepare-export` | Worker control/workflow action | Ask the worker to produce the result manifest/bundle through typed durable artifacts. |

## Host durable-state RPC

| Operations | Ownership | Notes |
| --- | --- | --- |
| `bootstrap`, `snapshot` | Durable state | Return path-free worker bootstrap data or the current revisioned snapshot. |
| `compare-and-swap`, `events`, `session-steps` | Durable state | Preserve revision CAS, idempotency, audit, and lease fencing. |
| `artifacts/read`, `artifacts/write`, `artifacts/delete`, `artifacts/list` | Durable state | Typed artifact access only; caller-selected host paths are rejected. |
| `cancellation`, `cancellation/request`, `cancellation/clear` | Durable state | Authoritative cancellation flag and idempotent mutations. |
| `stop`, `stop/request`, `stop/clear` | Durable state | Authoritative stop flag and idempotent mutations. |
| `lease`, `lease/acquire`, `lease/renew`, `lease/release` | Durable state | Worker exclusivity, heartbeat renewal, replacement, and fencing. |
| `export-ready`, `shutdown-ack` | Durable state | Append audited lifecycle evidence. Retained because no restart-safe replacement has been proven. |

## Non-RPC host lifecycle

Container creation, rediscovery, forced removal, named-volume retention,
quarantine/import, validation, and publication remain host lifecycle
responsibilities. They are not state-API operations and must not be moved into
the worker or exposed as caller-selected host paths.

Worker RPC tokens, state credentials, and optional Cursor credentials are
materialized under host-owned `worker-bootstrap/<run>/<worker-instance>/` and
mounted at fixed `/run/secrets/...` paths. Durable execution metadata stores
only non-reversible credential fingerprints, never secret paths or values.

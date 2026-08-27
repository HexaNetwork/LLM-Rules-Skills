# Agent harness design

`@hexanetwork/agent-harness` is one container-only, durable path from an idea or ticket to a reviewed pull request.

The production topology is deliberately small: one coordinator owns a SQLite control plane, a durable command queue, per-run leases, six pure workflow steps, Docker/Git control, and one HTTP/SSE API. The CLI and static dashboard are clients of that API; they never create their own coordinator.

Each run has a detached worktree and at most one replaceable project container. Clarification, specification, and environment planning execute through the neutral runner. Project setup, implementation, review, and validation execute inside the generated project image. The host never executes project commands, and containers never receive the Docker socket, harness database, control checkout, sibling runs, or publication credentials.

State changes are SQLite transactions. External actions have stable `run/step/kind/ordinal` keys and are reconciled before execution. Each leased command performs at most one external action. Pure completion enqueues the next command instead of recursing. Provider output is stored before schema handling or cleanup-sensitive work.

The supported workflow is `clarify -> specify -> provision-environment -> implement -> validate -> publish`. Tickets use the same steps with pre-supplied input. There are no production fake agents, host execution modes, migrations, compatibility readers, dynamic plugins, image repair, or language detection switches.

The database schema version is exact. During development, an incompatible home is reset with `agent-harness reset-home`. Git history is the archive for the pre-rebuild system.

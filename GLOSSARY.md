# Agent Harness glossary

**Project** — A registered repository or empty directory plus its selected base branch and external settings.

**Run** — One immutable workflow identity backed by a detached worktree and durable SQLite state.

**Coordinator** — The only production process that consumes commands, owns run leases, and performs external actions.

**Command** — A durable, idempotent operator or internal request. HTTP mutations append one and return immediately.

**Lease** — Time-bounded ownership that permits one coordinator worker to transition one run.

**Workflow step** — A self-contained pure state machine with input, state, agent turns, commands, gates, and output.

**Transition** — One of `invoke-agent`, `run-command`, `await-user`, `complete`, or `blocked`.

**Gate** — A durable operator question set with the exact submitted answers.

**Turn** — One canonical agent request/result envelope identified by a stable action key and explicit provider session id.

**Neutral runner** — The shared image containing only the agent runtime and generic operating-system tools.

**EnvironmentSpec** — The generated Containerfile, setup commands, health checks, and declared named caches for a project.

**Run container** — The replaceable container created from the project image with only its run worktree and declared caches mounted.

**Artifact** — A large durable document, log, or evidence file referenced from SQLite.

**Blocked run** — An inspectable run that requires an explicit retry, cancellation, environment correction, or operator decision.

# LLM Rules & Skills

Shared engineering skills and rules, plus a durable Agent Harness for turning an idea into a reviewed pull request.

| Path | Purpose |
| --- | --- |
| `General/` | Cross-project skills and rules |
| `E&E/` | Exploration & Empire-specific skills and rules |
| `packages/agent-harness/` | TypeScript coordinator and CLI |
| `GLOSSARY.md` | Canonical harness vocabulary |
| `docs/plans/lean-harness-rebuild.md` | Accepted rebuild plan |

## Agent Harness

One coordinator owns the SQLite control plane, durable command queue, workflow,
Docker/Git operations, HTTP API, and server-sent events. Agent and project
commands run only in containers. The CLI and small local dashboard are clients
of the already-running coordinator.

See [INSTALL.md](INSTALL.md) for the single supported installation and launch
path, and [the package guide](packages/agent-harness/README.md) for operation.

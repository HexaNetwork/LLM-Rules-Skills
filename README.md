# LLM Rules & Skills

Shared engineering skills and rules, plus a durable Agent Harness for turning an idea into a verified feature.

| Path | Purpose |
| --- | --- |
| `General/` | Cross-project skills and rules |
| `E&E/` | Exploration & Empire-specific skills and rules |
| `packages/agent-harness/` | TypeScript orchestration CLI |
| `GLOSSARY.md` | Canonical harness vocabulary |
| `docs/adr/` | Architecture decisions |

## Agent Harness

The harness uses a Cordis-composed host, live project settings, bounded work
packets, optional TDD, deterministic command evidence, host-owned git
publication, and an authenticated local dashboard. One Linux container per run
bind-mounts the run worktree at `/workspace` and may receive `CURSOR_API_KEY`
in its environment. Host secrets, the control checkout, and harness home stay
off that mount list.

On Windows, double-click `scripts\Launch-AgentHarness.cmd`. Its guided menu can
register a project, check Docker, inspect the host composition, or open the
dashboard.

See [INSTALL.md](INSTALL.md) for the guided and scripted paths. Bash alternatives
are `bash scripts/install-agent-harness.sh` and
`bash scripts/launch-agent-harness.sh <path>`.

See [the package guide](packages/agent-harness/README.md) and [`/harness-run`](General/skills/harness-run/SKILL.md).

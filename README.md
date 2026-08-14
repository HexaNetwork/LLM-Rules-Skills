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

The harness uses Wayfinder-style decision maps, local Markdown issues, offline lexical retrieval with optional GitNexus/CodeGraph repository intelligence, bounded fresh agent sessions, optional TDD, deterministic command evidence, harness-owned git publication, and an authenticated local dashboard.

Its knowledge index supports a scope gate: `General/` is indexed as universal guidance and `E&E/` as `exploration-and-empire` project guidance. For each worker step, the harness deterministically selects only relevant rules and skills by role, known paths, and lexical relevance, then uses the remaining context budget for repository documents. A normal query searches only global material plus the active project's documents; a different project's shared material must be named explicitly.

On Windows, double-click `scripts\Launch-AgentHarness.cmd`. Its guided menu can
set up/repair a project, check the required Docker worker, inspect the trusted
Cordis composition, or open the dashboard. `scripts\Install-AgentHarness.cmd`
remains a setup-only shortcut.

The production runtime is Docker-only, with durable state held by the host.
Real Cursor credential mounting remains fail-closed until its isolation release
gate passes; the dashboard and deterministic readiness checks can still be used.

See [INSTALL.md](INSTALL.md) for the guided and scripted paths. Bash alternatives
are `bash scripts/install-agent-harness.sh` and
`bash scripts/launch-agent-harness.sh <path>`.

See [the package guide](packages/agent-harness/README.md) and [`/harness-run`](General/skills/harness-run/SKILL.md).

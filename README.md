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

The harness uses Wayfinder-style decision maps, local Markdown issues, offline lexical retrieval with optional Graphify repository traversal, bounded fresh agent sessions, optional TDD, deterministic command evidence, harness-owned git publication, and an authenticated local dashboard.

Its knowledge index supports a scope gate: `General/` is indexed as universal guidance and `E&E/` as `exploration-and-empire` project guidance. For each worker step, the harness deterministically selects only relevant rules and skills by role, known paths, and lexical relevance, then uses the remaining context budget for repository documents. A normal query searches only global material plus the active project's documents; a different project's shared material must be named explicitly.

```bash
npm install
npm run build
npm run test:run

npx agent-harness init
npx agent-harness ui
npx agent-harness start --idea "Add saved searches" # CLI alternative
npx agent-harness status --run-id <id>
```

Set `CURSOR_API_KEY` for agent execution. Generated run state is local under `.agent-harness/` and should remain gitignored.

For a step-by-step install (Node, build, API key, deploy into another folder, UI), see [INSTALL.md](INSTALL.md).

See [the package guide](packages/agent-harness/README.md) and [`/harness-run`](General/skills/harness-run/SKILL.md).

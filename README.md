# LLM Rules & Skills

Shared Cursor/Claude skills and rules across HexaNetwork projects, plus the **Agent Harness** executable orchestration CLI.

## Layout

| Path | Purpose |
|------|---------|
| `General/` | Cross-project skills and rules (markdown) |
| `E&E/` | Exploration & Empire–specific skills and rules |
| `packages/agent-harness/` | TypeScript CLI for contract-deterministic AFK implementation runs |
| `GLOSSARY.md` | Agent Harness domain language |
| `docs/roadmap.md` | Deferred extensions outside v1 |

## Agent Harness

```bash
npm install
npm run build
npm run test:run
```

CLI (after build):

```bash
npx agent-harness init
npx agent-harness prepare --local tasks.yaml --fake-agents
npx agent-harness approve --draft .agent-harness/runs/drafts/draft-….json
npx agent-harness execute --manifest … --fake-agents --no-github
npx agent-harness resume --run-id <id> --fake-agents
npx agent-harness status --run-id <id>
npx agent-harness benchmark --runs 3
```

### Credentials

| Variable | Required when |
|----------|----------------|
| `CURSOR_API_KEY` | Real Cursor SDK agents (omit with `--fake-agents`) |
| `GITHUB_TOKEN` | `--github` prepare / GitHub publish adapter |

Put these in the **project cwd** `.env` or `.env.local` (gitignored). The CLI auto-loads them; existing shell/CI env vars still win. Do not commit tokens.

### Security model

v1 uses **strict Cursor Allowlist** (not Auto-review). Terminal/MCP/network allowlists live in project config and are written beside each run. Unlisted tool use should surface as a blocked permission outcome. Allowlists are a convenience layer—not a hard security boundary.

### Lifecycle

`init` → `prepare` → `approve` → `execute` / `resume` → verified branch (+ optional GitHub PR)

See `packages/agent-harness/README.md` for config fields, local/GitHub source formats, and recovery.

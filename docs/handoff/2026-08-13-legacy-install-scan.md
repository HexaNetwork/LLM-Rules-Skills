# Handoff: Local agent-harness legacy install scan

**Date:** 2026-08-13  
**Branch:** n/a (read-only scan)  
**Status:** complete — scan only; no migrations, deletes, or harness-state changes

## Summary

Scanned this Windows machine for remaining agent-harness **legacy-shared** runs and **repo-local** installs. The active external home has **one** registered project and **one** run, already on `git-worktree`. **No** live `legacy-shared` / missing-`workspace.json` runs were found under the harness home. The only operator-facing repo-local leftover is a tracked `agent-harness.config.yaml` in `LLM-Rules-Skills` (no `.agent-harness` state directory).

## What was checked

| Source | Path / signal | Result |
|--------|----------------|--------|
| Env override | `AGENT_HARNESS_HOME` | unset |
| Default Windows home | `%LOCALAPPDATA%\agent-harness` (`C:\Users\Nirom\AppData\Local\agent-harness`) | **present** |
| Alternate homes | `~\.agent-harness`, `~\agent-harness`, `%APPDATA%\agent-harness`, XDG-style `~\.local\state\agent-harness` | absent (case-variant `Agent-Harness` is the same folder) |
| Project registry | `...\agent-harness\projects\*` | 1 project |
| Runs / `workspace.json` | under each project's `runs\` | 1 run classified |
| Locks | `repo.lock`, `run.lock`, `locks\*.lock` under home | **none** active |
| Repo-local state | `.agent-harness` under `d:\Dev` (depth 5–6, excl. `test-results` / `node_modules` / `dist`) | **0** |
| Repo-local config | `agent-harness.config.{yaml,yml,json}` under `d:\Dev` + shallow Documents | **1** (monorepo root) |
| Package conventions | `harness-home.ts`, `paths.ts`, `migrate-home.ts`, `external-config.ts`, `CONFIG_NAMES`, README legacy section | used to choose scan targets |

Code references for locations:

- Home: `AGENT_HARNESS_HOME` or `%LOCALAPPDATA%\agent-harness` (`resolveHarnessHome` / `defaultHarnessHomeRoot`)
- Legacy config names: `agent-harness.config.yaml` / `.yml` / `.json`
- Legacy state: `<repo>/.agent-harness` (+ optional `<repo>/agent-harness/guidance` for migrate-home)
- Repository lock (legacy-shared only): `<stateRoot>/repo.lock`

## Key counts

| Category | Count | Notes |
|----------|------:|-------|
| External home installs | 1 | `%LOCALAPPDATA%\agent-harness` |
| Registered projects | 1 | `19d8e3ff24ee40b7` → `D:/Dev/LLM/Emperor-Test-Harness` |
| Runs in external home | 1 | phase `cancelled` |
| **`legacy-shared` (home)** | **0** | — |
| **Missing `workspace.json` (home)** | **0** | would reopen as legacy-shared |
| **`git-worktree` (home)** | **1** | `356ffa23-ca3d-4e28-8278-31f87f04acc4` |
| Active `repo.lock` / `run.lock` (home) | 0 | locks dir empty |
| Repo-local `.agent-harness` (non-test) | **0** | — |
| Repo-local `agent-harness.config.*` (non-test) | **1** | `D:\Dev\LLM\LLM-Rules-Skills\agent-harness.config.yaml` (git-tracked) |
| **migrate-home candidates** | **1** | same monorepo config; **no** `.agent-harness` / guidance tree to copy |
| Test-only `.agent-harness` dirs | 28 unique | under `packages/agent-harness/test-results` only |
| Test-only runs (classification) | 37 | 24 missing `workspace.json`, 7 `git-worktree`, 6 `git-disabled`, 0 explicit `kind: legacy-shared` |

## Findings (operator-relevant)

### External home is modern

- Project `Emperor-Test-Harness` is already registered under external home.
- Its only run has `workspace.json` with `kind: "git-worktree"` and a sibling worktree path under `Emperor-Test-Harness-worktrees\...`.
- **No `migrate-workspace` needed** for anything currently in the home registry.

### Repo-local install surface

- **Emperor-Test-Harness:** no repo-local `.agent-harness` and no `agent-harness.config.*` at the control root (clean vs external home).
- **LLM-Rules-Skills:** tracked `agent-harness.config.yaml` with `stateDirectory: .agent-harness`, but **`.agent-harness` does not exist**. This is a **config-only / allowLegacy fallback** if the monorepo is not registered in the project registry (it is not registered today). `migrate-home` would find the config and create/reuse a registration, but there is essentially no run state to migrate.

### Test artifacts only (ignore for sunset)

Under `packages/agent-harness/test-results`, many fixture `.agent-harness` trees remain (including some leftover `*.lock` files). These are acceptance/e2e leftovers, not live operator installs. Missing `workspace.json` there would behave as legacy-shared **if** those fixtures were resumed; they are not part of the external home registry.

## Recommended next operator actions

1. **Do not run `migrate-workspace`** against the Emperor home run — already `git-worktree`.
2. **Optional — register / migrate-home for `LLM-Rules-Skills`:** if you want the monorepo on the external-home path (and to stop relying on `allowLegacy` + root `agent-harness.config.yaml`):
   - Prefer normal project registration / new runs via external home, **or**
   - `agent-harness migrate-home --repository "D:\Dev\LLM\LLM-Rules-Skills"` (then optional `--cleanup` only after validating; cleanup would remove the tracked config path — coordinate with the team before deleting a git-tracked file).
3. **Optional — prune `packages/agent-harness/test-results`:** reclaim disk / remove stale locks; not required for legacy product sunset.
4. **Sunset readiness (this machine):** live legacy-shared + repo-local **state** usage is effectively **cleared**. Remaining product-compat code can wait on a broader multi-machine / team inventory; the only soft leftover here is the monorepo’s tracked legacy-shaped config file.

## Out of scope / limits

- Read-only; no migrate, unlock, delete, or config edits.
- Deep scan focused on `d:\Dev` (and shallow Documents). Other drives or unindexed trees were not exhaustively walked.
- Did not invoke the CLI (scan was filesystem + source-derived path conventions only).

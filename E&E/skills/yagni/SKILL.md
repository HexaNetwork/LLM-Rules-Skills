---
name: yagni
description: >-
  Runs three branch reviews — YAGNI/KISS, complexity depth, and class
  explosion — against a base branch (default ob-3). Use when the user says
  /yagni, YAGNI review, KISS review, class explosion review, or complexity
  depth review on branch changes.
disable-model-invocation: true
---

# YAGNI Branch Review

Review **current branch** changes against a **base branch** through three independent lenses. Default base: **`ob-3`**. Override when the user names another branch (e.g. `/yagni against main`).

Do **not** fix findings or refactor during the review unless the user asks afterward.

## Scope

| Input | Default |
|-------|---------|
| Head branch | Currently checked out branch — stay on it (`git-stay-on-current-branch.mdc`) |
| Base branch | `ob-3` |
| Diff | All commits on head since merge-base with base, plus staged/unstaged changes |

Confirm scope in the report header: `**Branch:** \`head\` vs base \`base\``.

## Progress checklist

```
YAGNI review (head: ___ vs base: ___):
- [ ] 1. Resolve branches and verify diff
- [ ] 2. Agent 1 — YAGNI / KISS
- [ ] 3. Agent 2 — Complexity depth
- [ ] 4. Agent 3 — Class explosion
- [ ] 5. Consolidated report
```

Launch agents **2–4 in parallel** after step 1. Present findings in agent order (1 → 2 → 3), then the consolidated report.

---

## 1. Resolve branches and verify diff

Run in parallel:

```bash
git branch --show-current
git merge-base <base> HEAD
git diff --stat <base>...HEAD
git log --oneline <base>...HEAD | head -20
```

- If the diff is empty, stop and tell the user in one sentence.
- Do **not** checkout the base branch — review from the current head.
- Record line/file counts for the report header (~N lines changed).

---

## 2–4. Launch three review agents

Launch exactly **three** `generalPurpose` subagents **in parallel**:

| Agent | `description` | Criteria file |
|-------|---------------|-----------------|
| 1 | `YAGNI/KISS review` | [YAGNI-KISS.md](YAGNI-KISS.md) |
| 2 | `Complexity depth review` | [COMPLEXITY-DEPTH.md](COMPLEXITY-DEPTH.md) |
| 3 | `Class explosion review` | [CLASS-EXPLOSION.md](CLASS-EXPLOSION.md) |

Each subagent:

- `readonly: true`
- `run_in_background: false`

Use this prompt shape for **every** agent (replace `<LENS>` and attach the matching criteria file content by reference in the prompt):

```text
Full Repository Path: <absolute workspace path>
Base Branch: <base branch, e.g. ob-3>
Head Branch: <current branch from git branch --show-current>
Review lens: <YAGNI/KISS | Complexity depth | Class explosion>

Read and apply every criterion in the attached lens document.

Workflow:
1. Run `git diff <base>...HEAD` (and read changed files as needed).
2. Review only what this branch introduces or changes vs the base.
3. Read project rules cited in the lens doc when touching those areas.
4. Return findings using the lens output template exactly.

Also return:
- Overall verdict: Approve | Approve with nits | Request changes
- Keep-as-is: patterns explicitly worth preserving (with brief why)
- Empty diff: if nothing to review, say so and skip findings
```

If a subagent fails, retry once with the same prompt. If it still fails, note the blocker in the consolidated report and continue with the other agents.

---

## 5. Consolidated report

Merge the three agent outputs using [REPORT-TEMPLATE.md](REPORT-TEMPLATE.md).

Rules:

- **Deduplicate** overlapping findings — one row per issue, list every source lens in **Sources**.
- **Severity** — highest across lenses wins when they disagree.
- **Keep as-is** — union of positive notes from all three; drop items contradicted by a merge blocker.
- **Do not implement** — end with the master checklist only.

Save the report when the user asks, or when they name a path (default: `docs/plans/<head-branch>-yagni-review-plan.md`). Otherwise print in chat.

---

## Relationship to other skills

| Skill | Use when |
|-------|----------|
| `yagni` | Pre-merge simplification review on a branch diff |
| `review-bugbot` | Correctness / bug findings |
| `review-security` | Security findings |
| `improve-codebase-architecture` | Interactive deepening design after YAGNI flags architecture |
| `rip-and-tear` | Execute aggressive consolidation after review approval |
| `find-code-duplication` | Mechanical clone scan (optional follow-up) |

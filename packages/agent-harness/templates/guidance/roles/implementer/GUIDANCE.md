# Implementer guidance

You implement one task in the working tree as a minimal, reviewable change.

## How to work

- Implement exactly the task in the packet — its title and description define the scope.
- Follow the repository's existing conventions, naming, and module boundaries.
- Return `{summary,files,note?,verification?}` listing what changed and the files touched.
- Keep the change small enough to review in one pass.
- Read `verificationCommands` when present:
  - `command` — full project verification; the harness **always** runs this after you return.
  - `fixCommand` — optional auto-fix (for example `./gradlew :civcraft:spotlessApply`).
- Request harness sandbox runs in your JSON — **do not** run these commands in the host shell (Windows vs Docker can differ):
  - `verification.runFix` — defaults to **true** when `fixCommand` exists. Set `runFix: false` to skip.
  - `verification.runVerify` — set `runVerify: true` for an early harness run of the full command before the mandatory gate.
- When a prior `verification` failure is included, treat it as feedback; keep `runFix: true` unless you are sure formatting is already clean.

## What to avoid

- Do not write, edit, weaken, delete, or bypass tests during implementation.
- Do not run `verificationCommands` directly in your terminal; the harness executes them in the worker sandbox.
- Do not commit, push, or open a pull request; the harness commits after review.
- Do not refactor adjacent code or fix unrelated issues.

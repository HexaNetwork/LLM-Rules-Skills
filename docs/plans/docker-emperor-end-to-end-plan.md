# Docker + Emperor end-to-end harness update plan

## Proven working outcome

On 2026-08-13, run `22222222-3333-4444-8555-666666666666` completed the Docker setup path against `D:\Dev\LLM\Emperor-Test-Harness`:

- Docker Desktop 4.75.0 / Engine 29.5.2 was reachable in Linux-container mode.
- The maintained worker was rebuilt from the current checkout and pinned as `agent-harness-worker:local@sha256:7b1afc3532636ee54f17a923e1255a5d6376cdba14dcbe8037a8f5b2cedce771`.
- The JVM execution image built successfully.
- The harness seeded an isolated clone at Emperor commit `9c1b22cf9` on branch `ob-4` into a named Docker volume.
- The worker ran as UID/GID `10001:10001`, with `/workspace` as its working directory, Node 22.22.3, and OpenJDK 21.0.11.
- Repository setup and the first provider invocation ran inside the worker.
- Persisted run state advanced from `new` to `awaiting_input`; events include `reflect.started`, `reflect.drafted`, and `question.asked`.
- `execution diagnostics` reported a healthy authenticated worker RPC session.

## Normal project-agnostic workflow

1. Build the TypeScript harness so the Docker worker contains the current source:

   ```powershell
   npm run build -w @hexanetwork/agent-harness
   ```

2. Rebuild and pin the maintained worker for the registered Emperor project:

   ```powershell
   node packages\agent-harness\dist\cli.js execution prepare-worker `
     --repository D:\Dev\LLM\Emperor-Test-Harness `
     --package-root D:\Dev\LLM\LLM-Rules-Skills\packages\agent-harness `
     --force-rebuild --write-settings --enable-runtime
   ```

3. Create a run through the CLI or UI. Branch selection is resolved in this order: an explicit valid branch, the configured valid branch, the repository's current branch when a generic default is absent, or the repository's only local branch. No project name or branch is hard-coded.

4. Approve and build the generated per-run execution image.

5. Continue or retry normally. The harness opens a pre-workspace Docker run provisionally, provisions the isolated clone on the host, and persists the `docker-clone` workspace.

6. The harness starts the worker against the retained workspace volume and invokes initial setup/advance through authenticated loopback RPC. Repository intelligence, knowledge refresh, Git commands, and agents execute inside the worker where `/workspace` exists.

7. Verify persisted state, events, worker health, container user/toolchain, clone HEAD, and an unchanged control checkout.

## Implemented harness changes

### 1. Pre-workspace Docker runs are first-class

- `openRunHarness(..., { allowMissingWorkspace: true })` is used for image approval, retry, status, and continue while a Docker run is blocked from `new`.
- Do not call normal `advance` before `workspace.json` exists; `RunAdvancer.ensureWorkspaceBound` correctly rejects that state.
- Route the transition in this order:

  1. approve/build or reuse the execution image;
  2. `ensureDockerWorkspaceReady` on the host;
  3. start/recover the worker;
  4. invoke worker initial setup/advance.

### 2. CLI and UI share the working lifecycle

- `start` preserves the expected image-approval block instead of advancing against missing workspace metadata.
- `retry` and `continue` provisionally open Docker runs, ensure the workspace, then invoke the container worker.
- Run-specific commands resolve registered external project config through the registry/home merge path.
- `start`, `status`, `continue`, `retry`, and execution-image commands accept `--repository`, `--project`, and `--home` selectors.
- Cached-image UI starts now use the same host-provision/worker sequence rather than attempting setup against a synthetic host `/workspace` path.

### 3. Freeze a valid repository branch

- The shared branch resolver validates explicit and configured branches, then safely falls back to repository-local state.
- If selection remains ambiguous, it fails with a targeted message listing the local branches.
- UI and CLI run creation use the same resolver.

### 4. Use one stable container identity

- Worker startup receives the container name already recorded by workspace provisioning.
- `workspace.json`, `execution.json`, recovery, diagnostics, and cleanup therefore refer to the same container without deriving identity from a project-specific constant.

### 5. Keep worker freshness explicit

- Source changes do not affect an already pinned worker image. Installation/development flows must rebuild (or detect staleness), pin the new digest, and ensure newly generated execution images copy from it.
- Include the worker source/build identity in diagnostics so stale-image failures are obvious.

## Regression coverage

The stale UI settings-count and repository-intelligence expectations were repaired. New coverage verifies branch fallback, pre-workspace approval/status behavior, external-project config resolution, and workspace-to-worker container identity.

A future dedicated real Docker lifecycle lane should:

1. registers a temporary Git repository with a non-`main` base branch;
2. starts a Docker run and observes the image approval gate without a missing-workspace exception;
3. approves/builds the image;
4. retries/continues through host clone provisioning and worker initial setup;
5. asserts the run leaves `new` and records a worker-produced event;
6. restarts/reconnects to the worker using `execution.json`;
7. asserts workspace/execution container identity is consistent;
8. checks the control checkout is unchanged; and
9. cancels, stops the worker, and cleans the named volume through harness cleanup.

Retain focused unit tests for:

- provisional `openRunHarness` behavior;
- `start` returning the approval block without attempting `advance`;
- CLI retry/continue ordering for a missing Docker workspace;
- external config merge/path resolution;
- project-key propagation into worker container naming; and
- run-directory overrides used by host and worker artifact loading.

## Verification record

On 2026-08-13 after implementing the workflow changes:

- typecheck/build completed successfully;
- acceptance: 8 passed;
- integration: 110 passed, 1 intentionally skipped;
- real Docker isolation: 3 passed;
- all 595 unit tests ran successfully across the full run plus isolated reruns of two Windows timing-sensitive tests;
- a normal CLI smoke run (`33333333-4444-4555-8666-777777777777`) selected Emperor's current `ob-4` branch, stopped cleanly at execution-image approval, and built the approved image digest `sha256:98494f83e8be53646b07fd95ee8b80aa5d8a983f9175c7ef2fa9ecabe8be4d10`;
- the maintained worker was rebuilt and pinned at `agent-harness-worker:local@sha256:c511cfde0682db817fc1363bf2aa9f7c5044ebe00f7e99499403b5bb3a6e6bab`.

The final provider-backed `continue` for the fresh smoke run was not executed because the environment required separate explicit authorization to transmit private-repository context to the configured external provider. The earlier run in this document already verified provider-backed worker execution to `awaiting_input`.

## Completion criteria

- A normal CLI and UI run against Emperor can go from creation to `awaiting_input` without manual Node scripts or direct Docker commands.
- Approval is the only expected pause before first clone creation.
- Docker diagnostics report a healthy worker and matching workspace/execution identity.
- The worker can be stopped and recovered against the same named volume.
- Typecheck, unit/integration suites, the real Docker isolation lane, and the new Docker lifecycle acceptance lane all pass.

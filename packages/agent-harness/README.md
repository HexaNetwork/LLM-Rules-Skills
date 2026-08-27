# @hexanetwork/agent-harness

A single-user, local coordinator that durably carries an idea or ticket through clarification, specification, container provisioning, implementation, validation, and pull-request publication.

Requirements: Node 22.5+, Git, Docker, GitHub CLI, and `CURSOR_API_KEY`.

```sh
npm install
npm run build
agent-harness install-runner
agent-harness serve
```

In another shell, register a project and start a run. Every client command talks to the running coordinator and returns immediately for long-running work.

```sh
agent-harness project add --name example --repository /path/to/repo --base-branch main
agent-harness project list
agent-harness start --project PROJECT_ID --idea "Add the requested capability"
agent-harness status --run-id RUN_ID
```

Open `http://127.0.0.1:8787` for gates, the timeline, and concise diagnostics. Configuration lives in `<harness-home>/config.json`; see the exported `EffectiveConfig` type for supported values.

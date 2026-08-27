export default function setup(): void {
  process.env.GIT_AUTHOR_NAME ??= "Agent Harness Tests";
  process.env.GIT_AUTHOR_EMAIL ??= "agent-harness@example.invalid";
  process.env.GIT_COMMITTER_NAME ??= process.env.GIT_AUTHOR_NAME;
  process.env.GIT_COMMITTER_EMAIL ??= process.env.GIT_AUTHOR_EMAIL;
}

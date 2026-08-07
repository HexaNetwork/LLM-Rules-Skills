import { rm } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const dist = new URL("./dist/", packageRoot);

if (!dist.pathname.endsWith("/packages/agent-harness/dist/")) {
  throw new Error(`Refusing to clean unexpected path: ${dist.pathname}`);
}

await rm(dist, { recursive: true, force: true });

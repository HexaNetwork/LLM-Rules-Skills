/**
 * Copy monorepo General/ rules+skills into the package templates tree so
 * init/deploy can seed them the same way CodeGraph setup scripts are shipped.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const monorepoGeneral = path.resolve(packageRoot, "../../General");
const destination = path.join(packageRoot, "templates", "guidance", "General");

const info = await stat(monorepoGeneral).catch(() => undefined);
if (!info?.isDirectory()) {
  throw new Error(`Expected monorepo General/ at ${monorepoGeneral}`);
}

await rm(destination, { recursive: true, force: true });
await mkdir(path.dirname(destination), { recursive: true });
await cp(monorepoGeneral, destination, { recursive: true });
console.log(`Synced guidance templates → ${destination}`);

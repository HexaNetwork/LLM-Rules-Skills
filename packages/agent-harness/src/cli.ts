#!/usr/bin/env node
/**
 * Package bin entry. Production wiring lives in `cli/main.ts` and
 * `cli/create-cli.ts`; acceptance tests import `createCli` for injection.
 */
export {
  createCli,
  productionCliDependencies,
  type CliDependencies,
} from "./cli/create-cli.js";
export { main } from "./cli/main.js";

import { main } from "./cli/main.js";

void main();

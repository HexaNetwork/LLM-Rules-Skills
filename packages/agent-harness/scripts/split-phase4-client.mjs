import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const appPath = path.join(root, "src/ui/app.ts");
const backupPath = path.join(root, "src/ui/app.ts.phase4-backup");
copyFileSync(appPath, backupPath);

const source = readFileSync(backupPath, "utf8");
const scriptMatch = source.match(/<script>\r?\n([\s\S]*?)\r?\n  <\/script>/);
if (!scriptMatch) throw new Error("Could not find dashboard <script> block");
const script = scriptMatch[1];
const scriptLines = script.split(/\r?\n/);

function findRel(re, from = 0) {
  for (let i = from; i < scriptLines.length; i++) if (re.test(scriptLines[i])) return i;
  return -1;
}

const marks = {
  iife: findRel(/^\s*\(function \(\) \{/),
  api: findRel(/^\s*async function api\(/),
  renderSidebar: findRel(/^\s*function renderSidebar\(/),
  renderBatchQuestion: findRel(/^\s*function renderBatchQuestion\(/),
  renderOverview: findRel(/^\s*function renderOverview\(/),
  renderArtifacts: findRel(/^\s*function renderArtifacts\(/),
  renderSettings: findRel(/^\s*function renderSettings\(/),
  waitForJob: findRel(/^\s*async function waitForJob\(/),
  batchHelpers: findRel(/^\s*function batchQuestionNode\(/),
  clickListener: findRel(/^\s*document\.addEventListener\('click'/),
};
for (const [k, v] of Object.entries(marks)) {
  if (v < 0) throw new Error(`Missing mark: ${k}`);
}
console.log(marks);

function sliceRel(start, endExclusive) {
  return scriptLines.slice(start, endExclusive).join("\n");
}

function asExport(name, body) {
  const escaped = body
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `/** Browser JS fragment inlined by renderDashboard (Phase 4). */\nexport const ${name} = \`${escaped}\`;\n`;
}

const statePart = sliceRel(marks.iife, marks.api);
const apiPart = sliceRel(marks.api, marks.renderSidebar);
const runPart1 = sliceRel(marks.renderSidebar, marks.renderBatchQuestion);
const interviewPart1 = sliceRel(marks.renderBatchQuestion, marks.renderOverview);
const runPart2 = sliceRel(marks.renderOverview, marks.renderArtifacts);
const artifactsPart = sliceRel(marks.renderArtifacts, marks.renderSettings);
const settingsPart = sliceRel(marks.renderSettings, marks.waitForJob);
const actionsPart = sliceRel(marks.waitForJob, marks.batchHelpers);
const interviewPart2 = sliceRel(marks.batchHelpers, marks.clickListener);
const eventsPart = sliceRel(marks.clickListener, scriptLines.length);

const outDir = path.join(root, "src/ui/client");
mkdirSync(outDir, { recursive: true });

writeFileSync(path.join(outDir, "state.ts"), asExport("stateScript", statePart));
writeFileSync(path.join(outDir, "api.ts"), asExport("apiScript", apiPart));
writeFileSync(
  path.join(outDir, "render-run.ts"),
  asExport("renderRunScript", `${runPart1}\n/*__SPLIT_OVERVIEW__*/\n${runPart2}`),
);
writeFileSync(
  path.join(outDir, "render-interview.ts"),
  asExport("renderInterviewScript", `${interviewPart1}\n/*__SPLIT_BATCH_DOM__*/\n${interviewPart2}`),
);
writeFileSync(path.join(outDir, "render-artifacts.ts"), asExport("renderArtifactsScript", artifactsPart));
writeFileSync(path.join(outDir, "render-settings.ts"), asExport("renderSettingsScript", settingsPart));
writeFileSync(
  path.join(outDir, "events.ts"),
  asExport("eventsScript", `${actionsPart}\n/*__SPLIT_EVENTS__*/\n${eventsPart}`),
);

writeFileSync(
  path.join(outDir, "parts.ts"),
  `import { apiScript } from "./api.js";
import { eventsScript } from "./events.js";
import { renderArtifactsScript } from "./render-artifacts.js";
import { renderInterviewScript } from "./render-interview.js";
import { renderRunScript } from "./render-run.js";
import { renderSettingsScript } from "./render-settings.js";
import { stateScript } from "./state.js";

/** Full browser IIFE body in original execution order. */
export function clientScriptBody(): string {
  const runParts = renderRunScript.split("\\n/*__SPLIT_OVERVIEW__*/\\n");
  const interviewParts = renderInterviewScript.split("\\n/*__SPLIT_BATCH_DOM__*/\\n");
  const eventParts = eventsScript.split("\\n/*__SPLIT_EVENTS__*/\\n");
  return [
    stateScript,
    apiScript,
    runParts[0] ?? "",
    interviewParts[0] ?? "",
    runParts[1] ?? "",
    renderArtifactsScript,
    renderSettingsScript,
    eventParts[0] ?? "",
    interviewParts[1] ?? "",
    eventParts[1] ?? "",
  ].join("\\n");
}
`,
);

const htmlMatch = source.match(/^export function renderDashboard\(\): string \{\r?\n  return `([\s\S]*)<script>\r?\n/);
if (!htmlMatch) throw new Error("Could not extract HTML shell");
const escapedShell = htmlMatch[1]
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

writeFileSync(
  appPath,
  `import { clientScriptBody } from "./client/parts.js";

export function renderDashboard(): string {
  const clientScript = clientScriptBody();
  return \`${escapedShell}<script>
\${clientScript}
  </script>
</body>
</html>\`;
}
`,
  "utf8",
);

const reassembled = [
  statePart,
  apiPart,
  runPart1,
  interviewPart1,
  runPart2,
  artifactsPart,
  settingsPart,
  actionsPart,
  interviewPart2,
  eventsPart,
].join("\n");
const originalNormalized = script.replace(/\r\n/g, "\n").trim();
const reassembledNormalized = reassembled.replace(/\r\n/g, "\n").trim();
console.log({
  originalLen: originalNormalized.length,
  reassembledLen: reassembledNormalized.length,
  equal: originalNormalized === reassembledNormalized,
});
if (originalNormalized !== reassembledNormalized) {
  for (let i = 0; i < Math.max(originalNormalized.length, reassembledNormalized.length); i++) {
    if (originalNormalized[i] !== reassembledNormalized[i]) {
      console.log("first diff at", i);
      console.log("orig", JSON.stringify(originalNormalized.slice(Math.max(0, i - 40), i + 80)));
      console.log("new ", JSON.stringify(reassembledNormalized.slice(Math.max(0, i - 40), i + 80)));
      process.exitCode = 1;
      break;
    }
  }
}

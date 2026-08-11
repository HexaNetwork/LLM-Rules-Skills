import { apiScript } from "./api.js";
import { eventsScript } from "./events.js";
import { renderArtifactsScript } from "./render-artifacts.js";
import { renderGuidanceScript } from "./render-guidance.js";
import { renderInterviewScript } from "./render-interview.js";
import { renderRunScript } from "./render-run.js";
import { renderSettingsScript } from "./render-settings.js";
import { stateScript } from "./state.js";

/** Full browser IIFE body in original execution order. */
export function clientScriptBody(): string {
  const runParts = renderRunScript.split("\n/*__SPLIT_OVERVIEW__*/\n");
  const interviewParts = renderInterviewScript.split("\n/*__SPLIT_BATCH_DOM__*/\n");
  const eventParts = eventsScript.split("\n/*__SPLIT_EVENTS__*/\n");
  return [
    stateScript,
    apiScript,
    runParts[0] ?? "",
    interviewParts[0] ?? "",
    runParts[1] ?? "",
    renderArtifactsScript,
    renderGuidanceScript,
    renderSettingsScript,
    eventParts[0] ?? "",
    interviewParts[1] ?? "",
    eventParts[1] ?? "",
  ].join("\n");
}

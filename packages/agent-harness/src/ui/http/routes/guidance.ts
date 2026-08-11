import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentRoleSchema } from "../../../domain.js";
import { renderGuidancePromptPreview, roleRulesFor } from "../../../prompts.js";
import type { UiAppContext } from "../context.js";
import { json } from "../request.js";

/** @returns true when the request was handled. */
export async function handleGuidanceRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  ctx: UiAppContext,
): Promise<boolean> {
  if (request.method === "GET" && url.pathname === "/api/guidance/packs") {
    const projectConfig = ctx.getProjectConfig();
    const assignments = projectConfig.knowledge.guidance.assignments;
    const packs = await Promise.all(
      AgentRoleSchema.options.map(async (role) => {
        const assignment = assignments?.[role] ?? { rules: [], skills: [] };
        const compiled = await ctx.knowledge.compileRoleGuidancePack(role, { assignment });
        const roleRules = [...roleRulesFor(role)];
        return {
          role,
          assignment,
          sources: compiled.sources,
          missingAssignments: compiled.missingAssignments,
          omittedOverrides: compiled.omittedOverrides,
          truncated: compiled.truncated,
          roleRules,
          guidancePack: compiled.text,
          promptPreview: renderGuidancePromptPreview(role, compiled.text),
        };
      }),
    );
    json(response, 200, { packs });
    return true;
  }

  return false;
}

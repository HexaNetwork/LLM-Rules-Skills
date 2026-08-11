/** Compatibility barrel for config modules (Phase 3). */
export {
  CONFIG_NAMES,
  CONFIG_VERSION,
  DEFAULT_GUIDANCE_ASSIGNMENTS,
  DEFAULT_IGNORED_ARTIFACT_PATTERNS,
  HarnessConfigSchema,
  KnowledgeScopeSchema,
  KnowledgeSourceSchema,
  KnowledgeVisibilitySchema,
  PreflightCommitOrderSchema,
  ProjectSettingsPatchSchema,
  RunPolicyPatchSchema,
  configurationHash,
  configurationPolicyDiff,
  type HarnessConfig,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeVisibility,
  type PreflightCommitOrder,
  type ProjectSettingsPatch,
  type RunPolicyPatch,
} from "./config/schema.js";
export {
  defaultConfigYaml,
  deploymentConfigYaml,
  modelForRole,
} from "./config/defaults.js";
export {
  loadConfig,
  loadRunConfig,
  loadRunWorkspace,
  runWorkspacePath,
  writeProjectSettings,
  writeRunWorkspace,
} from "./config/io.js";
export {
  isLegacyGuidanceSourcePath,
  normalizeFrozenRunConfig,
  stripLegacyGuidanceSources,
} from "./config/migrations.js";

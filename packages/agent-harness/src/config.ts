/** Compatibility barrel for config modules (Phase 3). */
export {
  CONFIG_NAMES,
  CONFIG_VERSION,
  DEFAULT_IGNORED_ARTIFACT_PATTERNS,
  HarnessConfigSchema,
  KnowledgeScopeSchema,
  KnowledgeSourceSchema,
  KnowledgeVisibilitySchema,
  PreflightCommitOrderSchema,
  ProjectSettingsPatchSchema,
  configurationHash,
  configurationPolicyDiff,
  type HarnessConfig,
  type KnowledgeScope,
  type KnowledgeSource,
  type KnowledgeVisibility,
  type PreflightCommitOrder,
  type ProjectSettingsPatch,
} from "./config/schema.js";
export {
  defaultConfigYaml,
  deploymentConfigYaml,
  modelForRole,
} from "./config/defaults.js";
export {
  loadConfig,
  loadRunConfig,
  writeProjectSettings,
} from "./config/io.js";
export {
  applyLiveProjectPolicy,
  normalizeFrozenRunConfig,
} from "./config/migrations.js";

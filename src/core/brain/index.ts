/**
 * Public surface of the Brain layer.
 *
 * CLI and MCP entry points (added in Tasks 6 and 7) import from this
 * barrel. Internal modules remain importable directly when a tighter
 * coupling is intentional, but adapters should prefer this surface so
 * private helpers can move without breaking call sites.
 */

// ----- Types ----------------------------------------------------------------
export type {
  BrainSignal,
  BrainPreference,
  BrainRetired,
  BrainLogEvent,
  BrainLogEventBase,
  BrainDreamLogEvent,
  BrainApplyEvidenceLogEvent,
  BrainFeedbackLogEvent,
  BrainForceConfirmedLogEvent,
  BrainRejectLogEvent,
  BrainPromoteLogEvent,
  BrainRetireLogEvent,
  BrainNotedRedundantLogEvent,
  BrainSkipCorruptedLogEvent,
  BrainPinLogEvent,
  BrainRollbackLogEvent,
  BrainSignalSign,
  BrainPreferenceStatus,
  BrainConfidence,
  BrainRetiredReason,
  BrainApplyResult,
  BrainLogEventKind,
  BrainConfig,
  BrainDreamConfig,
  BrainRetireConfig,
  BrainConfidenceConfig,
  BrainSnapshotsConfig,
} from "./types.ts";

export {
  BRAIN_SIGNAL_SIGN,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_CONFIDENCE,
  BRAIN_RETIRED_REASON,
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
} from "./types.ts";

// ----- Path helpers ---------------------------------------------------------
export {
  brainDirs,
  brainConfigPath,
  brainManualPath,
  brainActivePath,
  signalPath,
  processedSignalPath,
  preferencePath,
  retiredPath,
  logPath,
  snapshotsDir,
  snapshotPath,
  allocateSlug,
  validateSlug,
  validateIsoDate,
  validateRunId,
  brainVaultRelative,
  ensureInsideVault,
  vaultRelative,
} from "./paths.ts";

// ----- Active-preferences digest --------------------------------------------
export { regenerateActive, regenerateActiveQuiet } from "./active.ts";
export type { RegenerateActiveOptions, RegenerateActiveResult } from "./active.ts";

// ----- Backlink index -------------------------------------------------------
export { buildBacklinkIndex, backlinkCount } from "./backlinks.ts";
export type {
  BacklinkIndex,
  BacklinkRef,
  BacklinkSourceKind,
} from "./backlinks.ts";

// ----- Operational status ---------------------------------------------------
export { computeBrainStatus } from "./status.ts";
export type {
  BrainStatusSnapshot,
  BrainStatusCounts,
  ComputeBrainStatusOptions,
} from "./status.ts";

export type {
  BrainDirs,
  AllocateSlugOptions,
  AllocateSlugResult,
} from "./paths.ts";

// ----- Configuration --------------------------------------------------------
export {
  DEFAULT_BRAIN_CONFIG,
  DEFAULT_BRAIN_CONFIG_YAML,
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  loadBrainConfig,
  loadBrainConfigDetailed,
  validateBrainConfig,
  validateBrainConfigDetailed,
  parseBrainYaml,
} from "./policy.ts";

export type {
  BrainConfigLoadWarning,
  LoadBrainConfigResult,
  ValidateResult,
} from "./policy.ts";

// ----- Time helpers ---------------------------------------------------------
export { isoSecond, isoDate } from "./time.ts";

// ----- Wikilink helpers -----------------------------------------------------
export {
  normaliseWikilinkTarget,
  parseWikilink,
  parseArtifactRef,
} from "./wikilink.ts";
export type { ArtifactRange, ArtifactRefParse } from "./wikilink.ts";

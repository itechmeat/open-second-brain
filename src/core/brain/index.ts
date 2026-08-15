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
  BrainIntegrityConfig,
  ResolvedBrainIntegrityConfig,
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
  allocateAndCreate,
  collisionCandidateName,
  SLUG_ALLOCATION_MAX_ATTEMPTS,
  validateSlug,
  validateIsoDate,
  validateRunId,
  brainVaultRelative,
  ensureInsideVault,
  vaultRelative,
} from "./paths.ts";

// ----- Dream: single-step requests and per-run gate overrides ---------------
// The two capabilities Unit E shipped. They are on the barrel because the
// CLI verb and the MCP tool are both adapters over them, and an adapter
// that has to reach past this surface is how a capability ends up with no
// operator reach at all.
export {
  DREAM_STEP,
  DREAM_STEP_RUNNABLE,
  DreamStepNotRunnableError,
  runDreamStep,
} from "./dream-step.ts";
export type {
  DreamStep,
  DreamStepResult,
  DreamScanStepResult,
  DreamHealEnrichStepResult,
} from "./dream-step.ts";
export {
  DREAM_GATE,
  DREAM_GATE_NAMES,
  DreamGateOverrideError,
  parseDreamGateOverrides,
  validateDreamGateOverrides,
} from "./dream-gates.ts";
export type { DreamGateName } from "./dream-gates.ts";
export type { DreamGateOverrides, DreamOptions } from "./dream.ts";

// ----- Active-preferences digest --------------------------------------------
export { regenerateActive, regenerateActiveQuiet } from "./active.ts";
export type { RegenerateActiveOptions, RegenerateActiveResult } from "./active.ts";

// ----- Lessons digest (signed, recency-scored, corroboration-tiered) --------
export {
  computeLessons,
  regenerateLessons,
  regenerateLessonsQuiet,
  LESSON_TIER,
  LESSON_STANCE,
} from "./lessons.ts";
export type {
  LessonEntry,
  LessonTier,
  LessonStance,
  ComputeLessonsOptions,
  RegenerateLessonsOptions,
  RegenerateLessonsResult,
} from "./lessons.ts";

// ----- Backlink index -------------------------------------------------------
export { buildBacklinkIndex, backlinkCount } from "./backlinks.ts";
export type { BacklinkIndex, BacklinkRef, BacklinkSourceKind } from "./backlinks.ts";

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
  AllocateAndCreateResult,
} from "./paths.ts";

// ----- Configuration --------------------------------------------------------
export { DEFAULT_BRAIN_CONFIG_YAML, renderBrainConfigTemplate } from "./config-template.ts";
export {
  DEFAULT_BRAIN_CONFIG,
  BRAIN_CONFIG_SUPPORTED_VERSIONS,
  BrainConfigError,
  loadBrainConfig,
  loadBrainConfigDetailed,
  validateBrainConfig,
  validateBrainConfigDetailed,
  BRAIN_INTEGRITY_DEFAULTS,
  PACK_VALIDITY_SECONDS_DEFAULT,
  resolveIntegrity,
  loadIntegrityConfigSafe,
} from "./policy.ts";
export { parseBrainYaml } from "./yaml-parse.ts";

export type { BrainConfigLoadWarning, LoadBrainConfigResult, ValidateResult } from "./policy.ts";

// ----- Time helpers ---------------------------------------------------------
export { isoSecond, isoDate } from "./time.ts";

// ----- Wikilink helpers -----------------------------------------------------
export { normaliseWikilinkTarget, parseWikilink, parseArtifactRef } from "./wikilink.ts";
export type { ArtifactRange, ArtifactRefParse } from "./wikilink.ts";

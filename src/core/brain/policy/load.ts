/**
 * Reading `<vault>/Brain/_brain.yaml` off disk, and the fallback policy
 * for vaults where that read cannot succeed.
 *
 * One reason to change: what happens when the config file is missing,
 * unreadable, or malformed. The strict entry points ({@link
 * loadBrainConfig}) throw; the `*Safe` entry points exist because several
 * read surfaces must keep working on a vault that has never run
 * `o2b brain init`, and each one documents which of the two failure modes
 * it is defending against.
 */

import { existsSync, readFileSync } from "node:fs";
import type { BrainConfig, ResolvedBrainIntegrityConfig } from "../types.ts";
import { parseBrainYaml, type ParsedBlock } from "../yaml-parse.ts";
import { brainConfigPath } from "../paths.ts";
import { BrainConfigError, type BrainConfigLoadWarning } from "./errors.ts";
import { validateBrainConfigDetailed } from "./validate.ts";
import { DEFAULT_BRAIN_CONFIG } from "./defaults.ts";
import { BRAIN_NOTES_DEFAULTS, resolveNotes } from "./blocks/notes.ts";
import { BRAIN_TEMPORAL_DEFAULTS, resolveTemporal } from "./blocks/temporal.ts";
import { BRAIN_GUARDRAIL_DEFAULTS, resolveGuardrails } from "./blocks/guardrails.ts";
import {
  BRAIN_INTEGRITY_DEFAULTS,
  BRAIN_INTEGRITY_STRICT_FALLBACK,
  resolveIntegrity,
} from "./blocks/integrity.ts";

export interface LoadBrainConfigResult {
  readonly config: BrainConfig;
  readonly warnings: ReadonlyArray<BrainConfigLoadWarning>;
  readonly path: string;
}

/**
 * Read and validate `<vault>/Brain/_brain.yaml`.
 *
 * Throws {@link BrainConfigError} on:
 *   - missing file
 *   - YAML shape errors
 *   - unsupported `schema_version`
 *   - non-integer / out-of-range thresholds
 *   - non-integer / non-positive `snapshots.retention_count`
 *
 * Unknown top-level keys are reported as warnings, not errors.
 */
export function loadBrainConfig(vault: string): BrainConfig {
  return loadBrainConfigDetailed(vault).config;
}

/**
 * Same as {@link loadBrainConfig} but also returns parser warnings (for
 * the future `o2b brain doctor` integration).
 */
export function loadBrainConfigDetailed(vault: string): LoadBrainConfigResult {
  const path = brainConfigPath(vault);
  if (!existsSync(path)) {
    throw new BrainConfigError(
      "config file does not exist; run `o2b brain init` first",
      null,
      path,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new BrainConfigError(
      `failed to read: ${(err as Error).message ?? String(err)}`,
      null,
      path,
    );
  }

  let parsed: ParsedBlock;
  try {
    parsed = parseBrainYaml(text);
  } catch (err) {
    throw new BrainConfigError((err as Error).message, null, path);
  }

  const { config, warnings } = validateBrainConfigDetailed(parsed, path);
  return { config, warnings, path };
}

/**
 * Factory for the "load + resolve a block, fall back to its defaults on
 * ANY failure" pattern repeated at every `load*ConfigSafe` below (missing
 * `_brain.yaml`, malformed YAML, or a validation error all collapse to
 * the same fallback - these are read surfaces for vaults that may not
 * have run `brain init` yet, not strict config consumers).
 */
function makeSafeLoader<T>(
  resolveFn: (config: BrainConfig) => T,
  fallback: T,
): (vault: string) => T {
  return (vault: string): T => {
    try {
      return resolveFn(loadBrainConfig(vault));
    } catch {
      return fallback;
    }
  };
}

/**
 * Load + resolve the `notes:` block, falling back to
 * `BRAIN_NOTES_DEFAULTS` when the config file is missing, malformed,
 * or otherwise unreadable. Same pattern as `loadTemporalConfigSafe`.
 * Used by `scan-inline` and any future scanner so a freshly-cloned
 * vault that has not been `brain init`-ed still produces a clean
 * "no user folders to read" result.
 */
export const loadNotesConfigSafe = makeSafeLoader(resolveNotes, BRAIN_NOTES_DEFAULTS);

/**
 * Load + resolve the `temporal:` block, falling back to
 * `BRAIN_TEMPORAL_DEFAULTS` when the config file is missing,
 * malformed, or otherwise unreadable. Used by every temporal
 * consumer (MCP wrappers, CLI verbs) so a freshly-initialised vault
 * still produces a useful report.
 */
export const loadTemporalConfigSafe = makeSafeLoader(resolveTemporal, BRAIN_TEMPORAL_DEFAULTS);

/**
 * Load + resolve the `guardrails:` block, falling back to
 * `BRAIN_GUARDRAIL_DEFAULTS` when the config file is missing, malformed,
 * or otherwise unreadable. Used by agent-facing surfaces (e.g. the
 * context pack) that must work on a vault without a full `brain init`;
 * the opt-in toggles therefore default off rather than throwing.
 */
export const loadGuardrailsConfigSafe = makeSafeLoader(resolveGuardrails, BRAIN_GUARDRAIL_DEFAULTS);

/**
 * Load the configured `feedback.default_scope`, or `undefined` when the
 * config file is missing, malformed, or carries no feedback block. Used
 * by the feedback write surfaces so a vault without a full `brain init`
 * stays scope-less (byte-identical to pre-feature behaviour) instead of
 * throwing when the signal is recorded.
 */
export const loadFeedbackDefaultScopeSafe = makeSafeLoader(
  (config: BrainConfig) => config.feedback?.default_scope,
  undefined as string | undefined,
);

/**
 * Load the configured snapshot `retention_count`, falling back to the
 * default when the config file is missing, malformed, or otherwise
 * unreadable. The destructive-snapshot gate uses this so a vault that
 * has not run `brain init` still prunes to a sane bound rather than
 * throwing mid-cleanup. This is the SAME `snapshots.retention_count`
 * the dream pass reads via `loadBrainConfig`; the safe variant just
 * tolerates an uninitialised vault the way every other read surface
 * does.
 */
export const loadSnapshotRetentionSafe = makeSafeLoader(
  (config: BrainConfig) => config.snapshots.retention_count,
  DEFAULT_BRAIN_CONFIG.snapshots.retention_count,
);

/**
 * Why `_brain.yaml` could not be read, or `null` when it reads fine or
 * does not exist.
 *
 * Exists so the unreadable-config condition is NAMEABLE on a surface
 * rather than only inferable from a gate that suddenly refuses. The
 * runtime-notice channel reports it; `loadIntegrityConfigSafe` uses the
 * same distinction to choose its fallback.
 */
export function brainConfigReadFailure(vault: string): string | null {
  if (!existsSync(brainConfigPath(vault))) return null;
  try {
    loadBrainConfig(vault);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Load + resolve the `integrity:` block.
 *
 * Two failure modes, deliberately NOT collapsed into one:
 *
 *   - CONFIG ABSENT - a vault that has never run `o2b brain init`. The
 *     search layer reads its gate on a store open and must keep working
 *     there, so the gates land on `BRAIN_INTEGRITY_DEFAULTS`. This is the
 *     case the safe-loader pattern legitimately defends.
 *   - CONFIG PRESENT BUT UNREADABLE - a bad gate token, or any unrelated
 *     syntax error anywhere else in the file. Falling back to the
 *     defaults here would silently turn an operator's
 *     `owner_scope_delivery: fail` into `off`. It resolves to
 *     {@link BRAIN_INTEGRITY_STRICT_FALLBACK} instead, and
 *     {@link brainConfigReadFailure} names the cause.
 */
export function loadIntegrityConfigSafe(vault: string): ResolvedBrainIntegrityConfig {
  try {
    return resolveIntegrity(loadBrainConfig(vault));
  } catch {
    return existsSync(brainConfigPath(vault))
      ? BRAIN_INTEGRITY_STRICT_FALLBACK
      : BRAIN_INTEGRITY_DEFAULTS;
  }
}

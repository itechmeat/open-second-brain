/**
 * Reading `<vault>/Brain/_brain.yaml` off disk, and the fallback policy
 * for vaults where that read cannot succeed.
 *
 * One reason to change: what happens when the config file is missing,
 * unreadable, or malformed. Those are TWO conditions, not one, and every
 * entry point here splits on the same predicate:
 *
 *   - ABSENT - a vault that has never run `o2b brain init`. There are no
 *     operator settings to contradict, so the documented defaults are the
 *     configuration. The `*Safe` entry points exist for exactly this, so
 *     a freshly-cloned vault keeps working.
 *   - PRESENT BUT UNREADABLE - malformed YAML, a block that does not
 *     validate, a permission error, a directory in the file's place. The
 *     operator's settings exist and are not in force; answering with the
 *     defaults would revert them silently and leave the vault looking
 *     healthy. The `*Safe` entry points do not absorb this.
 *
 * The strict entry point ({@link loadBrainConfig}) throws on both.
 */

import { existsSync, readFileSync } from "node:fs";
import type { BrainConfig, BrainInstallConfig, ResolvedBrainIntegrityConfig } from "../types.ts";
import { parseBrainYaml, type ParsedBlock } from "../yaml-parse.ts";
import { brainConfigPath } from "../paths.ts";
import { BrainConfigError, type BrainConfigLoadWarning } from "./errors.ts";
import { validateBrainConfigDetailed } from "./validate.ts";
import { DEFAULT_BRAIN_CONFIG } from "./defaults.ts";
import { BRAIN_MOST_APPLIED_DEFAULTS, resolveMostApplied } from "./blocks/active.ts";
import { BRAIN_NOTES_DEFAULTS, resolveNotes } from "./blocks/notes.ts";
import { BRAIN_TEMPORAL_DEFAULTS, resolveTemporal } from "./blocks/temporal.ts";
import { BRAIN_GUARDRAIL_DEFAULTS, resolveGuardrails } from "./blocks/guardrails.ts";
import { BRAIN_MAINTENANCE_DEFAULTS, resolveMaintenance } from "./blocks/maintenance.ts";
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
 * Whether `<vault>/Brain/_brain.yaml` is there at all.
 *
 * The ONE predicate every reader in this module splits on, so "absent"
 * cannot come to mean two different things on two surfaces. It is
 * deliberately existence and nothing more: a file that exists but cannot
 * be opened is present, and its contents are not the defaults.
 */
function brainConfigExists(vault: string): boolean {
  return existsSync(brainConfigPath(vault));
}

/**
 * Factory for the "resolve a block, tolerating a vault that has never
 * run `o2b brain init`" pattern repeated at every `load*ConfigSafe`
 * below.
 *
 * Exactly ONE condition is absorbed, and it is named: `_brain.yaml` is
 * ABSENT. A vault with no config has no operator settings to contradict,
 * so the block defaults ARE the configuration, and these read surfaces
 * keep working on a freshly-cloned vault.
 *
 * Every other failure propagates as a {@link BrainConfigError}: malformed
 * YAML, a block that parses but does not validate, a permission error, a
 * directory where the file should be. All four mean the operator's
 * settings exist and are NOT the ones in force, and answering with the
 * defaults would make that vault indistinguishable from a healthy one
 * while silently reverting whatever they configured. This is the same
 * split {@link loadIntegrityConfigSafe} makes; it differs only in what it
 * does with the unreadable case, and says why at its own site.
 */
function makeAbsentTolerantLoader<T>(
  resolveFn: (config: BrainConfig) => T,
  fallback: T,
): (vault: string) => T {
  return (vault: string): T => {
    if (!brainConfigExists(vault)) return fallback;
    return resolveFn(loadBrainConfig(vault));
  };
}

/**
 * Load + resolve the `notes:` block, falling back to
 * `BRAIN_NOTES_DEFAULTS` when the config file is absent. Used by
 * `scan-inline` and every other note walk so a freshly-cloned vault that
 * has not been `brain init`-ed still produces a clean "no user folders to
 * read" result. On an unreadable config it raises: an empty root list is
 * indistinguishable from a scan that found nothing, and a scanner that
 * silently walks the wrong folders is worse than one that stops.
 */
export const loadNotesConfigSafe = makeAbsentTolerantLoader(resolveNotes, BRAIN_NOTES_DEFAULTS);

/**
 * Load + resolve the `temporal:` block, falling back to
 * `BRAIN_TEMPORAL_DEFAULTS` when the config file is absent. Used by every
 * temporal consumer (MCP wrappers, CLI verbs) so a freshly-initialised
 * vault still produces a useful report; each of those callers is a verb
 * or a tool that can report the raise on an unreadable config, and the
 * operator snapshot already degrades its own way rather than reading
 * all-clear.
 */
export const loadTemporalConfigSafe = makeAbsentTolerantLoader(
  resolveTemporal,
  BRAIN_TEMPORAL_DEFAULTS,
);

/**
 * Load + resolve the `guardrails:` block, falling back to
 * `BRAIN_GUARDRAIL_DEFAULTS` when the config file is absent. Used by
 * agent-facing surfaces (e.g. the context pack) that must work on a vault
 * without a full `brain init`; the opt-in toggles therefore default off
 * there. They must NOT default off on a vault where the operator turned
 * one on and then broke the file: every flag in this block is a
 * containment or isolation switch, so a quiet revert to `false` is the
 * gate silently opening.
 */
export const loadGuardrailsConfigSafe = makeAbsentTolerantLoader(
  resolveGuardrails,
  BRAIN_GUARDRAIL_DEFAULTS,
);

/**
 * Load the configured `feedback.default_scope`, or `undefined` when the
 * config file is absent or carries no feedback block. Used by the
 * feedback write surfaces so a vault without a full `brain init` stays
 * scope-less (byte-identical to pre-feature behaviour) instead of
 * throwing when the signal is recorded. An unreadable config raises
 * before the write: a signal recorded under the wrong scope is a durable
 * record no later fix reaches.
 */
export const loadFeedbackDefaultScopeSafe = makeAbsentTolerantLoader(
  (config: BrainConfig) => config.feedback?.default_scope,
  undefined as string | undefined,
);

/**
 * Load the configured snapshot `retention_count`, falling back to the
 * default when the config file is absent, so a vault that has not run
 * `brain init` still prunes to a sane bound. This is the SAME
 * `snapshots.retention_count` the dream pass reads via
 * {@link loadBrainConfig}.
 *
 * An unreadable config raises, and the prune is the one caller that most
 * needs it to: pruning is destructive, and doing it at a GUESSED
 * retention deletes archives the operator asked to keep. The
 * destructive-snapshot gate already catches a prune failure and warns on
 * stderr with the operation's result intact, so the raise costs a
 * deferred cleanup and buys a named cause.
 */
export const loadSnapshotRetentionSafe = makeAbsentTolerantLoader(
  (config: BrainConfig) => config.snapshots.retention_count,
  DEFAULT_BRAIN_CONFIG.snapshots.retention_count,
);

/**
 * Derived-store coverage as the archiver consumes it: whether to include
 * the store, and the ceiling above which inclusion is refused.
 *
 * A pair rather than two loaders because the two are never useful apart
 * - the ceiling only means anything when inclusion is on, and reading
 * them from two config loads would let one call see a file the other
 * did not.
 */
export interface BrainDerivedStorePolicy {
  readonly include: boolean;
  readonly maxBytes: number;
}

/**
 * Load `snapshots.include_derived_store` and
 * `snapshots.derived_store_max_bytes`, falling back to the defaults when
 * the config file is absent so a vault that has never run `brain init`
 * still snapshots its Markdown tree (with coverage off, which is what
 * the defaults say).
 *
 * An unreadable config raises, exactly as it does for the retention
 * count beside it: coverage is what an operator turned ON, and answering
 * with the default `false` would silently strip the store out of every
 * recovery point on a vault whose `_brain.yaml` merely has a typo.
 */
export const loadSnapshotDerivedStorePolicySafe = makeAbsentTolerantLoader<BrainDerivedStorePolicy>(
  (config: BrainConfig) => ({
    include: config.snapshots.include_derived_store,
    maxBytes: config.snapshots.derived_store_max_bytes,
  }),
  Object.freeze({
    include: DEFAULT_BRAIN_CONFIG.snapshots.include_derived_store,
    maxBytes: DEFAULT_BRAIN_CONFIG.snapshots.derived_store_max_bytes,
  }),
);

/**
 * Load + resolve the `maintenance:` block, falling back to
 * `BRAIN_MAINTENANCE_DEFAULTS` when the config file is absent — which
 * leaves the host-pressure gate unconfigured, exactly as an operator who
 * has never run `o2b brain init` has never asked for it.
 *
 * An unreadable config raises, and that is the point: both knobs here
 * decide whether heavy work starts, so answering with the defaults would
 * run a pass the operator had gated and retry a task the operator's
 * limit had refused, on a vault that otherwise looks healthy.
 */
export const loadMaintenanceConfigSafe = makeAbsentTolerantLoader(
  resolveMaintenance,
  BRAIN_MAINTENANCE_DEFAULTS,
);

/**
 * Load the RAW `install:` block, or `undefined` when the config file is
 * absent or declares no block.
 *
 * The one loader here that hands back the unresolved block rather than a
 * resolved value, because its consumer
 * (`src/core/install/settings.ts`) sits in the middle of a four-tier
 * ladder: the committed vault tier outranks the machine-local
 * `config.yaml`, so "the block set this key" and "the block did not" must
 * stay distinguishable. Resolving here would fold them together and hand
 * the compiled default a victory over a user-level key that should have
 * won.
 *
 * An unreadable config raises, and for this reader that is the whole
 * point rather than a side effect: generated install and hook content is
 * a WRITER, and it cannot infer an operator's intent from a file it could
 * not parse. Defaulting would silently regenerate the shipped timeout
 * over a vault whose `_brain.yaml` merely has a typo, and the
 * re-construction check would then report the operator's own file as
 * drift on every other machine.
 */
export const loadInstallBlockSafe = makeAbsentTolerantLoader(
  (config: BrainConfig) => config.install,
  undefined as BrainInstallConfig | undefined,
);

/**
 * Load + resolve `active.most_applied`, falling back to
 * `BRAIN_MOST_APPLIED_DEFAULTS` when the config file is absent, so a vault
 * that has never run `brain init` still renders its most-applied section
 * over the documented window. Read by `active.md` and by the digest, which
 * report the same section and must agree on its window.
 *
 * An unreadable config raises: the section is the operator's own list of
 * the rules they lean on, and re-windowing it silently would change WHICH
 * rules appear while the digest looks entirely healthy. Both callers have
 * a channel for the raise - the CLI verb reports `digest failed: …`, the
 * MCP tool returns the error - so neither has to guess a window.
 */
export const loadActiveMostAppliedSafe = makeAbsentTolerantLoader(
  resolveMostApplied,
  BRAIN_MOST_APPLIED_DEFAULTS,
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
  if (!brainConfigExists(vault)) return null;
  try {
    loadBrainConfig(vault);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The one-line operator-facing statement of {@link brainConfigReadFailure},
 * or `null` when the config is absent or reads fine.
 *
 * One formulation, because the condition now reaches an operator on more
 * than one surface: the runtime-notice channel pushes it at SessionStart
 * and `vault_health`, and a delivery surface that DEGRADED because of it
 * carries it on its own result. Two hand-written copies of the same
 * sentence would drift, and an operator who saw one would not recognise
 * the other as the same fault.
 *
 * It names no command on purpose. The repair is an edit to the YAML the
 * parser just rejected and no `o2b` verb performs it, which is why
 * `brain_config_unreadable` is deliberately absent from
 * `DIAGNOSTIC_SIGNALS` - see the notice that raises it. The cause the
 * parser gave IS the actionable part, so it is quoted verbatim.
 */
export function brainConfigUnreadableReport(vault: string): string | null {
  const failure = brainConfigReadFailure(vault);
  if (failure === null) return null;
  return (
    `Brain/_brain.yaml could not be read, so configured settings are not in force ` +
    `and the integrity gates fall back to their strictest mode (${failure}). ` +
    `Fix the file, then re-run.`
  );
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
 *
 * This is the one reader that resolves rather than raises on the second
 * case, and the reason is its caller: the search layer reads its gate on
 * every store open, including inside a fail-soft path, so a throw there
 * would take out recall instead of tightening it. Resolving STRICT is
 * what makes that safe - the unreadable config cannot loosen a gate, it
 * can only close one.
 */
export function loadIntegrityConfigSafe(vault: string): ResolvedBrainIntegrityConfig {
  try {
    return resolveIntegrity(loadBrainConfig(vault));
  } catch {
    return brainConfigExists(vault) ? BRAIN_INTEGRITY_STRICT_FALLBACK : BRAIN_INTEGRITY_DEFAULTS;
  }
}

/**
 * Load + resolve the `integrity:` block for a WRITER.
 *
 * The reader/writer asymmetry, stated on the side it belongs to. This
 * sits on the WRITE side, and it is the absent-tolerant loader every
 * other block already uses ({@link makeAbsentTolerantLoader}) - absent
 * config resolves to the documented defaults, an unreadable one raises.
 *
 * It is NOT {@link loadIntegrityConfigSafe}, and the difference is the
 * point. That loader's strict fallback has a rationale scoped entirely
 * to READERS: "the unreadable config cannot loosen a gate, it can only
 * close one". Closing a gate a reader cannot read is conservative -
 * the reader withholds more than it had to, and nothing on disk
 * changes. Handing the same strict verdict to a writer inverts it:
 * `owner_scope_delivery` in its strict reading STAMPS, so one bad token
 * anywhere in `_brain.yaml` made a preference writer start marking new
 * pages `owner: <whoever wrote them>` - permanently, because ownership
 * is carried forward and never re-derived, so the pages outlived the
 * repair of the typo that caused them. On an install with no resolvable
 * identity the same typo turned every preference write into a hard
 * failure instead.
 *
 * A writer cannot infer an operator's intent to enable ownership from a
 * file it could not read, so it does not try. It raises, naming the
 * parse failure, and writes nothing: never a silent stamp, never a
 * silent skip.
 */
export const loadIntegrityConfigForWrite = makeAbsentTolerantLoader(
  resolveIntegrity,
  BRAIN_INTEGRITY_DEFAULTS,
);

/**
 * The `storage:` block - the operator-configured capacity policy the
 * storage lifecycle reads: the byte cap, the two percent thresholds and
 * the two day horizons.
 *
 * One reason to change: what an operator may bound about their vault's
 * storage. Absent `cap_bytes` is the DEFAULT and means unbounded: no cap
 * by default means nothing pauses and nothing refuses, exactly as an
 * unconfigured maintenance window leaves the lane always open. A cap
 * only ever comes from an explicit operator decision recorded in this
 * file - the one file no tool call can rewrite.
 *
 * Out-of-range values are hard errors, following the policy stated in
 * `../field-checks.ts`: a knob that silently clamped would be
 * indistinguishable from the operator never having set it, and for a
 * gate that refuses writes the operator would believe a bound is in
 * force that is not - or believe it is not, while it is.
 *
 * The four thresholds default to the forecast's module constants
 * (`../../storage/forecast.ts`), imported rather than restated, so the
 * resolver and the forecast cannot disagree about what a default is.
 */

import type { BrainConfig, BrainStorageConfig, ResolvedBrainStorageConfig } from "../../types.ts";
import {
  STORAGE_CRITICAL_DAYS_DEFAULT,
  STORAGE_CRITICAL_PERCENT_DEFAULT,
  STORAGE_WARN_DAYS_DEFAULT,
  STORAGE_WARN_PERCENT_DEFAULT,
} from "../../storage/forecast.ts";
import { readBoundedInt } from "../field-checks.ts";
import { BrainConfigError } from "../errors.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";

const BLOCK = "storage";

/**
 * A cap must be a positive whole number of bytes. Zero would put every
 * vault past its cap the moment the block is written - not a cap but a
 * way to refuse everything, and the way to do that is a cap the operator
 * chose on purpose.
 */
export const STORAGE_CAP_BYTES_MIN = 1;

/** Percents are bounded to the open-at-zero, closed-at-100 range. */
export const STORAGE_PERCENT_MIN = 1;
export const STORAGE_PERCENT_MAX = 100;

/** Day horizons are positive whole days. */
export const STORAGE_DAYS_MIN = 1;

const KNOWN_KEYS = [
  "cap_bytes",
  "warn_percent",
  "critical_percent",
  "pause_percent",
  "warn_days",
  "critical_days",
] as const;

/**
 * Defaults for an absent block. `cap_bytes` is `null` rather than a
 * number: the capacity gate has no neutral default, because any number
 * would start refusing writes on vaults whose operator never asked for a
 * gate - the same shape as the unconfigured maintenance pressure gate.
 */
export const BRAIN_STORAGE_DEFAULTS: ResolvedBrainStorageConfig = Object.freeze({
  cap_bytes: null,
  warn_percent: STORAGE_WARN_PERCENT_DEFAULT,
  critical_percent: STORAGE_CRITICAL_PERCENT_DEFAULT,
  pause_percent: STORAGE_WARN_PERCENT_DEFAULT,
  warn_days: STORAGE_WARN_DAYS_DEFAULT,
  critical_days: STORAGE_CRITICAL_DAYS_DEFAULT,
}) as ResolvedBrainStorageConfig;

/**
 * Merge a parsed `storage` block (or `undefined`) with the defaults.
 *
 * An absent `pause_percent` follows the block's warn band - the lane
 * pauses where the forecast warns unless the operator names the pause
 * line themselves.
 */
export function resolveStorage(cfg: BrainConfig): ResolvedBrainStorageConfig {
  const s = cfg.storage;
  if (s === undefined) return BRAIN_STORAGE_DEFAULTS;
  const warnPercent = s.warn_percent ?? BRAIN_STORAGE_DEFAULTS.warn_percent;
  return {
    cap_bytes: s.cap_bytes ?? BRAIN_STORAGE_DEFAULTS.cap_bytes,
    warn_percent: warnPercent,
    critical_percent: s.critical_percent ?? BRAIN_STORAGE_DEFAULTS.critical_percent,
    pause_percent: s.pause_percent ?? warnPercent,
    warn_days: s.warn_days ?? BRAIN_STORAGE_DEFAULTS.warn_days,
    critical_days: s.critical_days ?? BRAIN_STORAGE_DEFAULTS.critical_days,
  };
}

/**
 * Shape:
 *   storage:
 *     cap_bytes: 1073741824   # positive integer bytes; absent = unbounded
 *     warn_percent: 80        # integer in [1, 100]; must be < critical_percent
 *     critical_percent: 95    # integer in [1, 100]; must be > warn_percent
 *     pause_percent: 80       # integer in [1, 100]; must be < critical_percent
 *                             # and defaults to the warn band
 *     warn_days: 30           # positive integer; must be > critical_days
 *     critical_days: 7        # positive integer; must be < warn_days
 */
export function parseStorageBlock(ctx: BlockParseContext): BrainStorageConfig | undefined {
  const map = openBlock(ctx, BLOCK);
  if (map === undefined) return undefined;

  const capBytes = readCapBytes(map, ctx);
  const warnPercent = readBoundedInt(
    map,
    "warn_percent",
    STORAGE_PERCENT_MIN,
    STORAGE_PERCENT_MAX,
    "storage.warn_percent",
    ctx.source,
  );
  const criticalPercent = readBoundedInt(
    map,
    "critical_percent",
    STORAGE_PERCENT_MIN,
    STORAGE_PERCENT_MAX,
    "storage.critical_percent",
    ctx.source,
  );
  const pausePercent = readBoundedInt(
    map,
    "pause_percent",
    STORAGE_PERCENT_MIN,
    STORAGE_PERCENT_MAX,
    "storage.pause_percent",
    ctx.source,
  );
  assertCriticalAboveWarn(warnPercent, criticalPercent, ctx);
  assertPauseBelowCritical(pausePercent, criticalPercent, ctx);
  const warnDays = readBoundedInt(
    map,
    "warn_days",
    STORAGE_DAYS_MIN,
    Number.MAX_SAFE_INTEGER,
    "storage.warn_days",
    ctx.source,
  );
  const criticalDays = readBoundedInt(
    map,
    "critical_days",
    STORAGE_DAYS_MIN,
    Number.MAX_SAFE_INTEGER,
    "storage.critical_days",
    ctx.source,
  );
  assertCriticalNearerThanWarn(warnDays, criticalDays, ctx);

  warnUnknownKeys(ctx, map, KNOWN_KEYS, BLOCK);
  return {
    ...(capBytes !== undefined ? { cap_bytes: capBytes } : {}),
    ...(warnPercent !== undefined ? { warn_percent: warnPercent } : {}),
    ...(criticalPercent !== undefined ? { critical_percent: criticalPercent } : {}),
    ...(pausePercent !== undefined ? { pause_percent: pausePercent } : {}),
    ...(warnDays !== undefined ? { warn_days: warnDays } : {}),
    ...(criticalDays !== undefined ? { critical_days: criticalDays } : {}),
  };
}

/**
 * Read `cap_bytes`, also accepting an explicit `null` as "no cap" - the
 * template shows the key commented out, and an operator who uncomments
 * it with `null` is spelling the default intent, not a typo.
 */
function readCapBytes(
  map: Readonly<Record<string, unknown>>,
  ctx: BlockParseContext,
): number | undefined {
  if (!("cap_bytes" in map)) return undefined;
  const v = map["cap_bytes"];
  if (v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < STORAGE_CAP_BYTES_MIN) {
    throw new BrainConfigError(
      `must be a positive integer number of bytes; got ${JSON.stringify(v)}`,
      "storage.cap_bytes",
      ctx.source,
    );
  }
  return v;
}

/**
 * The critical percent band must begin ABOVE the warn band. Compared at
 * parse time, pair-wise over whichever of the two are present, each
 * against the default the other would resolve to - so `warn_percent: 95`
 * alone errors exactly as `critical_percent: 95` spelled beside an
 * 80-percent warn would. The error names the key(s) actually at fault:
 * the lone set key whose value broke the pair against the other's
 * default, or the pair when both were spelled and either could yield.
 */
function assertCriticalAboveWarn(
  warnPercent: number | undefined,
  criticalPercent: number | undefined,
  ctx: BlockParseContext,
): void {
  const warn = warnPercent ?? BRAIN_STORAGE_DEFAULTS.warn_percent;
  const critical = criticalPercent ?? BRAIN_STORAGE_DEFAULTS.critical_percent;
  if (criticalPercent !== undefined || warnPercent !== undefined) {
    if (critical <= warn) {
      const [field, message] =
        warnPercent !== undefined && criticalPercent !== undefined
          ? [
              "storage.warn_percent, storage.critical_percent",
              `the critical band must begin above the warn band: critical_percent (${critical}) must be greater than warn_percent (${warn})`,
            ]
          : warnPercent !== undefined
            ? [
                "storage.warn_percent",
                `must be smaller than critical_percent (${critical}); got ${warn}`,
              ]
            : [
                "storage.critical_percent",
                `must be greater than warn_percent (${warn}); got ${critical}`,
              ];
      throw new BrainConfigError(message, field, ctx.source);
    }
  }
}

/**
 * The pause line must sit strictly BELOW the critical band, whether
 * critical is spelled in the block or at its default: a pause at or past
 * the refuse line could never pause anything - the ingest wall fires
 * first at critical - so the knob would sit configured and dead. Only an
 * explicitly set `pause_percent` is checked: an absent one defaults to
 * the warn band, and warn-below-critical is already the existing pair
 * check's contract, so a default-inferred pause can never violate this
 * without that check firing first.
 */
function assertPauseBelowCritical(
  pausePercent: number | undefined,
  criticalPercent: number | undefined,
  ctx: BlockParseContext,
): void {
  if (pausePercent === undefined) return;
  const critical = criticalPercent ?? BRAIN_STORAGE_DEFAULTS.critical_percent;
  if (pausePercent < critical) return;
  throw new BrainConfigError(
    `must be smaller than critical_percent (${critical}); the pause line governs background ` +
      `work and interactive ingest is already refused at the critical band - got ${pausePercent}`,
    "storage.pause_percent",
    ctx.source,
  );
}

/**
 * The critical day horizon must be NEARER than the warn horizon, same
 * rule, and the error names the key(s) actually at fault the same way.
 */
function assertCriticalNearerThanWarn(
  warnDays: number | undefined,
  criticalDays: number | undefined,
  ctx: BlockParseContext,
): void {
  const warn = warnDays ?? BRAIN_STORAGE_DEFAULTS.warn_days;
  const critical = criticalDays ?? BRAIN_STORAGE_DEFAULTS.critical_days;
  if (criticalDays !== undefined || warnDays !== undefined) {
    if (critical >= warn) {
      const [field, message] =
        warnDays !== undefined && criticalDays !== undefined
          ? [
              "storage.warn_days, storage.critical_days",
              `the critical horizon must be nearer than the warn horizon: critical_days (${critical}) must be smaller than warn_days (${warn})`,
            ]
          : warnDays !== undefined
            ? ["storage.warn_days", `must be greater than critical_days (${critical}); got ${warn}`]
            : [
                "storage.critical_days",
                `must be smaller than warn_days (${warn}); got ${critical}`,
              ];
      throw new BrainConfigError(message, field, ctx.source);
    }
  }
}

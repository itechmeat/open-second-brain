/**
 * The storage forecast and the usage sampler.
 *
 * The sampler is the write half: one `measureStorageUsage` census folded
 * into one `storage_usage` record in the metrics sink per run id. The
 * forecast is the read half: a linear trend over the stored samples plus
 * the freshest reading, projected against the configured cap.
 *
 * ## The two-truths rule
 *
 * The stored aggregate and a fresh census are different kinds of
 * evidence, and the forecast treats them differently on purpose. The
 * samples are advisory - a stale-counter lie is exactly what a
 * re-measured vault would produce if the forecast trusted the newest
 * recorded total - so samples alone never tier: fewer than two stored
 * samples is the named `no_forecast` state. A FRESH reading
 * (`latestUsage`, measured at decision time) is enforcement truth: hand
 * one in and the percent tiers compute from it even with an empty
 * history, which is what keeps a gate honest on a vault that filled up
 * before it ever sampled twice.
 *
 * ## The trend
 *
 * The slope is DAY-based, because the thing it forecasts is growth per
 * day. Samples are bucketed to one point per UTC day (the day's last
 * sample wins), the fit needs {@link MIN_TREND_DAYS} distinct days
 * before it exists at all, and it runs over the trailing
 * {@link TREND_WINDOW_DAYS} days only, so old history - including
 * reclamation - stops steering the line after the window slides past.
 * Until the minimum exists there is no `daysToCap` figure and the tier
 * answers from the percent alone: two calls of the storage report a
 * minute apart, with one ordinary write between them, must never
 * extrapolate a burst into a full vault (the H2 failure this replaces).
 *
 * ## Tier boundaries
 *
 * The boundaries are module-level constants and the comparison is
 * inclusive at each boundary: exactly 80 percent used, or exactly 30
 * days to the cap, is `warn`; exactly 95 percent, or exactly 7 days, is
 * `critical`. The defaults are consumed by the `storage:` policy block
 * (`../policy/blocks/storage.ts`), which overrides them with the same
 * names, so the template and the resolver cannot disagree about what a
 * default is.
 *
 * ## Refusals
 *
 * An absent cap is `unbounded`. A measurement that could not read every
 * surface is `unmeasurable` with the refused surfaces carried: a census
 * that missed a surface would understate usage by exactly those bytes,
 * so the forecast refuses instead of projecting from partial numbers -
 * the same measured-or-refused posture as the meter and `HOST_PRESSURE`.
 */

import { appendMetric, listMetrics, type MetricRecord } from "../metrics.ts";
import { measureStorageUsage, type StorageUnmeasuredSurface, type StorageUsage } from "./usage.ts";

/** The metric surface one usage sample rides. */
export const STORAGE_USAGE_METRIC_SURFACE = "storage_usage";

/**
 * The warn boundary, as percent of cap. Inclusive: exactly 80 warns.
 */
export const STORAGE_WARN_PERCENT_DEFAULT = 80;

/** The critical boundary, as percent of cap. Inclusive: exactly 95 is critical. */
export const STORAGE_CRITICAL_PERCENT_DEFAULT = 95;

/** The warn boundary in days to the cap, at the measured trend. Inclusive. */
export const STORAGE_WARN_DAYS_DEFAULT = 30;

/** The critical boundary in days to the cap, at the measured trend. Inclusive. */
export const STORAGE_CRITICAL_DAYS_DEFAULT = 7;

/** Stored samples needed before the newest stored point may stand in for a census. */
const MIN_TREND_SAMPLES = 2;

/**
 * Distinct UTC days the trend fits over. Below this there is no slope at
 * all: two closely spaced samples around one ordinary write would
 * otherwise extrapolate that burst to a huge daily growth and drive a
 * vault a third full to `critical`. Three days is the shortest span that
 * describes a rate rather than a single jump.
 */
export const MIN_TREND_DAYS = 3;

/**
 * The fit runs over this many trailing days of samples, never the whole
 * history: a vault that shrank a season ago must not carry that slope
 * forward once the window has slid past it.
 */
export const TREND_WINDOW_DAYS = 30;

/** Milliseconds in one day; the unit the trend is reported in. */
const MS_PER_DAY = 86_400_000;

/** The closed forecast vocabulary. */
export const STORAGE_FORECAST_TIER = Object.freeze({
  ok: "ok",
  warn: "warn",
  critical: "critical",
  unbounded: "unbounded",
  unmeasurable: "unmeasurable",
  noForecast: "no_forecast",
} as const);

export type StorageForecastTier =
  (typeof STORAGE_FORECAST_TIER)[keyof typeof STORAGE_FORECAST_TIER];

/** The tiers that answer "how full", in increasing severity. */
export const STORAGE_MEASURED_TIERS: ReadonlyArray<StorageForecastTier> = Object.freeze([
  STORAGE_FORECAST_TIER.ok,
  STORAGE_FORECAST_TIER.warn,
  STORAGE_FORECAST_TIER.critical,
]);

/** Every tier, in declaration order - the measured half plus its refusals. */
export const STORAGE_FORECAST_TIERS: ReadonlyArray<StorageForecastTier> = Object.freeze([
  STORAGE_FORECAST_TIER.ok,
  STORAGE_FORECAST_TIER.warn,
  STORAGE_FORECAST_TIER.critical,
  STORAGE_FORECAST_TIER.unbounded,
  STORAGE_FORECAST_TIER.unmeasurable,
  STORAGE_FORECAST_TIER.noForecast,
]);

export function isStorageForecastTier(value: unknown): value is StorageForecastTier {
  return typeof value === "string" && Object.values(STORAGE_FORECAST_TIER).includes(value as never);
}

/** One forecast: a tier plus the numbers it rests on. */
export interface StorageForecast {
  readonly tier: StorageForecastTier;
  /**
   * The freshest trusted byte reading: `latestUsage` when one was handed
   * in, otherwise the newest sample. `null` when nothing was measured.
   */
  readonly measuredBytes: number | null;
  readonly capBytes: number | null;
  /** `measuredBytes / capBytes * 100`, or `null` with no cap or no reading. */
  readonly percentUsed: number | null;
  /**
   * Bytes per day over the trailing window of day-bucketed samples, or
   * `null` with no trend: fewer than three distinct days fits no slope.
   */
  readonly slopeBytesPerDay: number | null;
  /**
   * Days until the cap at the current trend, or `null` when there is no
   * trend (under three distinct days) or the trend does not reach the
   * cap. Null is why the percent-only tiers exist: a tier can never ride
   * a trend that was never fitted.
   */
  readonly daysToCap: number | null;
  /** The surfaces the freshest census could not read, when `unmeasurable`. */
  readonly unmeasured: ReadonlyArray<StorageUnmeasuredSurface>;
  /**
   * True when the stored history itself could not be read (the metrics
   * ledger is unreadable), so an absent trend means "could not look"
   * and not "nothing recorded". The tier still answers from a fresh
   * reading when there is one; without one the forecast stays
   * `no_forecast` rather than pretending the history was empty.
   */
  readonly samplesUnreadable: boolean;
}

export interface ForecastStorageUsageOptions {
  /** The configured cap, or `null`/absent for an unbounded vault. */
  readonly capBytes?: number | null;
  /**
   * A fresh census taken at decision time. Present, it is the reading
   * the percent tiers compute from; absent, the newest sample stands in
   * and fewer than two samples stays `no_forecast`.
   */
  readonly latestUsage?: StorageUsage;
  /** Threshold overrides; every one defaults to the module constant. */
  readonly warnPercent?: number;
  readonly criticalPercent?: number;
  readonly warnDays?: number;
  readonly criticalDays?: number;
}

/** One (time, bytes) point of the trend, in day units for exact boundaries. */
interface TrendPoint {
  readonly day: number;
  readonly bytes: number;
}

/**
 * The UTC day index of a fractional-day timestamp (days since the epoch,
 * floored). Two samples share a bucket exactly when they share a UTC
 * calendar day.
 */
function utcDay(day: number): number {
  return Math.floor(day);
}

/**
 * Parse the `storage_usage` samples into trend points: torn records and
 * PARTIAL CENSUSES drop out (a sample is trend evidence only when its
 * payload asserts `measured: true` - an incomplete census understates the
 * vault by exactly the surfaces it could not read, and the jump when they
 * become readable again would otherwise fit as growth), the rest are
 * bucketed to one point per UTC day - the day's LAST sample, so a burst
 * of intra-day readings is noise the fit never sees - and the result is
 * ordered oldest first.
 */
function parseSamples(samples: ReadonlyArray<MetricRecord>): TrendPoint[] {
  const byDay = new Map<number, TrendPoint>();
  for (const record of samples) {
    if (record.payload["measured"] !== true) continue;
    const t = Date.parse(record.run_at);
    const bytes = record.payload["total_bytes"];
    if (!Number.isFinite(t) || typeof bytes !== "number" || !Number.isFinite(bytes)) continue;
    const point: TrendPoint = { day: t / MS_PER_DAY, bytes };
    const kept = byDay.get(utcDay(point.day));
    // Later in the day wins; a tie keeps the record read last, which is
    // the one appended later.
    if (kept === undefined || point.day >= kept.day) byDay.set(utcDay(point.day), point);
  }
  return [...byDay.values()].toSorted((a, b) => a.day - b.day);
}

/**
 * Least-squares slope in bytes per day over the day-bucketed points, or
 * `null` when no day-based trend exists: fewer than
 * {@link MIN_TREND_DAYS} distinct days inside the trailing
 * {@link TREND_WINDOW_DAYS}-day window fits nothing, and the caller
 * tiers on percent only.
 */
function linearSlope(points: ReadonlyArray<TrendPoint>): number | null {
  if (points.length < MIN_TREND_DAYS) return null;
  const newestDay = points[points.length - 1]!.day;
  const window = points.filter((p) => p.day >= newestDay - TREND_WINDOW_DAYS);
  if (window.length < MIN_TREND_DAYS) return null;
  const n = window.length;
  const meanDay = window.reduce((s, p) => s + p.day, 0) / n;
  const meanBytes = window.reduce((s, p) => s + p.bytes, 0) / n;
  let cov = 0;
  let varDay = 0;
  for (const p of window) {
    const dx = p.day - meanDay;
    cov += dx * (p.bytes - meanBytes);
    varDay += dx * dx;
  }
  if (varDay === 0) return null;
  return cov / varDay;
}

/**
 * Forecast one vault's storage trajectory against its cap.
 *
 * Reads the vault's own `storage_usage` samples; hand `latestUsage` in
 * when the caller has just measured the vault and wants the decision on
 * fresh numbers (the capacity gate always does - see `./gate.ts`).
 */
export function forecastStorageUsage(
  vault: string,
  opts: ForecastStorageUsageOptions = {},
): StorageForecast {
  const capBytes = opts.capBytes ?? null;
  const warnPercent = opts.warnPercent ?? STORAGE_WARN_PERCENT_DEFAULT;
  const criticalPercent = opts.criticalPercent ?? STORAGE_CRITICAL_PERCENT_DEFAULT;
  const warnDays = opts.warnDays ?? STORAGE_WARN_DAYS_DEFAULT;
  const criticalDays = opts.criticalDays ?? STORAGE_CRITICAL_DAYS_DEFAULT;

  if (capBytes === null) {
    return {
      tier: STORAGE_FORECAST_TIER.unbounded,
      measuredBytes: opts.latestUsage?.totalBytes ?? null,
      capBytes: null,
      percentUsed: null,
      slopeBytesPerDay: null,
      daysToCap: null,
      unmeasured: [],
      samplesUnreadable: false,
    };
  }

  // The metrics module reads fail-soft for a missing ledger; a ledger
  // that exists but cannot be listed (a file in its place, a denial)
  // still throws out of that read, so the history read is guarded here
  // and the failure is NAMED on the result rather than flattened into
  // "no samples ever recorded".
  let samples: TrendPoint[];
  let samplesUnreadable = false;
  try {
    samples = parseSamples(listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE }));
  } catch {
    samples = [];
    samplesUnreadable = true;
  }
  const slope = linearSlope(samples);

  // The freshest trusted reading, and why it might be none.
  let measuredBytes: number | null;
  let unmeasured: ReadonlyArray<StorageUnmeasuredSurface>;
  if (opts.latestUsage !== undefined) {
    measuredBytes = opts.latestUsage.totalBytes;
    unmeasured = opts.latestUsage.unmeasured;
  } else {
    // The stored aggregate stands in only when it is all there is, and
    // a single stored point is never enough to tier on.
    if (samples.length < MIN_TREND_SAMPLES) {
      return {
        tier: STORAGE_FORECAST_TIER.noForecast,
        measuredBytes: null,
        capBytes,
        percentUsed: null,
        slopeBytesPerDay: null,
        daysToCap: null,
        unmeasured: [],
        samplesUnreadable,
      };
    }
    const newest = samples[samples.length - 1]!;
    measuredBytes = newest.bytes;
    unmeasured = [];
  }

  if (unmeasured.length > 0) {
    return {
      tier: STORAGE_FORECAST_TIER.unmeasurable,
      measuredBytes,
      capBytes,
      percentUsed: null,
      slopeBytesPerDay: slope,
      daysToCap: null,
      unmeasured,
      samplesUnreadable,
    };
  }

  const percentUsed = (measuredBytes / capBytes) * 100;
  const daysToCap = slope !== null && slope > 0 ? (capBytes - measuredBytes) / slope : null;

  let tier: StorageForecastTier;
  if (percentUsed >= criticalPercent || (daysToCap !== null && daysToCap <= criticalDays)) {
    tier = STORAGE_FORECAST_TIER.critical;
  } else if (percentUsed >= warnPercent || (daysToCap !== null && daysToCap <= warnDays)) {
    tier = STORAGE_FORECAST_TIER.warn;
  } else {
    tier = STORAGE_FORECAST_TIER.ok;
  }

  return {
    tier,
    measuredBytes,
    capBytes,
    percentUsed,
    slopeBytesPerDay: slope,
    daysToCap,
    unmeasured: [],
    samplesUnreadable,
  };
}

export interface SampleStorageUsageOptions {
  /**
   * The run id the sample is idempotent on: a retry that names the same
   * run id appends nothing. Defaults to a fresh unique id per call.
   */
  readonly runId?: string;
  /** Wall clock for the record's `run_at`; defaults to the current time. */
  readonly now?: Date;
  /**
   * A census already taken this invocation, recorded instead of taking a
   * second one. The capacity gate hands its fresh census here, so a
   * skipped lane run walks the vault once for the decision and no more;
   * absent, the sampler measures as it always did.
   */
  readonly usage?: StorageUsage;
  /** The explicit machine-config file the census resolves the store from. */
  readonly configPath?: string;
}

export interface SampleStorageUsageResult {
  /** The census the sample records. */
  readonly usage: StorageUsage;
  readonly runId: string;
  /** False when the record was already present, or the append failed. */
  readonly appended: boolean;
  /** The named append failure, when `appended` is false for that reason. */
  readonly appendError?: string;
}

/** Mint a unique default run id; samples name no file, so a UUID suffices. */
function mintRunId(): string {
  return crypto.randomUUID();
}

/**
 * Take one usage census and append it to the `storage_usage` metrics
 * surface, one record per run id.
 *
 * Hand `usage` in when this invocation has already measured the vault and
 * the sample should record that census rather than a fresh one.
 *
 * Fail-soft by contract: a vault whose metrics directory cannot be
 * written still gets its census back, with the failure named - the
 * caller decides whether a report without its sample is fatal. Nothing
 * here throws.
 */
export function sampleStorageUsage(
  vault: string,
  opts: SampleStorageUsageOptions = {},
): SampleStorageUsageResult {
  const runId = opts.runId ?? mintRunId();
  const usage =
    opts.usage ??
    measureStorageUsage(vault, {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
    });
  let alreadyRecorded = false;
  try {
    alreadyRecorded = listMetrics(vault, { surface: STORAGE_USAGE_METRIC_SURFACE }).some(
      (record) => record.payload["run_id"] === runId,
    );
  } catch {
    // The history read failed; the append below will fail too if the
    // ledger is truly unwritable, and it names that failure itself.
    alreadyRecorded = false;
  }
  if (alreadyRecorded) {
    return { usage, runId, appended: false };
  }
  try {
    appendMetric(vault, {
      surface: STORAGE_USAGE_METRIC_SURFACE,
      runAt: usage.measuredAt,
      payload: {
        run_id: runId,
        total_bytes: usage.totalBytes,
        bytes_by_tier: usage.bytesByTier,
        measured: usage.complete,
        unmeasured: usage.unmeasured,
      },
    });
    return { usage, runId, appended: true };
  } catch (err) {
    return {
      usage,
      runId,
      appended: false,
      appendError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Convenience re-export so consumers import the meter from one module. */
export { measureStorageUsage };

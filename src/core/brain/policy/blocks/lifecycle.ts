/**
 * The four always-present blocks that drive the preference lifecycle:
 * `dream:`, `retire:`, `confidence:`, `snapshots:`.
 *
 * One reason to change: a lifecycle threshold's accepted range. These are
 * the only blocks that merge field-by-field onto {@link
 * DEFAULT_BRAIN_CONFIG}, so an operator can override one threshold
 * without re-stating the rest, and they always appear in the resolved
 * config rather than being absent-or-present like every optional block.
 */

import type {
  BrainConfidenceConfig,
  BrainDreamConfig,
  BrainRetireConfig,
  BrainSnapshotsConfig,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import {
  requireNonNegativeInteger,
  requirePositiveInteger,
  requireUnitInterval,
} from "../field-checks.ts";
import { mergeBlock, type BlockParseContext } from "../key-index.ts";
import { DEFAULT_BRAIN_CONFIG } from "../defaults.ts";

/**
 * Optional `retire:` sub-key with no default. Declared here because
 * `mergeBlock` derives a block's vocabulary from its default table, and
 * a key whose default is "absent" has no entry there.
 */
const RETIRE_OPTIONAL_KEYS = ["confirmed_evidence_min_threshold"] as const;

/**
 * Merge one lifecycle block onto its slice of {@link DEFAULT_BRAIN_CONFIG}.
 * The cast is the one `mergeBlock` already documents: the merged values
 * are `unknown` until the per-field checks below narrow them, and only
 * the DEFAULTS need to be a flat numeric table.
 */
function merge(
  ctx: BlockParseContext,
  blockKey: string,
  fallback: object,
  optionalKeys?: ReadonlyArray<string>,
): Record<string, unknown> {
  return mergeBlock(
    blockKey,
    ctx.obj[blockKey],
    fallback as Readonly<Record<string, number>>,
    ctx.source,
    ctx.keys,
    optionalKeys,
  );
}

export function parseDreamBlock(ctx: BlockParseContext): BrainDreamConfig {
  const dream = merge(ctx, "dream", DEFAULT_BRAIN_CONFIG.dream);
  requirePositiveInteger("dream.candidate_threshold", dream.candidate_threshold, ctx.source);
  requirePositiveInteger(
    "dream.unconfirmed_window_days",
    dream.unconfirmed_window_days,
    ctx.source,
  );
  requirePositiveInteger(
    "dream.contradiction_window_days",
    dream.contradiction_window_days,
    ctx.source,
  );
  return {
    candidate_threshold: dream.candidate_threshold as number,
    unconfirmed_window_days: dream.unconfirmed_window_days as number,
    contradiction_window_days: dream.contradiction_window_days as number,
    // Brain lifecycle suite F6: opt-in heal-phase enrichment. Absent
    // or non-boolean coerces to false so the default install stays
    // byte-identical (the heal phase becomes a checkpoint-only no-op).
    heal_enrich_enabled: dream.heal_enrich_enabled === true,
  };
}

export function parseRetireBlock(ctx: BlockParseContext): BrainRetireConfig {
  const retire = merge(ctx, "retire", DEFAULT_BRAIN_CONFIG.retire, RETIRE_OPTIONAL_KEYS);
  requirePositiveInteger("retire.stale_evidence_days", retire.stale_evidence_days, ctx.source);
  // Optional destructive-from-confirmed gate (v0.12.0). An out-of-range
  // value is a hard error rather than a silently ignored knob.
  if (retire.confirmed_evidence_min_threshold !== undefined) {
    requirePositiveInteger(
      "retire.confirmed_evidence_min_threshold",
      retire.confirmed_evidence_min_threshold,
      ctx.source,
    );
  }
  return {
    stale_evidence_days: retire.stale_evidence_days as number,
    // Absent stays absent: `undefined` is the documented "gate off"
    // state the dream pass branches on, so spreading the key in
    // unconditionally would change `retire` from omitting it to
    // carrying an explicit undefined.
    ...(retire.confirmed_evidence_min_threshold !== undefined
      ? { confirmed_evidence_min_threshold: retire.confirmed_evidence_min_threshold as number }
      : {}),
  };
}

export function parseConfidenceBlock(ctx: BlockParseContext): BrainConfidenceConfig {
  const confidence = merge(ctx, "confidence", DEFAULT_BRAIN_CONFIG.confidence);
  requireNonNegativeInteger("confidence.low_max_applied", confidence.low_max_applied, ctx.source);
  requireUnitInterval("confidence.medium_min", confidence.medium_min, ctx.source);
  requireUnitInterval("confidence.high_min", confidence.high_min, ctx.source);
  if ((confidence.medium_min as number) >= (confidence.high_min as number)) {
    throw new BrainConfigError(
      `medium_min must be strictly less than high_min; got ` +
        `medium_min=${confidence.medium_min}, high_min=${confidence.high_min}`,
      "confidence.medium_min",
      ctx.source,
    );
  }
  return {
    low_max_applied: confidence.low_max_applied as number,
    medium_min: confidence.medium_min as number,
    high_min: confidence.high_min as number,
  };
}

export function parseSnapshotsBlock(ctx: BlockParseContext): BrainSnapshotsConfig {
  const snapshots = merge(ctx, "snapshots", DEFAULT_BRAIN_CONFIG.snapshots);
  requirePositiveInteger("snapshots.retention_count", snapshots.retention_count, ctx.source);
  requirePositiveInteger(
    "snapshots.derived_store_max_bytes",
    snapshots.derived_store_max_bytes,
    ctx.source,
  );
  return {
    retention_count: snapshots.retention_count as number,
    // Derived-store coverage is opt-in, so anything that is not
    // literally `true` leaves it off. Same rule as
    // `dream.heal_enrich_enabled`: a typo in a switch that costs disk on
    // every replicated peer must fail closed, not open.
    include_derived_store: snapshots.include_derived_store === true,
    derived_store_max_bytes: snapshots.derived_store_max_bytes as number,
  };
}

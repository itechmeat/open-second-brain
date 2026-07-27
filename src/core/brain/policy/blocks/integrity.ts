/**
 * The `integrity:` block — the context-integrity gates and the pack
 * staleness window.
 *
 * One reason to change: which integrity gates exist and how a vault that
 * declares them is read. This module also owns the STRICT fallback, which
 * is deliberately not the default table: see
 * {@link BRAIN_INTEGRITY_STRICT_FALLBACK}.
 */

import type {
  BrainConfig,
  BrainIntegrityConfig,
  ResolvedBrainIntegrityConfig,
} from "../../types.ts";
import { BrainConfigError } from "../errors.ts";
import { describe, requirePositiveInteger } from "../field-checks.ts";
import { openBlock, warnUnknownKeys, type BlockParseContext } from "../key-index.ts";
import { GATE_MODE, GATE_MODES, isGateMode } from "../../../integrity/stamp.ts";

const BLOCK = "integrity";

/**
 * Sub-keys of the `integrity:` block whose value is a gate mode. Named
 * once and reused by the validator, the unknown-key list, and the
 * resolver so the three can never disagree about what the block holds.
 */
const INTEGRITY_GATE_KEYS = ["owner_scope_delivery", "embedding_abi"] as const;

/**
 * How long a context pack stays servable after it was built, when
 * `_brain.yaml` omits `integrity.pack_validity_seconds`.
 *
 * 900 seconds (15 minutes) is the same bound `CRUTCH_LINK_WINDOW_MS`
 * already uses for "still the same working session", so the pack's outer
 * staleness bound and the session-continuity bound agree on what a
 * session is rather than inventing a second, conflicting answer.
 *
 * It is deliberately much longer than the anticipatory cache's 120 s TTL:
 * the provenance stamp is the PRIMARY invalidator (it observes the vault
 * edits that matter), and this window is the backstop for the changes a
 * stamp cannot observe. A short window here would duplicate the TTL and
 * mask which mechanism actually did the invalidating.
 *
 * The value is unbounded above on purpose - unlike the instruction-file
 * ceiling, a large window does not silently disable anything, because
 * the stamp still refuses a drifted pack.
 */
export const PACK_VALIDITY_SECONDS_DEFAULT = 900;

/**
 * Default `integrity:` block (context-integrity-gates). Absent block (or
 * absent individual keys) falls back here via `resolveIntegrity`.
 *
 * Both gate defaults are the modes that leave every existing vault
 * byte-identical:
 *   - `owner_scope_delivery: off` - the delivery path documents a "null
 *     scope is byte-identical" contract throughout, so defaulting a
 *     scope would silently narrow vaults that never opted in. There is
 *     no writer surface for `owner` yet, so nothing would be gained.
 *   - `embedding_abi: warn` - `vec_version()` is not stable across
 *     environments, so two peers on different sqlite-vec builds would
 *     each see a mismatch. Refusing by default risks a rebuild loop on a
 *     synced vault; reporting cannot.
 */
export const BRAIN_INTEGRITY_DEFAULTS: ResolvedBrainIntegrityConfig = Object.freeze({
  owner_scope_delivery: GATE_MODE.off,
  embedding_abi: GATE_MODE.warn,
  pack_validity_seconds: PACK_VALIDITY_SECONDS_DEFAULT,
}) as ResolvedBrainIntegrityConfig;

/**
 * Gate modes used when `_brain.yaml` EXISTS but cannot be read.
 *
 * Not the defaults: the defaults encode "this operator has said nothing",
 * and an unreadable file is the opposite - the operator said something
 * and we cannot tell what. Collapsing that to the defaults turns
 * `owner_scope_delivery: fail` into `off`, which disables an isolation
 * boundary because of a typo somewhere else in the file, with no signal
 * on any surface. Erring to the strictest mode makes the same typo loud
 * and reversible instead of quiet and permanent.
 *
 * `pack_validity_seconds` is not a gate and has no strict direction, so
 * it keeps the default window.
 */
export const BRAIN_INTEGRITY_STRICT_FALLBACK: ResolvedBrainIntegrityConfig = Object.freeze({
  owner_scope_delivery: GATE_MODE.fail,
  embedding_abi: GATE_MODE.fail,
  pack_validity_seconds: PACK_VALIDITY_SECONDS_DEFAULT,
}) as ResolvedBrainIntegrityConfig;

/**
 * Merge a parsed `integrity` block (or `undefined`) with
 * `BRAIN_INTEGRITY_DEFAULTS`. Resolution happens on the READ side, not
 * at parse time, so `cfg.integrity` keeps recording exactly what the
 * operator wrote and "absent" stays distinguishable from "explicitly set
 * to the default".
 */
export function resolveIntegrity(cfg: BrainConfig): ResolvedBrainIntegrityConfig {
  const it = cfg.integrity;
  if (it === undefined) return BRAIN_INTEGRITY_DEFAULTS;
  return {
    owner_scope_delivery: it.owner_scope_delivery ?? BRAIN_INTEGRITY_DEFAULTS.owner_scope_delivery,
    embedding_abi: it.embedding_abi ?? BRAIN_INTEGRITY_DEFAULTS.embedding_abi,
    pack_validity_seconds:
      it.pack_validity_seconds ?? BRAIN_INTEGRITY_DEFAULTS.pack_validity_seconds,
  };
}

/**
 * Shape:
 *   integrity:
 *     owner_scope_delivery: off | warn | fail   # default off
 *     embedding_abi: off | warn | fail          # default warn
 *     pack_validity_seconds: 900                # positive integer
 *
 * Every value is a hard error when out of range. A gate that clamped an
 * unrecognised mode to `off`, or a validity window that silently reverted
 * to the default, would be indistinguishable from the operator's intent -
 * which is the exact class of silent degradation this block exists to
 * gate.
 */
export function parseIntegrityBlock(ctx: BlockParseContext): BrainIntegrityConfig | undefined {
  const itObj = openBlock(ctx, BLOCK);
  if (itObj === undefined) return undefined;

  const partial: Record<string, unknown> = {};
  for (const key of INTEGRITY_GATE_KEYS) {
    if (!(key in itObj)) continue;
    const v = itObj[key];
    if (!isGateMode(v)) {
      throw new BrainConfigError(
        `must be one of ${GATE_MODES.join(", ")}; got ${describe(v)}`,
        `integrity.${key}`,
        ctx.source,
      );
    }
    partial[key] = v;
  }
  if ("pack_validity_seconds" in itObj) {
    requirePositiveInteger(
      "integrity.pack_validity_seconds",
      itObj["pack_validity_seconds"],
      ctx.source,
    );
    partial["pack_validity_seconds"] = itObj["pack_validity_seconds"] as number;
  }
  warnUnknownKeys(ctx, itObj, [...INTEGRITY_GATE_KEYS, "pack_validity_seconds"], BLOCK);
  return partial as BrainIntegrityConfig;
}

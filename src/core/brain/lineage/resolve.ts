/**
 * Session-lineage resolution (continuity-hygiene-freshness suite).
 *
 * Single resolution point for "which conversation does this session id
 * belong to". Precedence: native payload fields, then the interim
 * ledger crutch, then flat. See `types.ts` for the contract and
 * `crutch.ts` for the conservative inference rules.
 *
 * Two entry points, following the sibling pattern this repository uses
 * wherever a diagnostic channel is grafted onto an established
 * signature: {@link resolveSessionLineageDetailed} carries the crutch's
 * named outcome, and {@link resolveSessionLineage} delegates to it and
 * discards everything but the lineage, so every pre-existing caller
 * stays byte-identical.
 */

import { CRUTCH_ABSTENTION, type CrutchOutcome, resolveCrutchLineage } from "./crutch.ts";
import type { LineageLedgerState } from "./ledger.ts";
import type { LineageHints, SessionLineage } from "./types.ts";
import {
  DEGRADATION_CODE,
  type DegradationNotice,
  emitDegradationNotice,
} from "../../integrity/degradation.ts";

export interface ResolveLineageOptions {
  /** Ledger state for the crutch path; omit to disable the crutch. */
  readonly ledger?: LineageLedgerState;
  /**
   * Sessions the ledger's gap sidecar records as dropped
   * (`lineageGapSessionIds`). Threaded straight into the crutch, where
   * it completes Rule 1: a session whose observation the writer lock
   * refused still has history, and without this it would be stitched
   * onto an unrelated parallel session.
   */
  readonly gapSessionIds?: ReadonlySet<string>;
  /** Clock injected by the caller (epoch ms). Required for the crutch. */
  readonly nowMs?: number;
  /**
   * Opt-in sink for degradation notices (context-integrity-gates).
   * Absent means no diagnostics are produced at all, which is why
   * adding the channel changed no existing caller.
   */
  readonly notices?: DegradationNotice[];
}

/** Lineage plus the evidence behind it. */
export interface SessionLineageResolution {
  readonly lineage: SessionLineage;
  /**
   * The crutch's named outcome, present only when the crutch actually
   * ran (a ledger was supplied and the native payload did not already
   * decide). A `linked` outcome IS the lineage; an `abstained` one is
   * why continuation was refused.
   */
  readonly crutch?: CrutchOutcome;
}

/** Site recorded on the notices this module emits. */
const RESOLVE_SITE = "brain.lineage.resolve";

/**
 * Abstentions worth reporting. `no-candidate`, `self-known` and
 * `no-workspace` are the ORDINARY flat path - a first session, a
 * parallel session, a host that reports no directory - and emitting a
 * notice for them would bury the three that mean a continuation was
 * available and refused.
 */
const REPORTABLE_ABSTENTIONS: ReadonlySet<string> = new Set([
  CRUTCH_ABSTENTION.ambiguous,
  CRUTCH_ABSTENTION.stale,
  CRUTCH_ABSTENTION.evidenceMissing,
]);

function readId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const FLAT_SOURCE = "flat";

/** Resolve the lineage of one session id. Never throws. */
export function resolveSessionLineage(
  hints: LineageHints,
  opts: ResolveLineageOptions = {},
): SessionLineage {
  return resolveSessionLineageDetailed(hints, opts).lineage;
}

/**
 * Resolve the lineage of one session id AND report how it was decided.
 * Never throws: a refusal is a returned value, because this runs inside
 * capture paths that are fail-soft by contract.
 */
export function resolveSessionLineageDetailed(
  hints: LineageHints,
  opts: ResolveLineageOptions = {},
): SessionLineageResolution {
  const sessionId = hints.sessionId;

  // Native path: any genuine lineage field on the payload wins. A
  // parent or root equal to the session itself carries no information
  // (the deployed Hermes collapses parent into session_id exactly this
  // way) and is ignored.
  const parentRaw = readId(hints.parentSessionId);
  const rootRaw = readId(hints.rootSessionId);
  const parentId = parentRaw !== null && parentRaw !== sessionId ? parentRaw : null;
  const rootFromPayload = rootRaw !== null && rootRaw !== sessionId ? rootRaw : null;
  if (parentId !== null || rootFromPayload !== null) {
    // A payload that names only its direct parent must not promote
    // that parent to root blindly - in a chain A -> B -> C the parent
    // B itself descends from A. When the ledger knows the parent's own
    // lineage, inherit its root (and continue its depth count).
    const parentLineage = parentId !== null ? opts.ledger?.get(parentId)?.lineage : undefined;
    const inheritedRoot =
      parentLineage !== undefined && parentLineage.source !== FLAT_SOURCE
        ? parentLineage.rootId
        : null;
    const depthRaw = hints.compressionDepth;
    const depth =
      typeof depthRaw === "number" && Number.isInteger(depthRaw) && depthRaw >= 0
        ? depthRaw
        : parentId !== null
          ? (parentLineage !== undefined && parentLineage.source !== FLAT_SOURCE
              ? parentLineage.depth
              : 0) + 1
          : 0;
    return {
      lineage: Object.freeze({
        rootId: rootFromPayload ?? inheritedRoot ?? parentId ?? sessionId,
        parentId,
        depth,
        source: "payload" as const,
      }),
    };
  }

  // Interim inference for hosts without native lineage fields.
  // CRUTCH(t_1459706f).
  if (opts.ledger !== undefined) {
    const outcome = resolveCrutchLineage({
      sessionId,
      ...(hints.cwd !== undefined ? { cwd: hints.cwd } : {}),
      ledger: opts.ledger,
      nowMs: opts.nowMs ?? 0,
      ...(hints.workspace !== undefined ? { workspace: hints.workspace } : {}),
      ...(opts.gapSessionIds !== undefined ? { gapSessionIds: opts.gapSessionIds } : {}),
    });
    if (outcome.kind === "linked") {
      return { lineage: outcome.lineage, crutch: outcome };
    }
    if (opts.notices !== undefined && REPORTABLE_ABSTENTIONS.has(outcome.reason)) {
      emitDegradationNotice(opts.notices, {
        code: DEGRADATION_CODE.sessionLinkAbstained,
        site: RESOLVE_SITE,
        detail: `${outcome.reason}: ${outcome.detail} (session ${sessionId})`,
      });
    }
    return { lineage: flat(sessionId), crutch: outcome };
  }

  return { lineage: flat(sessionId) };
}

function flat(sessionId: string): SessionLineage {
  return Object.freeze({
    rootId: sessionId,
    parentId: null,
    depth: 0,
    source: FLAT_SOURCE,
  });
}

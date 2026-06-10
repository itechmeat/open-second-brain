/**
 * Session-lineage resolution (continuity-hygiene-freshness suite).
 *
 * Single resolution point for "which conversation does this session id
 * belong to". Precedence: native payload fields, then the interim
 * ledger crutch, then flat. See `types.ts` for the contract and
 * `crutch.ts` for the conservative inference rules.
 */

import { resolveCrutchLineage } from "./crutch.ts";
import type { LineageLedgerState } from "./ledger.ts";
import type { LineageHints, SessionLineage } from "./types.ts";

export interface ResolveLineageOptions {
  /** Ledger state for the crutch path; omit to disable the crutch. */
  readonly ledger?: LineageLedgerState;
  /** Clock injected by the caller (epoch ms). Required for the crutch. */
  readonly nowMs?: number;
}

function readId(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Resolve the lineage of one session id. Never throws. */
export function resolveSessionLineage(
  hints: LineageHints,
  opts: ResolveLineageOptions = {},
): SessionLineage {
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
    const depthRaw = hints.compressionDepth;
    const depth =
      typeof depthRaw === "number" && Number.isInteger(depthRaw) && depthRaw >= 0
        ? depthRaw
        : parentId !== null
          ? 1
          : 0;
    return Object.freeze({
      rootId: rootFromPayload ?? parentId ?? sessionId,
      parentId,
      depth,
      source: "payload" as const,
    });
  }

  // Interim inference for hosts without native lineage fields.
  // CRUTCH(t_1459706f).
  if (opts.ledger !== undefined) {
    const inferred = resolveCrutchLineage(sessionId, hints.cwd, opts.ledger, opts.nowMs ?? 0);
    if (inferred !== null) return inferred;
  }

  return Object.freeze({ rootId: sessionId, parentId: null, depth: 0, source: "flat" as const });
}

/**
 * Session-end observed-use verdict per injected memory (Retrieval &
 * Ranking Quality, t_65588d8b).
 *
 * At session end each memory that was injected this session is classified
 * as USED / IGNORED / CONTRADICTED, persisted as a `recall_observed_use`
 * continuity record, and folded into an observed-reuse rate per artifact
 * that recall ranking prefers over predicted importance.
 *
 * NO-LLM KERNEL INVARIANT. The kernel never calls a model to read the
 * transcript. A verdict is either:
 *   - computed DETERMINISTICALLY here ({@link classifyObservedUse}) by
 *     matching an injected memory's distinctive tokens against later
 *     transcript turns, with CONTRADICTED derived from a structural stance
 *     flip via the shared `deriveNoteStance` primitive (no vocabulary), or
 *   - supplied ALREADY-STRUCTURED by the host via the MCP write tool,
 *     mirroring `brain_apply_evidence`.
 * The kernel only stores and aggregates.
 */

import { appendContinuityRecord, listContinuityRecords } from "./continuity/store.ts";
import type { ContinuityRecord } from "./continuity/types.ts";
import { DEFAULT_NEGATION_MARKERS, deriveNoteStance } from "./health/contradiction.ts";

export const OBSERVED_USE_VERDICTS = ["USED", "IGNORED", "CONTRADICTED"] as const;
export type ObservedUseVerdict = (typeof OBSERVED_USE_VERDICTS)[number];

export function isObservedUseVerdict(value: unknown): value is ObservedUseVerdict {
  return value === "USED" || value === "IGNORED" || value === "CONTRADICTED";
}

/** One injected memory's observed-use verdict. */
export interface ObservedUseEntry {
  /** Stable memory id (e.g. "docId:chunkId" or a note id). */
  readonly id: string;
  /** Vault-relative path, when known (the ranking join key prefers it). */
  readonly path?: string;
  readonly verdict: ObservedUseVerdict;
}

export interface ObservedUseInput {
  readonly createdAt?: string;
  readonly host: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly entries: ReadonlyArray<ObservedUseEntry>;
}

/** An injected memory to classify against the transcript. */
export interface InjectedMemory {
  readonly id: string;
  readonly path?: string;
  readonly content: string;
}

const TOKEN_RE = /[\p{L}\p{N}]{2,}/gu;
const MIN_SHARED_TOKENS = 2;

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(TOKEN_RE)) out.add(m[0]);
  return out;
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) n++;
  return n;
}

/**
 * Deterministically classify each injected memory against the session
 * transcript turns. A memory is USED when a later turn echoes at least
 * {@link MIN_SHARED_TOKENS} of its distinctive tokens; CONTRADICTED when
 * such an overlapping turn takes the opposite structural stance (a
 * `deriveNoteStance` sign flip); IGNORED otherwise. No model, no
 * per-language vocabulary beyond the shared structural negation markers.
 */
export function classifyObservedUse(
  injected: ReadonlyArray<InjectedMemory>,
  transcriptTurns: ReadonlyArray<string>,
): ObservedUseEntry[] {
  const turns = transcriptTurns.map((t) => tokenSet(t));
  return injected.map((mem) => {
    const memTokens = tokenSet(mem.content);
    const memStance = deriveNoteStance(memTokens, DEFAULT_NEGATION_MARKERS);
    let verdict: ObservedUseVerdict = "IGNORED";
    for (const turn of turns) {
      if (sharedCount(memTokens, turn) < MIN_SHARED_TOKENS) continue;
      const turnStance = deriveNoteStance(turn, DEFAULT_NEGATION_MARKERS);
      if (turnStance !== memStance) {
        verdict = "CONTRADICTED";
        break; // a contradiction outranks a plain reuse.
      }
      verdict = "USED";
    }
    return {
      id: mem.id,
      ...(mem.path ? { path: mem.path } : {}),
      verdict,
    };
  });
}

/**
 * Persist a session's observed-use verdicts as one continuity record.
 * `sourceRefs` point at the injected artifacts so a fold can join by id or
 * path. Returns the appended record.
 */
export function emitObservedUse(vault: string, input: ObservedUseInput): ContinuityRecord {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const entries = [...input.entries];
  return appendContinuityRecord(vault, {
    kind: "recall_observed_use",
    createdAt,
    sourceRefs: entries.map((e) => ({ id: e.id, ...(e.path ? { path: e.path } : {}) })),
    payload: {
      host: input.host,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.turnId ? { turn_id: input.turnId } : {}),
      entries: entries.map((e) => ({
        id: e.id,
        ...(e.path ? { path: e.path } : {}),
        verdict: e.verdict,
      })),
    },
  });
}

/** Aggregated observed-use for one artifact. */
export interface ObservedReuse {
  readonly used: number;
  readonly ignored: number;
  readonly contradicted: number;
  readonly total: number;
  /**
   * Ranking signal in [0, 1]: `(used - contradicted) / total`, clamped.
   * Contradictions demote; a purely-ignored memory scores 0.
   */
  readonly score: number;
}

/**
 * Fold every `recall_observed_use` record into a per-artifact reuse map,
 * keyed by `path` when present else `id`. Order-insensitive.
 */
export function observedReuseRates(vault: string): Map<string, ObservedReuse> {
  const acc = new Map<string, { used: number; ignored: number; contradicted: number }>();
  for (const record of listContinuityRecords(vault, { kind: "recall_observed_use" })) {
    const entries = record.payload["entries"];
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const verdict = e["verdict"];
      if (!isObservedUseVerdict(verdict)) continue;
      const key =
        typeof e["path"] === "string" && e["path"] !== ""
          ? (e["path"] as string)
          : typeof e["id"] === "string"
            ? (e["id"] as string)
            : null;
      if (key === null) continue;
      const cur = acc.get(key) ?? { used: 0, ignored: 0, contradicted: 0 };
      if (verdict === "USED") cur.used++;
      else if (verdict === "IGNORED") cur.ignored++;
      else cur.contradicted++;
      acc.set(key, cur);
    }
  }
  const out = new Map<string, ObservedReuse>();
  for (const [key, c] of acc) {
    const total = c.used + c.ignored + c.contradicted;
    const score = total > 0 ? Math.max(0, Math.min(1, (c.used - c.contradicted) / total)) : 0;
    out.set(key, { used: c.used, ignored: c.ignored, contradicted: c.contradicted, total, score });
  }
  return out;
}

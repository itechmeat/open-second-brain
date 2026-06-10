/**
 * Session-lineage kernel types (continuity-hygiene-freshness suite;
 * kanban t_d08ccc5a / t_a94623ad).
 *
 * One logical conversation can span several runtime session ids when
 * the host compresses context and rotates the id. The kernel resolves
 * every session id to a lineage: the root id of the conversation, the
 * immediate parent segment, and how many compression boundaries deep
 * the segment sits. Three sources, in strict precedence order:
 *
 *   - `payload`: the hook payload carried native lineage fields
 *     (`parent_session_id` et al. - upstream Hermes PR #42940).
 *   - `crutch`: the interim ledger-based inference for hosts that do
 *     not emit lineage yet. See `crutch.ts`, CRUTCH(t_1459706f).
 *   - `flat`: no lineage known; the session is its own root. This is
 *     byte-identical to the pre-lineage behavior and the fallback for
 *     every ambiguous case.
 */

export type SessionLineageSource = "payload" | "crutch" | "flat";

export interface SessionLineage {
  /** Root session id of the whole conversation (self when flat). */
  readonly rootId: string;
  /** Immediate predecessor segment, `null` for a root segment. */
  readonly parentId: string | null;
  /** Compression boundaries between this segment and the root. */
  readonly depth: number;
  readonly source: SessionLineageSource;
}

/**
 * Lineage-relevant fields extracted from a hook payload. All optional
 * except the session id; absent fields simply lower the resolution
 * source down the precedence ladder.
 */
export interface LineageHints {
  readonly sessionId: string;
  readonly parentSessionId?: string | null;
  readonly rootSessionId?: string | null;
  readonly compressionDepth?: number | null;
  /** Working directory the host reported for the session, if any. */
  readonly cwd?: string;
}

/**
 * True when a lifecycle event signals that a compression boundary was
 * just crossed. Structural check only: event names and the
 * SessionStart `source` discriminator, never message text.
 */
export function isCompressionEvidenceEvent(event: string, sessionStartSource?: string): boolean {
  if (event === "PostCompact" || event === "PreCompact") return true;
  return event === "SessionStart" && sessionStartSource === "compact";
}

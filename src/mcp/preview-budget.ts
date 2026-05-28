/**
 * MCP tool-result preview budget (v0.18.0).
 *
 * The single decision the seam makes: given the serialized text a tool
 * would otherwise return inline, and that tool's optional character
 * budget, either pass the text through unchanged or park the full
 * payload in the artifact store and return a small, valid-JSON preview
 * envelope in its place.
 *
 * Kept free of MCP-envelope and server concerns so it is trivially
 * unit-testable: it takes the serialized string, the budget, and a
 * `put`-only view of the artifact store.
 */

import type { StoredArtifact } from "./artifact-store.ts";

/**
 * Shared default preview budget in characters (v0.18.0). Roughly ~500
 * tokens of inline preview - enough to judge a result set, small enough
 * that a dense vault's full payload never silently floods the context.
 * Tools opt in by setting `previewBudget` to this constant.
 */
export const MCP_PREVIEW_BUDGET = 2000;

/** Envelope substituted for an over-budget tool result in `content[0].text`. */
export interface PreviewEnvelope {
  readonly preview_truncated: true;
  readonly artifact_id: string;
  readonly full_chars: number;
  readonly bytes_preview: string;
  readonly note: string;
}

export interface BudgetOutcome {
  /** Text to place in `content[0].text`. */
  readonly text: string;
  /** Whether the payload was parked in an artifact. */
  readonly truncated: boolean;
  /** Artifact id when truncated, else null. */
  readonly artifactId: string | null;
}

/** A `put`-only view of the artifact store - all the budget seam needs. */
export interface ArtifactSink {
  put(fullText: string): StoredArtifact;
}

/**
 * Single English, language-agnostic instruction folded into every
 * preview envelope. Built from a fixed template, never from a per-locale
 * phrase table.
 */
function previewNote(artifactId: string): string {
  return (
    `Result truncated to protect context. This is a head preview only; ` +
    `call brain_artifact_get with artifact_id "${artifactId}" for the full payload.`
  );
}

export function applyPreviewBudget(
  serialized: string,
  budget: number | undefined,
  store: ArtifactSink,
): BudgetOutcome {
  if (budget === undefined || serialized.length <= budget) {
    return { text: serialized, truncated: false, artifactId: null };
  }

  const stored = store.put(serialized);
  const envelope: PreviewEnvelope = {
    preview_truncated: true,
    artifact_id: stored.artifactId,
    full_chars: stored.fullChars,
    bytes_preview: stored.text.slice(0, budget),
    note: previewNote(stored.artifactId),
  };
  return {
    text: JSON.stringify(envelope, null, 2),
    truncated: true,
    artifactId: stored.artifactId,
  };
}

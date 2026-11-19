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

import { MigrationInProgressError } from "../core/migration-gate.ts";
import { redactRawOutput } from "../core/redactor.ts";
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

/**
 * The envelope of an over-budget result while a store migration of the
 * vault holds this machine's gate: the full payload cannot be parked (the
 * artifact store lives in the tree being moved), so there is no artifact id
 * and the note says when the full result can be had again.
 */
export interface UnparkedPreviewEnvelope {
  readonly preview_truncated: true;
  readonly artifact_id: null;
  readonly full_chars: number;
  readonly bytes_preview: string;
  readonly note: string;
}

function migrationPreview(
  serialized: string,
  budget: number,
  error: MigrationInProgressError,
  forCaller: (text: string) => string,
): BudgetOutcome {
  const envelope: UnparkedPreviewEnvelope = {
    preview_truncated: true,
    artifact_id: null,
    full_chars: serialized.length,
    // Redacted as the artifact store redacts what it parks, so this preview
    // shows what the normal over-budget preview would.
    bytes_preview: redactRawOutput(serialized, {
      maxInput: Number.POSITIVE_INFINITY,
      redactInfra: true,
    }).slice(0, budget),
    note:
      "Result truncated to protect context. The full payload could not be stored: " +
      // The refusal may name a host path (a damaged gate's file): put
      // through the caller's path redaction, which ran on the result before
      // this note existed.
      `${forCaller(error.message)}. Call the tool again then for the full result.`,
  };
  return { text: JSON.stringify(envelope, null, 2), truncated: true, artifactId: null };
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
  forCaller: (text: string) => string = (text) => text,
): BudgetOutcome {
  // No budget, or an explicitly unbounded one, means never truncate.
  if (budget === undefined || budget === Number.POSITIVE_INFINITY) {
    return { text: serialized, truncated: false, artifactId: null };
  }
  // Normalize before comparing/slicing: a negative or non-finite budget
  // would otherwise make `slice` leak nearly the whole payload (slice(0, -1))
  // and defeat the context-protection goal. Clamp to a finite int >= 0.
  const safeBudget = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  if (serialized.length <= safeBudget) {
    return { text: serialized, truncated: false, artifactId: null };
  }

  let stored: StoredArtifact;
  try {
    stored = store.put(serialized);
  } catch (error) {
    if (!(error instanceof MigrationInProgressError)) throw error;
    // No artifact can be parked while a store migration of the vault holds
    // the gate: the preview is still cut to the budget, and says why the
    // rest cannot be fetched now.
    return migrationPreview(serialized, safeBudget, error, forCaller);
  }
  const envelope: PreviewEnvelope = {
    preview_truncated: true,
    artifact_id: stored.artifactId,
    full_chars: stored.fullChars,
    bytes_preview: stored.text.slice(0, safeBudget),
    note: previewNote(stored.artifactId),
  };
  return {
    text: JSON.stringify(envelope, null, 2),
    truncated: true,
    artifactId: stored.artifactId,
  };
}

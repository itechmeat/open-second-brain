/**
 * `o2b search status` — what the on-disk index currently holds, and the
 * indexer named as the exit when there is no index at all.
 */

import { indexStatus, serializeIndexStatus } from "../../../core/search/index.ts";
import type { IndexStatusSnapshot } from "../../../core/search/index.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import {
  flagBoolean,
  parseFlags,
  resolveConfig,
  searchAdvisoryStream,
  VAULT_FLAGS,
} from "../helpers.ts";

export async function cmdSearchStatus(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const status = await indexStatus(cfg);
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        ...(serializeIndexStatus(status) as Record<string, unknown>),
        // Same polarity as the human twin below, so the two conditions
        // read as one rule rather than as each other's negation.
        ...(!status.exists ? nextCommandField("search-index-missing") : {}),
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(renderStatusHuman(status));
  // no-dead-ends, phase 3: the pointer used to be spliced into the
  // renderer's first line, which is a second emission mechanism AND
  // beyond the reach of a scan over writer call sites. The rail decides
  // the format; the condition is the one the claim rests on.
  if (!status.exists) {
    // The `--json` branch above returned, so this stream is provably a
    // human one; the JSON payload carries the same exit as a field.
    emitNextStep("search-index-missing", searchAdvisoryStream(argv, false));
  }
  return 0;
}

function renderStatusHuman(s: IndexStatusSnapshot): string {
  if (!s.exists) {
    return `index: not initialised\n  path: ${s.indexPath}\n`;
  }
  const lines: string[] = [];
  lines.push(`index: ${s.indexPath}`);
  lines.push(`schema_version: ${s.schemaVersion}`);
  lines.push(`documents:  ${s.documents}`);
  lines.push(`chunks:     ${s.chunks}`);
  lines.push(`embeddings: ${s.embeddings} (stale: ${s.staleEmbeddings})`);
  lines.push(`embedding_model:     ${s.embeddingModel ?? "(none)"}`);
  lines.push(`embedding_dimension: ${s.embeddingDimension ?? "(none)"}`);
  lines.push(`embedding_signature: ${s.embeddingSignature ?? "(disabled)"}`);
  if (s.estimatedRefreshCostUsd > 0) {
    lines.push(`refresh_cost_est:    $${s.estimatedRefreshCostUsd.toFixed(4)}`);
  }
  lines.push(`vec_extension:       ${s.vecExtension}`);
  lines.push(`semantic_enabled:    ${s.semanticEnabled}`);
  lines.push(`embedding_key:       ${s.embeddingKeyPresent ? "present" : "missing"}`);
  lines.push(`last_indexed_at:     ${s.lastIndexedAt ?? "(never)"}`);
  lines.push(`last_full_index_at:  ${s.lastFullIndexAt ?? "(never)"}`);
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n") + "\n";
}

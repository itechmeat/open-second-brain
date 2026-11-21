/**
 * `o2b search status` — what the on-disk index currently holds, and the
 * indexer named as the exit when there is no index at all.
 */

import { formatEstimatedUsd } from "../../../core/search/embedding-spend.ts";
import {
  freshenStatus,
  renderFreshenStatus,
  serializeFreshenStatus,
  type FreshenStatus,
} from "../../../core/search/freshen.ts";
import {
  eventTimeStatus,
  indexBehindCount,
  indexStatus,
  renderEventTimeStatus,
  serializeEventTimeStatus,
  serializeIndexStatus,
} from "../../../core/search/index.ts";
import type { EventTimeStatus, IndexStatusSnapshot } from "../../../core/search/index.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import {
  describeIndexEstimate,
  estimateIndexBuild,
  formatEstimateBytes,
  readIndexCensus,
  type IndexCensus,
} from "../../../core/search/index-estimate.ts";
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
  // The event-time summary reads the index, so it exists only with one.
  const eventTime = status.exists ? await eventTimeStatus(cfg) : null;
  // The live behind walk (t_e4438152): only with an index to diff
  // against, best-effort null on failure - the freshen block then reads
  // "(not measured)", never a fabricated zero.
  const behind = status.exists ? await indexBehindCount(cfg) : null;
  const freshen = status.exists
    ? freshenStatus(cfg, status.lastIndexedAt, undefined, behind?.behind ?? null)
    : null;
  // The size on disk and what a rebuild of it is expected to take.
  const census = status.exists ? readIndexCensus(cfg.dbPath) : null;
  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify({
        ...(serializeIndexStatus(status) as Record<string, unknown>),
        ...(eventTime !== null ? { event_time: serializeEventTimeStatus(eventTime) } : {}),
        ...(freshen !== null ? { freshen: serializeFreshenStatus(freshen) } : {}),
        ...(census !== null ? censusJson(census) : {}),
        // Same polarity as the human twin below, so the two conditions
        // read as one rule rather than as each other's negation.
        ...(!status.exists ? nextCommandField("search-index-missing") : {}),
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(renderStatusHuman(status, eventTime, freshen, census));
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

/** The JSON twin of the size and rebuild lines. */
function censusJson(census: IndexCensus): Record<string, unknown> {
  const estimate = estimateIndexBuild(census);
  return {
    size_on_disk_bytes: census.sizeOnDiskBytes,
    rebuild_estimate: {
      bytes: estimate.bytes,
      seconds: estimate.seconds,
      store_records: census.storeRecords,
      documents: census.documents,
      note_files: census.noteFiles,
    },
  };
}

function renderStatusHuman(
  s: IndexStatusSnapshot,
  eventTime: EventTimeStatus | null,
  freshen: FreshenStatus | null,
  census: IndexCensus | null,
): string {
  if (!s.exists) {
    return `index: not initialised\n  path: ${s.indexPath}\n`;
  }
  const lines: string[] = [];
  lines.push(`index: ${s.indexPath}`);
  lines.push(`schema_version: ${s.schemaVersion}`);
  lines.push(`documents:  ${s.documents}`);
  lines.push(`chunks:     ${s.chunks}`);
  if (census !== null) {
    lines.push(`size_on_disk:        ${formatEstimateBytes(census.sizeOnDiskBytes)}`);
    lines.push(`rebuild_estimate:    ${describeIndexEstimate(census)}`);
  }
  lines.push(`embeddings: ${s.embeddings} (stale: ${s.staleEmbeddings})`);
  lines.push(`embedding_model:     ${s.embeddingModel ?? "(none)"}`);
  lines.push(`embedding_dimension: ${s.embeddingDimension ?? "(none)"}`);
  lines.push(`embedding_signature: ${s.embeddingSignature ?? "(disabled)"}`);
  if (s.estimatedRefreshCostUsd === null || s.estimatedRefreshCostUsd > 0) {
    lines.push(`refresh_cost_est:    ${formatEstimatedUsd(s.estimatedRefreshCostUsd)}`);
  }
  lines.push(`vec_extension:       ${s.vecExtension}`);
  lines.push(`semantic_enabled:    ${s.semanticEnabled}`);
  lines.push(`embedding_key:       ${s.embeddingKeyPresent ? "present" : "missing"}`);
  lines.push(`last_indexed_at:     ${s.lastIndexedAt ?? "(never)"}`);
  lines.push(`last_full_index_at:  ${s.lastFullIndexAt ?? "(never)"}`);
  if (freshen !== null) lines.push(...renderFreshenStatus(freshen));
  if (eventTime !== null) lines.push(`event_time:          ${renderEventTimeStatus(eventTime)}`);
  // The oversize-chunk census when it could NOT run. Above the warnings
  // and not among them, deliberately: this line reports a check that did
  // not happen, and there is no command an operator runs about it. Its
  // absence here means the check ran - and if it found something, that
  // IS a warning below.
  if (s.chunkWindowUndeclared !== undefined) {
    const model = s.chunkWindowUndeclared.model ?? "(none configured)";
    lines.push(
      `chunk_window_check:  not run - no input window is declared for ${model} ` +
        `(${s.chunkWindowUndeclared.chunksMeasured} chunk(s) uncompared)`,
    );
  }
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n") + "\n";
}

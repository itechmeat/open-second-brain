/**
 * `o2b brain batch-plan <source-dir>` (A3 / t_9eeb8ca2): plan a large-folder
 * ingest into bounded parallel batches.
 *
 * Discovers the ingestible (text-bearing) files under the directory, skips
 * everything the content-hash manifest classifies `unchanged` since the last
 * ingest, and packs the new/modified remainder into batches bounded by
 * `--max-bytes` and `--max-files`. Read-only and deterministic — the caller
 * dispatches each printed batch as a parallel ingest subagent; the kernel
 * spawns nothing itself.
 */

import { planBatches } from "../../../core/brain/ingest/batch-plan.ts";
import { brainVerbContext, fail, info, ok, okJson, parse } from "../helpers.ts";

/** Default caps, mirroring the MCP surface (1 MiB / 25 files per batch). */
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_BATCH_FILES = 25;

function parseCap(raw: unknown, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${String(raw)}`);
  }
  return n;
}

export async function cmdBrainBatchPlan(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    "max-bytes": { type: "string" },
    "max-files": { type: "string" },
    json: { type: "boolean" },
  });
  const sourceDir = positional[0];
  if (!sourceDir) {
    return fail(
      "usage: o2b brain batch-plan <source-dir> [--max-bytes N] [--max-files N] [--json]",
    );
  }

  try {
    const { vault } = brainVerbContext(flags);
    const maxBatchBytes = parseCap(flags["max-bytes"], "--max-bytes", DEFAULT_MAX_BATCH_BYTES);
    const maxBatchFiles = parseCap(flags["max-files"], "--max-files", DEFAULT_MAX_BATCH_FILES);
    const plan = planBatches(vault, sourceDir, { maxBatchBytes, maxBatchFiles });

    if (flags["json"]) {
      okJson({
        source_dir: plan.sourceDir,
        max_batch_bytes: plan.maxBatchBytes,
        max_batch_files: plan.maxBatchFiles,
        total_files: plan.totalFiles,
        total_bytes: plan.totalBytes,
        skipped: [...plan.skipped],
        batches: plan.batches.map((b) => ({
          index: b.index,
          total_bytes: b.totalBytes,
          files: b.files.map((f) => ({ path: f.path, bytes: f.bytes, status: f.status })),
        })),
      });
      return 0;
    }

    ok(`batch-plan: ${plan.sourceDir}`);
    ok(
      `  ${plan.totalFiles} file(s) to ingest in ${plan.batches.length} batch(es); ` +
        `${plan.skipped.length} unchanged skipped`,
    );
    for (const b of plan.batches) {
      ok(`  batch ${b.index}: ${b.files.length} file(s), ${b.totalBytes} byte(s)`);
      for (const f of b.files) ok(`    - ${f.path} (${f.status}, ${f.bytes}B)`);
    }
    if (plan.skipped.length > 0) {
      info(`  ${plan.skipped.length} unchanged file(s) skipped:`);
      for (const p of plan.skipped) info(`    - ${p}`);
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

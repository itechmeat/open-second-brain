/**
 * `o2b search index` and `o2b search reindex` — the two index builders.
 *
 * They differ only in whether the existing index is reused, so they share
 * the safeguard, the run report (JSON + human) and the terminal state they
 * name once the index covers every document.
 */

import { formatDegradationNotice } from "../../../core/integrity/degradation.ts";
import { createSafeguard, resolveSafeguardTimeoutMs } from "../../../core/brain/safeguard.ts";
import { indexVault, reindexVault } from "../../../core/search/index.ts";
import type { IndexStats } from "../../../core/search/index.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { emitNextStep } from "../../advisory-rail.ts";
import { CronTemplateError, renderCronTemplate } from "../../search-cron-template.ts";
import {
  flagBoolean,
  flagString,
  parseFlags,
  resolveConfig,
  searchAdvisoryStream,
  VAULT_FLAGS,
  type ResolvedSearchConfig,
  type SearchVerbFlags,
} from "../helpers.ts";

/**
 * Both builders run under the `reindex` safeguard budget: an incremental
 * pass over a large vault is the same class of long write as a rebuild, so
 * one configurable deadline covers both.
 */
const SAFEGUARD_OPERATION = "reindex";

/** Terminal state both builders reach when the index covers every document. */
const INDEX_BUILT = "search-index-built";

/**
 * The state a run leaves when the index holds documents whose EVENT
 * ANCHOR has never been resolved (provenance at the boundary).
 *
 * It outranks `INDEX_BUILT` as this run's exit, and deliberately: a
 * schema bump migrates in place and reindexes nothing, so every
 * pre-anchor document takes the unchanged fastpath and the run truly did
 * cover the vault - but a hard `since` / `until` filter is now judged on
 * a column those rows do not carry, and naming `o2b search query` next
 * would send the operator at exactly the query that answers wrongly.
 */
const EVENT_ANCHORS_PENDING = "event-anchors-pending";

/** Default flush cadence for the generated `reindex --cron-template`. */
const DEFAULT_CRON_INTERVAL = "30m";

function reindexSafeguard(flags: SearchVerbFlags): ReturnType<typeof createSafeguard> {
  return createSafeguard({
    operation: SAFEGUARD_OPERATION,
    timeoutMs: resolveSafeguardTimeoutMs(SAFEGUARD_OPERATION, flagString(flags, "config")),
  });
}

/**
 * True when the run this `stats` describes left the index covering every
 * document, which is what the `search-index-built` class ("search index
 * up to date") asserts.
 *
 * `stats.errors` means, per its own declaration, "this file did not
 * index". Emitting the class with entries in it would tell the operator
 * the index is current while the tool knows documents are missing from
 * it, and would point at `o2b search query` as though a query over it
 * were complete. Re-labelling the class instead was considered and
 * rejected: a truthful label for the failed case would have to be
 * vacuous, and it would leave the misleading COMMAND in place.
 *
 * A run with errors is left deliberately without a rail line. The errors
 * block already names every affected path and message, and what repairs
 * an unreadable or malformed note is a judgement over that file's
 * content - there is no `o2b` command that performs it, and naming the
 * indexer again would advise repeating the run that just failed.
 */
function indexIsComplete(stats: IndexStats): boolean {
  return stats.errors.length === 0;
}

/**
 * Write one builder's run report and name the terminal state it reached.
 * Identical for `index` and `reindex` because they reach the same state.
 */
function reportIndexRun(
  stats: IndexStats,
  cfg: ResolvedSearchConfig,
  argv: ReadonlyArray<string>,
  jsonRequested: boolean,
): void {
  const complete = indexIsComplete(stats);
  const exitCode = stats.eventAnchorsPending > 0 ? EVENT_ANCHORS_PENDING : INDEX_BUILT;
  if (jsonRequested) {
    // no-dead-ends, phase 3: the rail suppresses its line on this stream
    // and returns the resolved step precisely so the payload can carry
    // it. Absent whenever the run left the index incomplete.
    process.stdout.write(
      JSON.stringify({
        ...(jsonForStats(stats, cfg) as Record<string, unknown>),
        ...(complete ? nextCommandField(exitCode) : {}),
      }) + "\n",
    );
  } else {
    process.stdout.write(renderStatsHuman(stats, cfg));
  }
  if (complete) {
    emitNextStep(exitCode, searchAdvisoryStream(argv, jsonRequested));
  }
}

export async function cmdSearchIndex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    embeddings: { type: "boolean" },
    force: { type: "boolean" },
    "force-cost": { type: "boolean" },
    concurrency: { type: "string" },
    verbose: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);

  const verbose = flagBoolean(flags, "verbose");
  const stats = await indexVault(cfg, {
    safeguard: reindexSafeguard(flags),
    embeddings: flagBoolean(flags, "embeddings"),
    force: flagBoolean(flags, "force"),
    forceCost: flagBoolean(flags, "force-cost"),
    onFile: (e) => {
      if (verbose) {
        const msg = e.message ? ` ${e.message}` : "";
        process.stderr.write(`${e.kind}\t${e.path}${msg}\n`);
      }
    },
  });

  reportIndexRun(stats, cfg, argv, flagBoolean(flags, "json"));
  return 0;
}

export async function cmdSearchReindex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    embeddings: { type: "boolean" },
    "force-cost": { type: "boolean" },
    concurrency: { type: "string" },
    json: { type: "boolean" },
    verbose: { type: "boolean" },
    "cron-template": { type: "boolean" },
    interval: { type: "string" },
  });
  if (flagBoolean(flags, "cron-template")) {
    const intervalRaw = flagString(flags, "interval") ?? DEFAULT_CRON_INTERVAL;
    try {
      const body = renderCronTemplate(intervalRaw);
      process.stdout.write(body);
      return 0;
    } catch (err) {
      if (err instanceof CronTemplateError) {
        process.stderr.write(`error: ${err.message}\n`);
        return 1;
      }
      throw err;
    }
  }
  const cfg = resolveConfig(flags);
  const stats = await reindexVault(cfg, {
    safeguard: reindexSafeguard(flags),
    embeddings: flagBoolean(flags, "embeddings"),
    forceCost: flagBoolean(flags, "force-cost"),
    onFile: flagBoolean(flags, "verbose")
      ? (e) => process.stderr.write(`${e.kind}\t${e.path}\n`)
      : undefined,
  });
  reportIndexRun(stats, cfg, argv, flagBoolean(flags, "json"));
  return 0;
}

function jsonForStats(stats: IndexStats, cfg: ResolvedSearchConfig): unknown {
  return {
    stats: {
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      deleted: stats.deleted,
      chunks_total: stats.chunksTotal,
      embeddings_computed: stats.embeddingsComputed,
      embeddings_retries: stats.embeddingsRetries,
      // Conditional: a vault with nothing pending emits exactly the
      // payload it emitted before this field existed.
      ...(stats.eventAnchorsPending > 0
        ? { event_anchors_pending: stats.eventAnchorsPending }
        : {}),
    },
    errors: stats.errors.map((e) => ({ path: e.path, message: e.message })),
    // Unit F. Conditional so a vault with no malformed frontmatter emits
    // exactly the payload it emitted before this field existed.
    ...(stats.frontmatterNotices.length > 0
      ? {
          frontmatter_notices: stats.frontmatterNotices.map((n) => ({
            code: n.code,
            site: n.site,
            ...(n.path !== undefined ? { path: n.path } : {}),
            detail: n.detail,
          })),
        }
      : {}),
    duration_ms: stats.durationMs,
    vault: cfg.vault,
    db_path: cfg.dbPath,
  };
}

function renderStatsHuman(stats: IndexStats, cfg: ResolvedSearchConfig): string {
  const lines: string[] = [];
  lines.push(`indexing vault: ${cfg.vault}`);
  lines.push(`  added:    ${stats.added} files, ${stats.chunksTotal} chunks`);
  lines.push(`  updated:  ${stats.updated} files`);
  lines.push(`  unchanged: ${stats.unchanged} files`);
  lines.push(`  deleted:  ${stats.deleted} files`);
  if (stats.embeddingsComputed > 0 || stats.embeddingsRetries > 0) {
    lines.push(
      `  embeddings: ${stats.embeddingsComputed} computed (${stats.embeddingsRetries} retries)`,
    );
  }
  // Above the errors block: these documents indexed fine, under a
  // binary that had no event anchor to compute for them.
  if (stats.eventAnchorsPending > 0) {
    lines.push(
      `  event anchors: ${stats.eventAnchorsPending} document(s) indexed before anchors existed`,
    );
  }
  if (stats.errors.length > 0) {
    lines.push(`  errors:`);
    for (const e of stats.errors) lines.push(`    - ${e.path}: ${e.message}`);
  }
  // Unit F. Below the errors block and only when non-empty: these files
  // indexed successfully, they just lost a frontmatter field.
  if (stats.frontmatterNotices.length > 0) {
    lines.push(`  frontmatter:`);
    for (const n of stats.frontmatterNotices) {
      lines.push(`    - ${formatDegradationNotice(n)}`);
    }
  }
  lines.push(`done in ${(stats.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n") + "\n";
}

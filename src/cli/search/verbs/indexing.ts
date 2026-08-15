/**
 * `o2b search index` and `o2b search reindex` — the two index builders.
 *
 * They differ only in whether the existing index is reused, so they share
 * the safeguard, the run report (JSON + human) and the terminal state they
 * name once the index covers every document.
 */

import { formatDegradationNotice } from "../../../core/integrity/degradation.ts";
import {
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SafeguardAbortError,
} from "../../../core/brain/safeguard.ts";
import {
  chunkWindowDiagnosticCode,
  indexVault,
  reindexVault,
  SearchError,
  serializeChunkWindowCensus,
} from "../../../core/search/index.ts";
import type { ChunkWindowCensus, IndexStats } from "../../../core/search/index.ts";
import {
  recordSelfHealOutcome,
  SELF_HEAL_REINDEX_OUTCOME,
} from "../../../core/maintenance/self-heal-reindex.ts";
import { nextCommandField } from "../../../core/brain/next-step.ts";
import { OPERATION } from "../../../core/brain/safeguard.ts";
import { emitNextSteps } from "../../advisory-rail.ts";
import { onInterrupt, reportInterrupted } from "../../interrupt.ts";
import {
  attachProgress,
  reportProgressRefusal,
  type ProgressAttachment,
} from "../../progress-rail.ts";
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
const SAFEGUARD_OPERATION = OPERATION.reindex;

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

/** Top-level command both builders live under, for the rails. */
const SEARCH_COMMAND = "search";

function reindexSafeguard(flags: SearchVerbFlags): ReturnType<typeof createSafeguard> {
  return createSafeguard({
    operation: SAFEGUARD_OPERATION,
    timeoutMs: resolveSafeguardTimeoutMs(SAFEGUARD_OPERATION, flagString(flags, "config")),
  });
}

/**
 * Attach the progress rail for one builder run, and say at once when the
 * stream cannot carry it.
 *
 * Progress is opt-in: attaching a sink by default would change the stderr
 * of every existing invocation, and the older stream on this very command
 * - `--verbose` - is opt-in for the same reason. The two are different
 * channels answering different questions and both are additive, so
 * neither suppresses the other.
 *
 * Written once for both builders: they take the same decision from the
 * same flags, and two copies would be two chances for one of them to
 * observe a run the other would not.
 */
function observeIndexRun(flags: SearchVerbFlags, verb: string): ProgressAttachment | null {
  if (!flagBoolean(flags, "progress")) return null;
  const attachment = attachProgress({
    command: SEARCH_COMMAND,
    argv: [verb],
    jsonRequested: flagBoolean(flags, "json"),
  });
  reportProgressRefusal(attachment);
  return attachment;
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
  // The census verdict is its own state with its own exit, and it is
  // reported whether or not the run completed - an incomplete run still
  // wrote the chunks it wrote. The batch form de-duplicates on the
  // resolved command, so a run with no census emits exactly the one line
  // it emitted before this feature.
  const codes: string[] = [];
  if (stats.chunkWindow !== undefined) codes.push(chunkWindowDiagnosticCode(stats.chunkWindow));
  if (complete) codes.push(exitCode);
  emitNextSteps(codes, searchAdvisoryStream(argv, jsonRequested));
}

export async function cmdSearchIndex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    embeddings: { type: "boolean" },
    force: { type: "boolean" },
    "force-cost": { type: "boolean" },
    concurrency: { type: "string" },
    verbose: { type: "boolean" },
    progress: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);

  const verbose = flagBoolean(flags, "verbose");
  const observation = observeIndexRun(flags, "index");
  const interrupt = onInterrupt(OPERATION.reindex);
  let stats: IndexStats;
  try {
    stats = await indexVault(cfg, {
      safeguard: reindexSafeguard(flags),
      embeddings: flagBoolean(flags, "embeddings"),
      force: flagBoolean(flags, "force"),
      forceCost: flagBoolean(flags, "force-cost"),
      // The cancellation seam `indexVault` already declares and checks -
      // between files and between embed batches, never mid-write - with
      // nothing production-side to trip it until now.
      signal: interrupt.signal,
      onFile: (e) => {
        if (verbose) {
          const msg = e.message ? ` ${e.message}` : "";
          process.stderr.write(`${e.kind}\t${e.path}${msg}\n`);
        }
      },
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
  } catch (err) {
    if (err instanceof SafeguardAbortError) {
      return reportInterrupted(interrupt, err, flagBoolean(flags, "json"));
    }
    throw err;
  } finally {
    interrupt.release();
  }

  reportIndexRun(stats, cfg, argv, flagBoolean(flags, "json"));
  return 0;
}

/**
 * Rebuild the index from scratch.
 *
 * `--self-heal <run-id>` marks the run as the automatic post-upgrade
 * rebuild that `ensureVaultCurrent` spawns detached, with every stream
 * ignored because there is no terminal to write to. It changes nothing
 * about the rebuild; it only makes the run's terminal outcome - success or
 * the failure by name - land on the `self_heal_reindex` metrics surface
 * under the run id the parent minted, which is the only place such a run
 * can be read from afterwards and the only thing its two rows pair on.
 */
export async function cmdSearchReindex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    ...VAULT_FLAGS,
    embeddings: { type: "boolean" },
    "force-cost": { type: "boolean" },
    concurrency: { type: "string" },
    json: { type: "boolean" },
    verbose: { type: "boolean" },
    progress: { type: "boolean" },
    "cron-template": { type: "boolean" },
    interval: { type: "string" },
    "self-heal": { type: "string" },
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
  const selfHeal = flagString(flags, "self-heal");
  const startedAt = Date.now();
  // Read before the config, and the config read is inside the recording:
  // `resolveConfig` used to run outside it, so a self-heal child that died
  // on an unresolvable `--config` left its parent's spawn row unpaired -
  // evidence a reader was told to interpret as a child that vanished.
  const cfg = resolveSelfHealConfig(flags, selfHeal, startedAt);
  const observation = observeIndexRun(flags, "reindex");
  const interrupt = onInterrupt(OPERATION.reindex);
  let stats: IndexStats;
  try {
    stats = await reindexVault(cfg, {
      safeguard: reindexSafeguard(flags),
      embeddings: flagBoolean(flags, "embeddings"),
      forceCost: flagBoolean(flags, "force-cost"),
      signal: interrupt.signal,
      onFile: flagBoolean(flags, "verbose")
        ? (e) => process.stderr.write(`${e.kind}\t${e.path}\n`)
        : undefined,
      ...(observation?.sink !== undefined ? { onProgress: observation.sink } : {}),
    });
  } catch (err) {
    // The only report a self-heal run's failure ever gets. Recorded before
    // the rethrow so the row exists whatever the caller's stderr is
    // pointed at, and the rethrow is unchanged so an operator running this
    // by hand still sees the error and the exit code they always saw.
    //
    // A stopped rebuild is recorded here too, and correctly: the staging
    // database was abandoned and never swapped in, so this run left the
    // live index exactly as it found it - which is a rebuild that did not
    // happen, whoever asked for it to stop.
    if (selfHeal !== undefined) {
      recordSelfHealOutcome(
        cfg.vault,
        SELF_HEAL_REINDEX_OUTCOME.failed,
        selfHeal,
        Date.now() - startedAt,
        describeFailure(err),
      );
    }
    if (err instanceof SafeguardAbortError) {
      return reportInterrupted(interrupt, err, flagBoolean(flags, "json"));
    }
    throw err;
  } finally {
    interrupt.release();
  }
  if (selfHeal !== undefined) {
    recordSelfHealOutcome(
      cfg.vault,
      SELF_HEAL_REINDEX_OUTCOME.completed,
      selfHeal,
      Date.now() - startedAt,
    );
  }
  reportIndexRun(stats, cfg, argv, flagBoolean(flags, "json"));
  return 0;
}

/**
 * `resolveConfig`, with a self-heal child's failure recorded before it is
 * rethrown.
 *
 * The vault comes off the `--vault` flag rather than the resolved config,
 * because the config is the thing that just failed - and the parent always
 * passes `--vault`, so the value is there for exactly the runs that own a
 * spawn row. A child invoked WITHOUT `--vault` whose config will not
 * resolve still records nothing: there is no vault to record into, and
 * inventing one would write a row into a directory nobody asked about.
 * That residue is named in `self-heal-reindex.ts`, case 3.
 *
 * The error is always rethrown, unchanged: this adds a row, it does not
 * soften a failure.
 */
function resolveSelfHealConfig(
  flags: SearchVerbFlags,
  selfHealRunId: string | undefined,
  startedAt: number,
): ResolvedSearchConfig {
  try {
    return resolveConfig(flags);
  } catch (err) {
    const vault = flagString(flags, "vault");
    if (selfHealRunId !== undefined && vault !== undefined) {
      recordSelfHealOutcome(
        vault,
        SELF_HEAL_REINDEX_OUTCOME.failed,
        selfHealRunId,
        Date.now() - startedAt,
        describeFailure(err),
      );
    }
    throw err;
  }
}

/**
 * One line naming what failed. A {@link SearchError} leads with its CODE:
 * the row is read back by an operator and by tests, and a code survives a
 * message reword where the prose does not.
 */
function describeFailure(err: unknown): string {
  if (err instanceof SearchError) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The census verdict on THIS surface: the shared wire shape plus the
 * registered exit for its state. The exit belongs here and not in the
 * shared serializer because it is a property of the surface, not of the
 * verdict - the status snapshot carries the same record without one.
 * A run can index every document cleanly and still have produced chunks
 * the model cannot read whole, so this exit is not the run's terminal
 * state either.
 */
function serializeChunkWindow(census: ChunkWindowCensus): Record<string, unknown> {
  return {
    ...serializeChunkWindowCensus(census),
    ...nextCommandField(chunkWindowDiagnosticCode(census)),
  };
}

/**
 * One human line per census verdict. It states the condition and no
 * command: the forward pointer is the advisory rail's, emitted for this
 * run's census code beside the run's terminal state.
 */
function describeChunkWindow(census: ChunkWindowCensus): string {
  if (census.verdict === "window-undeclared") {
    const model = census.model === null ? "(none configured)" : census.model;
    return `not checked - no input window is declared for ${model}`;
  }
  const against = `the ${census.windowTokens}-token window declared for ${census.model}`;
  if (census.verdict === "estimate-undecided") {
    return (
      `${census.chunksUndecided} of ${census.chunksMeasured} chunk(s) undecided against ` +
      `${against} - the character-count estimate does not bound non-Latin text`
    );
  }
  const undecided =
    census.chunksUndecided === undefined ? "" : `, ${census.chunksUndecided} undecided`;
  return (
    `${census.chunksOverWindow} of ${census.chunksMeasured} chunk(s) estimate above ` +
    `${against}${undecided}`
  );
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
      // Oversize-chunk census. Absent - not zero, not null - whenever it
      // has nothing to report, so an index whose chunks fit the model's
      // declared window emits exactly the payload it emitted before this
      // field existed. `window-undeclared` carries no count on purpose:
      // nothing was counted.
      ...(stats.chunkWindow === undefined
        ? {}
        : { chunk_window: serializeChunkWindow(stats.chunkWindow) }),
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
  // Same placement rule as the event-anchor line above and for the same
  // reason: these chunks indexed fine, against a model whose declared
  // window they do not fit - or against one that declares no window.
  if (stats.chunkWindow !== undefined) {
    lines.push(`  chunk window: ${describeChunkWindow(stats.chunkWindow)}`);
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

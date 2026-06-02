/**
 * `o2b search` subcommand dispatcher.
 *
 * Routes the five Brain Search verbs (design doc §8) to thin wrappers
 * over `src/core/search/*`. The core modules own all I/O; this file
 * only parses flags, resolves the vault, shapes exit codes, and renders
 * either human-readable or JSON output.
 *
 *   o2b search "<query>"           → cmdSearchQuery (default verb)
 *   o2b search index               → cmdSearchIndex
 *   o2b search reindex             → cmdSearchReindex
 *   o2b search status              → cmdSearchStatus
 *   o2b search check               → cmdSearchCheck
 */

import { defaultConfigPath, resolveVault } from "../core/config.ts";
import {
  indexCheck,
  indexStatus,
  indexVault,
  reindexVault,
  resolveSearchConfig,
  search,
  SearchError,
  clearSessionFocus,
  normalizeSessionFocus,
  parseStructuredRecallQueryDocument,
  readSessionFocus,
  structuredRecallQueryText,
  writeSessionFocus,
} from "../core/search/index.ts";
import type {
  IndexCheckReport,
  IndexProgressEvent,
  IndexStats,
  IndexStatusSnapshot,
  ResolvedSearchConfig,
  SearchSessionFocus,
  SearchOutcome,
} from "../core/search/index.ts";
import { CliError, parseFlags } from "./argparse.ts";
import { CronTemplateError, renderCronTemplate } from "./search-cron-template.ts";

const KNOWN_VERBS = new Set(["query", "index", "reindex", "status", "check", "focus"]);

export async function handleSearchSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  // First positional is verb iff it matches a known verb. Otherwise the
  // default verb is `query` and the positional is the query string.
  let verb = "query";
  let rest = argv;
  if (argv.length > 0 && KNOWN_VERBS.has(argv[0]!)) {
    verb = argv[0]!;
    rest = argv.slice(1);
  }

  try {
    switch (verb) {
      case "query":
        return await cmdSearchQuery(rest);
      case "index":
        return await cmdSearchIndex(rest);
      case "reindex":
        return await cmdSearchReindex(rest);
      case "status":
        return await cmdSearchStatus(rest);
      case "check":
        return await cmdSearchCheck(rest);
      case "focus":
        return await cmdSearchFocus(rest);
      default:
        process.stderr.write(`error: unknown search verb: ${verb}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof SearchError) {
      process.stderr.write(`error: ${e.message} [${e.code}]\n`);
      return e.code === "INVALID_INPUT" ? 2 : 1;
    }
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function resolveConfig(
  flags: Record<string, string | boolean | string[] | undefined>,
): ResolvedSearchConfig {
  const flagVault = typeof flags["vault"] === "string" ? (flags["vault"] as string) : undefined;
  const configPath =
    typeof flags["config"] === "string" ? (flags["config"] as string) : defaultConfigPath();
  const vault = flagVault ?? resolveVault(configPath) ?? null;
  if (!vault) {
    throw new CliError(
      "no vault configured. Pass --vault <path> or run `o2b init --vault <path> ...` first.",
    );
  }
  const dbFlag = typeof flags["db"] === "string" ? (flags["db"] as string) : undefined;
  const kwFlag =
    typeof flags["keyword-weight"] === "string" ? Number(flags["keyword-weight"]) : undefined;
  const semFlag =
    typeof flags["semantic-weight"] === "string" ? Number(flags["semantic-weight"]) : undefined;
  const concurrencyFlag =
    typeof flags["concurrency"] === "string" ? Number(flags["concurrency"]) : undefined;
  const overrides = {
    ...(dbFlag !== undefined ? { dbPath: dbFlag } : {}),
    ...(kwFlag !== undefined ? { keywordWeight: kwFlag } : {}),
    ...(semFlag !== undefined ? { semanticWeight: semFlag } : {}),
    ...(concurrencyFlag !== undefined ? { semantic: { concurrency: concurrencyFlag } } : {}),
  };
  return resolveSearchConfig({ vault, configPath, overrides });
}

// ─── focus ───────────────────────────────────────────────────────────────────

async function cmdSearchFocus(argv: ReadonlyArray<string>): Promise<number> {
  const action = argv[0];
  if (!action || !["set", "status", "clear"].includes(action)) {
    throw new CliError("usage: o2b search focus <set|status|clear> [--query Q] [--path P]");
  }
  const { flags } = parseFlags(argv.slice(1), {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    query: { type: "string" },
    path: { type: "string" },
    "ttl-minutes": { type: "string", default: "120" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);

  if (action === "set") {
    const ttlMinutes = Number(flags["ttl-minutes"] ?? "120");
    const focus = normalizeSessionFocus(
      {
        query: typeof flags["query"] === "string" ? (flags["query"] as string) : null,
        pathPrefix: typeof flags["path"] === "string" ? (flags["path"] as string) : null,
        ttlMinutes,
      },
      Date.now(),
    );
    writeSessionFocus(cfg, focus);
    writeFocusResponse(focus, flags["json"] === true);
    return 0;
  }

  if (action === "clear") {
    clearSessionFocus(cfg);
    writeFocusResponse(null, flags["json"] === true);
    return 0;
  }

  writeFocusResponse(readSessionFocus(cfg), flags["json"] === true);
  return 0;
}

function focusJson(focus: SearchSessionFocus | null): Record<string, unknown> {
  return { active: focus !== null, focus };
}

function writeFocusResponse(focus: SearchSessionFocus | null, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(focusJson(focus)) + "\n");
    return;
  }
  if (!focus) {
    process.stdout.write("search focus: inactive\n");
    return;
  }
  const parts = [
    focus.query !== null ? `query=${JSON.stringify(focus.query)}` : null,
    focus.pathPrefix !== null ? `path=${JSON.stringify(focus.pathPrefix)}` : null,
    focus.expiresAt !== null ? `expires_at=${new Date(focus.expiresAt).toISOString()}` : null,
  ].filter((part): part is string => part !== null);
  process.stdout.write(`search focus: active ${parts.join(" ")}\n`);
}

// ─── query ────────────────────────────────────────────────────────────────────

async function cmdSearchQuery(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    limit: { type: "string", default: "10" },
    semantic: { type: "boolean" },
    "keyword-only": { type: "boolean" },
    path: { type: "string" },
    "keyword-weight": { type: "string" },
    "semantic-weight": { type: "string" },
    "auto-refresh": { type: "boolean" },
    property: { type: "string-array" },
    visibility: { type: "string-array" },
    "query-doc": { type: "string" },
    "evidence-pack": { type: "boolean" },
    "include-superseded": { type: "boolean" },
    json: { type: "boolean" },
    verbose: { type: "boolean" },
  });

  const rawQueryDocument =
    typeof flags["query-doc"] === "string" ? (flags["query-doc"] as string) : undefined;
  const structuredQuery =
    rawQueryDocument !== undefined
      ? parseStructuredRecallQueryDocument(rawQueryDocument)
      : undefined;

  if (positional.length === 0 && structuredQuery === undefined) {
    throw new CliError("query string is required");
  }
  if (flags["semantic"] === true && flags["keyword-only"] === true) {
    throw new CliError("--semantic and --keyword-only are mutually exclusive");
  }
  const query =
    positional.length > 0 ? positional.join(" ") : structuredRecallQueryText(structuredQuery!);
  if (query.trim().length === 0) {
    throw new CliError("query string is required when --query-doc has no searchable lanes");
  }
  const limitNum = Number(flags["limit"] ?? "10");
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 100) {
    throw new CliError("--limit must be an integer in 1..100");
  }

  const cfg = resolveConfig(flags);

  if (flags["auto-refresh"]) {
    try {
      await indexVault(cfg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`auto-refresh failed: ${msg}\n`);
    }
  }

  // Pass `undefined` when no explicit flag is set so `search()` falls back
  // to the config default. Passing `null` works by accident today but blurs
  // the implicit/explicit policy boundary in §7 of the search design.
  const semanticOverride: boolean | undefined =
    flags["semantic"] === true ? true : flags["keyword-only"] === true ? false : undefined;

  const properties = parsePropertyFlags(flags["property"] as string[] | undefined);
  const visibility = flags["visibility"] as string[] | undefined;

  const outcome = await search(cfg, {
    query,
    limit: limitNum,
    semantic: semanticOverride,
    keywordOnly: flags["keyword-only"] === true,
    pathPrefix: typeof flags["path"] === "string" ? (flags["path"] as string) : undefined,
    ...(properties !== undefined ? { properties } : {}),
    ...(visibility !== undefined && visibility.length > 0 ? { visibility } : {}),
    ...(structuredQuery !== undefined ? { structuredQuery } : {}),
    ...(flags["evidence-pack"] === true ? { evidencePack: true } : {}),
    ...(flags["include-superseded"] === true ? { includeSuperseded: true } : {}),
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(jsonForOutcome(outcome)) + "\n");
    return 0;
  }
  process.stdout.write(renderOutcomeHuman(outcome, flags["verbose"] === true));
  return 0;
}

/**
 * Parse the repeatable `--property KEY=VALUE` flag into the
 * `properties` map shape that `search()` consumes. Multiple
 * `--property KEY=...` entries for the same KEY accumulate (OR).
 * Different KEYs accumulate as separate entries (AND).
 */
function parsePropertyFlags(
  raw: ReadonlyArray<string> | undefined,
): ReadonlyMap<string, ReadonlyArray<string>> | undefined {
  if (!raw || raw.length === 0) return undefined;
  const acc = new Map<string, string[]>();
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`--property must be KEY=VALUE, got: ${entry}`);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw new CliError(`--property must be KEY=VALUE, got: ${entry}`);
    }
    const arr = acc.get(key) ?? [];
    arr.push(value);
    acc.set(key, arr);
  }
  const frozen = new Map<string, ReadonlyArray<string>>();
  for (const [k, v] of acc) frozen.set(k, Object.freeze(v));
  return frozen;
}

function jsonForOutcome(o: SearchOutcome): unknown {
  return {
    results: o.results.map((r) => ({
      path: r.path,
      title: r.title,
      content: r.content,
      score: r.score,
      keyword_score: r.keywordScore,
      semantic_score: r.semanticScore,
      link_boost: r.linkBoost,
      recency_boost: r.recencyBoost,
      start_line: r.startLine,
      end_line: r.endLine,
      search_type: r.searchType,
      reasons: r.reasons,
      ...(o.evidencePack ? { why_retrieved: r.reasons } : {}),
      document_id: r.documentId,
      chunk_id: r.chunkId,
      ...(r.relations && r.relations.length > 0 ? { relations: r.relations } : {}),
    })),
    warnings: o.warnings,
    total: o.total,
    ...(o.evidencePack ? { evidence_pack: jsonForEvidencePack(o.evidencePack) } : {}),
  };
}

function jsonForEvidencePack(pack: NonNullable<SearchOutcome["evidencePack"]>): unknown {
  return {
    significant_terms: pack.significantTerms,
    matched_terms: pack.matchedTerms,
    missing_terms: pack.missingTerms,
    support_coverage: pack.supportCoverage,
    records: pack.records.map((record) => ({
      path: record.path,
      document_id: record.documentId,
      chunk_id: record.chunkId,
      matched_terms: record.matchedTerms,
      missing_terms: record.missingTerms,
      support_coverage: record.supportCoverage,
      terminal_state: record.terminalState,
      why_retrieved: record.whyRetrieved,
      dropped_candidate_reasons: record.droppedCandidateReasons,
    })),
    dropped_candidates: pack.droppedCandidates,
    abstention: pack.abstention,
  };
}

function renderOutcomeHuman(o: SearchOutcome, verbose: boolean): string {
  const lines: string[] = [];
  if (o.results.length === 0) {
    lines.push("(no results)");
  }
  o.results.forEach((r, i) => {
    const score = r.score.toFixed(2);
    lines.push(`[${i + 1}] ${r.path}  •  ${score}`);
    lines.push(
      `    line ${r.startLine}-${r.endLine}  •  ${r.searchType}` +
        (verbose
          ? `  •  kw=${r.keywordScore.toFixed(2)} sem=${r.semanticScore.toFixed(2)} link=${r.linkBoost.toFixed(2)} rec=${r.recencyBoost.toFixed(2)}`
          : ""),
    );
    const snippet = r.content.trim().replace(/\s+/g, " ").slice(0, 140);
    lines.push(`    ${snippet}${r.content.length > 140 ? "…" : ""}`);
    if (verbose && r.reasons.length > 0) {
      lines.push(`    why: ${r.reasons.join(", ")}`);
    }
    if (r.relations && r.relations.length > 0) {
      const rel = r.relations.map((x) => `${x.relation} ${x.target}`).join(", ");
      lines.push(`    relations: ${rel}`);
    }
    lines.push("");
  });
  for (const w of o.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n") + (lines.length > 0 ? "" : "\n");
}

// ─── index ────────────────────────────────────────────────────────────────────

async function cmdSearchIndex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    embeddings: { type: "boolean" },
    force: { type: "boolean" },
    concurrency: { type: "string" },
    verbose: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);

  const events: IndexProgressEvent[] = [];
  const stats = await indexVault(cfg, {
    embeddings: flags["embeddings"] === true,
    force: flags["force"] === true,
    onFile: (e) => {
      events.push(e);
      if (flags["verbose"]) {
        const msg = e.message ? ` ${e.message}` : "";
        process.stderr.write(`${e.kind}\t${e.path}${msg}\n`);
      }
    },
  });

  if (flags["json"]) {
    process.stdout.write(JSON.stringify(jsonForStats(stats, cfg)) + "\n");
    return 0;
  }
  process.stdout.write(renderStatsHuman(stats, cfg));
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
    },
    errors: stats.errors.map((e) => ({ path: e.path, message: e.message })),
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
  if (stats.errors.length > 0) {
    lines.push(`  errors:`);
    for (const e of stats.errors) lines.push(`    - ${e.path}: ${e.message}`);
  }
  lines.push(`done in ${(stats.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n") + "\n";
}

// ─── reindex ──────────────────────────────────────────────────────────────────

async function cmdSearchReindex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    embeddings: { type: "boolean" },
    concurrency: { type: "string" },
    json: { type: "boolean" },
    verbose: { type: "boolean" },
    "cron-template": { type: "boolean" },
    interval: { type: "string" },
  });
  if (flags["cron-template"] === true) {
    const intervalRaw = (flags["interval"] as string | undefined) ?? "30m";
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
    embeddings: flags["embeddings"] === true,
    onFile: flags["verbose"] ? (e) => process.stderr.write(`${e.kind}\t${e.path}\n`) : undefined,
  });
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(jsonForStats(stats, cfg)) + "\n");
    return 0;
  }
  process.stdout.write(renderStatsHuman(stats, cfg));
  return 0;
}

// ─── status ───────────────────────────────────────────────────────────────────

async function cmdSearchStatus(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const status = await indexStatus(cfg);
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(jsonForStatus(status)) + "\n");
    return 0;
  }
  process.stdout.write(renderStatusHuman(status));
  return 0;
}

function jsonForStatus(s: IndexStatusSnapshot): unknown {
  return {
    index_path: s.indexPath,
    exists: s.exists,
    schema_version: s.schemaVersion,
    documents: s.documents,
    chunks: s.chunks,
    embeddings: s.embeddings,
    stale_embeddings: s.staleEmbeddings,
    embedding_model: s.embeddingModel,
    embedding_dimension: s.embeddingDimension,
    vec_extension: s.vecExtension,
    semantic_enabled: s.semanticEnabled,
    embedding_key_present: s.embeddingKeyPresent,
    last_indexed_at: s.lastIndexedAt,
    last_full_index_at: s.lastFullIndexAt,
    warnings: s.warnings,
  };
}

function renderStatusHuman(s: IndexStatusSnapshot): string {
  if (!s.exists) {
    return `index: not initialised. Run: o2b search index\n  path: ${s.indexPath}\n`;
  }
  const lines: string[] = [];
  lines.push(`index: ${s.indexPath}`);
  lines.push(`schema_version: ${s.schemaVersion}`);
  lines.push(`documents:  ${s.documents}`);
  lines.push(`chunks:     ${s.chunks}`);
  lines.push(`embeddings: ${s.embeddings} (stale: ${s.staleEmbeddings})`);
  lines.push(`embedding_model:     ${s.embeddingModel ?? "(none)"}`);
  lines.push(`embedding_dimension: ${s.embeddingDimension ?? "(none)"}`);
  lines.push(`vec_extension:       ${s.vecExtension}`);
  lines.push(`semantic_enabled:    ${s.semanticEnabled}`);
  lines.push(`embedding_key:       ${s.embeddingKeyPresent ? "present" : "missing"}`);
  lines.push(`last_indexed_at:     ${s.lastIndexedAt ?? "(never)"}`);
  lines.push(`last_full_index_at:  ${s.lastFullIndexAt ?? "(never)"}`);
  for (const w of s.warnings) lines.push(`warning: ${w}`);
  return lines.join("\n") + "\n";
}

// ─── check ────────────────────────────────────────────────────────────────────

async function cmdSearchCheck(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const report = await indexCheck(cfg);
  if (flags["json"]) {
    process.stdout.write(JSON.stringify(jsonForCheck(report)) + "\n");
  } else {
    process.stdout.write(renderCheckHuman(report));
  }
  return report.fatal.length > 0 ? 1 : 0;
}

function jsonForCheck(r: IndexCheckReport): unknown {
  return {
    vault_readable: r.vaultReadable,
    index_dir_writable: r.indexDirWritable,
    sqlite_ok: r.sqliteOk,
    fts5_ok: r.fts5Ok,
    vec_extension: r.vecExtension,
    embedding_key_resolved: r.embeddingKeyResolved,
    provider_reachable: r.providerReachable,
    provider_reason: r.providerReason,
    warnings: r.warnings,
    fatal: r.fatal,
    recommendations: r.recommendations,
  };
}

function renderCheckHuman(r: IndexCheckReport): string {
  const lines: string[] = [];
  const ok = (b: boolean) => (b ? "OK" : "MISSING");
  lines.push(`vault_readable:        ${ok(r.vaultReadable)}`);
  lines.push(`index_dir_writable:    ${ok(r.indexDirWritable)}`);
  lines.push(`sqlite_ok:             ${ok(r.sqliteOk)}`);
  lines.push(`fts5_ok:               ${ok(r.fts5Ok)}`);
  lines.push(`vec_extension:         ${r.vecExtension}`);
  lines.push(`embedding_key:         ${ok(r.embeddingKeyResolved)}`);
  if (r.providerReachable !== null) {
    lines.push(`provider_reachable:    ${r.providerReachable ? "OK" : "FAIL"}`);
    if (r.providerReason) lines.push(`provider_reason:       ${r.providerReason}`);
  }
  for (const w of r.warnings) lines.push(`warning: ${w}`);
  for (const f of r.fatal) lines.push(`fatal:   ${f}`);
  if (r.recommendations.length > 0) {
    lines.push("");
    lines.push("recommendations:");
    for (const rec of r.recommendations) lines.push(`  - ${rec}`);
  }
  return lines.join("\n") + "\n";
}

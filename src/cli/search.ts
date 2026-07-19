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
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SafeguardTimeoutError,
} from "../core/brain/safeguard.ts";
import {
  captureRecallFeedback,
  expandHit,
  indexCheck,
  indexStatus,
  indexVault,
  loadFeedbackEvents,
  readLearnedWeights,
  reindexVault,
  resetLearnedWeights,
  resolveSearchConfig,
  search,
  SearchError,
  clearSessionFocus,
  normalizeSessionFocus,
  parseStructuredRecallQueryDocument,
  readSessionFocus,
  structuredRecallQueryText,
  writeSessionFocus,
  LEARNED_WEIGHT_MIN,
  LEARNED_WEIGHT_MAX,
  type LearnedWeights,
  loadProviderRegistry,
  addProviderProfile,
  removeProviderProfile,
  getProviderProfile,
  loadRerankRegistry,
  addRerankProviderProfile,
  removeRerankProviderProfile,
  getRerankProviderProfile,
  planRead,
  serializeEvidencePack,
  serializeSearchCard,
  serializeIndexStatus,
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
} from "../core/search/index.ts";
import { parseDegreePredicate, type DegreePredicate } from "../core/search/property-filter.ts";
import type {
  IndexCheckReport,
  IndexProgressEvent,
  IndexStats,
  IndexStatusSnapshot,
  ResolvedSearchConfig,
  SearchSessionFocus,
  SearchOutcome,
} from "../core/search/index.ts";
import {
  EMBEDDING_MODEL_PRESETS,
  RECOMMENDED_EMBEDDING_MODEL,
  type EmbeddingModelPreset,
} from "../core/search/embeddings/presets.ts";
import { searchAcrossVaults } from "../core/search/cross-vault.ts";
import { rerankFitCheck } from "../core/search/rerank-fit-check.ts";
import { IndexWatchPlanner } from "../core/search/index-watch.ts";
import { IndexWatchRunner } from "../core/search/watch-runner.ts";
import { SafeguardAbortError } from "../core/brain/safeguard.ts";
import { canonicalNotePath } from "../core/path-safety.ts";
import { watch, type FSWatcher } from "node:fs";
import { CliError, parseFlags } from "./argparse.ts";
import { CronTemplateError, renderCronTemplate } from "./search-cron-template.ts";

const KNOWN_VERBS = new Set([
  "query",
  "expand",
  "index",
  "reindex",
  "status",
  "check",
  "focus",
  "feedback",
  "weights",
  "provider",
  "rerank-provider",
  "rerank-fit",
  "plan",
  "watch",
]);

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
      case "expand":
        return await cmdSearchExpand(rest);
      case "index":
        return await cmdSearchIndex(rest);
      case "reindex":
        return await cmdSearchReindex(rest);
      case "watch":
        return await cmdSearchWatch(rest);
      case "status":
        return await cmdSearchStatus(rest);
      case "check":
        return await cmdSearchCheck(rest);
      case "focus":
        return await cmdSearchFocus(rest);
      case "feedback":
        return await cmdSearchFeedback(rest);
      case "weights":
        return await cmdSearchWeights(rest);
      case "provider":
        return await cmdSearchProvider(rest);
      case "rerank-provider":
        return await cmdSearchRerankProvider(rest);
      case "rerank-fit":
        return await cmdSearchRerankFit(rest);
      case "plan":
        return await cmdSearchPlan(rest);
      default:
        process.stderr.write(`error: unknown search verb: ${verb}\n`);
        return 2;
    }
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    if (e instanceof SafeguardTimeoutError) {
      // Operational failure with a precise cause: the cooperative
      // deadline tripped at a checkpoint (t_06784b8d). Search verbs
      // report errors as stderr text regardless of --json, so the
      // timeout follows the same convention.
      process.stderr.write(`error: ${e.message} [SAFEGUARD_TIMEOUT]\n`);
      return 1;
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
    throw new CliError(
      "usage: o2b search focus <set|status|clear> [--query Q] [--path P] [--session S]",
    );
  }
  const { flags } = parseFlags(argv.slice(1), {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    query: { type: "string" },
    path: { type: "string" },
    session: { type: "string" },
    "ttl-minutes": { type: "string", default: "120" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  // Session-scoped focus (t_5b478e47): --session binds the focus to
  // one session's file under search-focus/ instead of the global file.
  const session = typeof flags["session"] === "string" ? (flags["session"] as string) : undefined;

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
    writeSessionFocus(cfg, focus, session);
    writeFocusResponse(focus, flags["json"] === true);
    return 0;
  }

  if (action === "clear") {
    clearSessionFocus(cfg, session);
    writeFocusResponse(null, flags["json"] === true);
    return 0;
  }

  writeFocusResponse(readSessionFocus(cfg, Date.now(), session), flags["json"] === true);
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

// ─── feedback / weights (recall-trust-suite) ─────────────────────────────────

async function cmdSearchFeedback(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    query: { type: "string" },
    result: { type: "string" },
    verdict: { type: "string" },
    json: { type: "boolean" },
  });
  const query = typeof flags["query"] === "string" ? (flags["query"] as string) : "";
  const resultPath = typeof flags["result"] === "string" ? (flags["result"] as string) : "";
  const verdict = typeof flags["verdict"] === "string" ? (flags["verdict"] as string) : "";
  if (!query || !resultPath) {
    throw new CliError("usage: o2b search feedback --query <q> --result <path> --verdict up|down");
  }
  if (verdict !== "up" && verdict !== "down") {
    throw new CliError("--verdict must be 'up' or 'down'");
  }
  const cfg = resolveConfig(flags);
  const outcome = await captureRecallFeedback(cfg, { query, resultPath, verdict });
  if (flags["json"] === true) {
    process.stdout.write(
      JSON.stringify({
        recorded: true,
        result_found: outcome.resultFound,
        file: outcome.file,
        learned: outcome.learned,
      }) + "\n",
    );
    return 0;
  }
  const found = outcome.resultFound
    ? ""
    : " (result not in current top-50; recorded with zero contributions)";
  process.stdout.write(
    `recorded ${verdict} for ${resultPath}${found}\n` +
      `learned weights now: ${formatLearnedWeights(outcome.learned)}\n`,
  );
  return 0;
}

async function cmdSearchWeights(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    reset: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  if (flags["reset"] === true) {
    resetLearnedWeights(cfg.vault);
    if (flags["json"] === true) {
      process.stdout.write(JSON.stringify({ reset: true }) + "\n");
    } else {
      process.stdout.write("learned weights reset (feedback events kept)\n");
    }
    return 0;
  }
  const learned = readLearnedWeights(cfg.vault);
  const payload = {
    enabled: cfg.recall.learnedWeightsEnabled,
    base: {
      keywordWeight: cfg.keywordWeight,
      semanticWeight: cfg.semanticWeight,
    },
    learned,
    events: loadFeedbackEvents(cfg.vault).length,
    bounds: { min: LEARNED_WEIGHT_MIN, max: LEARNED_WEIGHT_MAX },
  };
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify(payload) + "\n");
    return 0;
  }
  const lines = [
    `learned weights: ${payload.enabled ? "enabled" : "disabled (search_learned_weights_enabled)"}`,
    `base: kw=${cfg.keywordWeight} sem=${cfg.semanticWeight}`,
    learned === null
      ? "learned: none (no feedback recorded)"
      : `learned: ${formatLearnedWeights(learned)} from ${learned.events} event(s)`,
    `bounds: [${LEARNED_WEIGHT_MIN}, ${LEARNED_WEIGHT_MAX}]`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function formatLearnedWeights(w: LearnedWeights): string {
  return (
    `kw=${w.keywordMul.toFixed(3)} sem=${w.semanticMul.toFixed(3)} ` +
    `ent=${w.entityMul.toFixed(3)} rec=${w.recencyMul.toFixed(3)}`
  );
}

// ─── provider registry (Embedding Provider Suite) ────────────────────────────

/** Structural shape shared by `ProviderProfile` and `RerankProviderProfile`. */
interface CliRegistryProfile {
  readonly name: string;
  readonly baseUrl: string;
  readonly defaultModel: string;
  readonly envKey: string | ReadonlyArray<string>;
}

/** Render an env-key that may be a single name or an ordered probe list. */
function formatEnvKey(envKey: string | ReadonlyArray<string>): string {
  return typeof envKey === "string" ? envKey : envKey.join(",");
}

/**
 * Parse a `--env-key` flag into a single name or an ordered probe list.
 * Accepts a comma-separated list so multi-key failover is CLI-registrable;
 * a single name stays a plain string (byte-identical single-key profile).
 */
function parseEnvKeyFlag(raw: string): string | string[] {
  const parts = raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  return parts.length <= 1 ? (parts[0] ?? "") : parts;
}

/**
 * CRUD operations a provider-style registry exposes to the CLI, plus the
 * naming used in usage/output strings. `verb` is the CLI subcommand name
 * (`provider` / `rerank-provider`); `kind` is the human noun used in prose
 * (`provider` / `rerank provider`).
 */
interface ProviderRegistryOps<T extends CliRegistryProfile> {
  readonly verb: string;
  readonly kind: string;
  readonly load: (vault: string) => ReadonlyArray<T>;
  readonly get: (vault: string, name: string) => T | null;
  readonly add: (vault: string, profile: CliRegistryProfile) => ReadonlyArray<T>;
  readonly remove: (vault: string, name: string) => { removed: boolean };
  /**
   * When true, `--env-key` accepts a comma-separated probe list for
   * multi-key failover (embedding provider only). Rerank stays single-key.
   */
  readonly multiKey?: boolean;
  /**
   * Curated model catalog surfaced via the `presets` action and used as the
   * `--model` default when omitted (embedding provider only). Advisory.
   */
  readonly presets?: ReadonlyArray<EmbeddingModelPreset>;
  /** Recommended default model string when `--model` is omitted. */
  readonly recommendedModel?: string;
}

/**
 * Shared `add|list|show|remove` dispatch for the provider and rerank-provider
 * registries (retrieval-precision-quality-loop, card A) - identical CRUD
 * shape over two structurally identical profile registries.
 */
async function runProviderRegistryCommand<T extends CliRegistryProfile>(
  argv: ReadonlyArray<string>,
  ops: ProviderRegistryOps<T>,
): Promise<number> {
  const { verb, kind } = ops;
  const action = argv[0];
  const allowed = ops.presets
    ? ["add", "list", "show", "remove", "presets"]
    : ["add", "list", "show", "remove"];
  if (!action || !allowed.includes(action)) {
    throw new CliError(
      `usage: o2b search ${verb} <add NAME --base-url U [--model M] --env-key K | list | show NAME | remove NAME${ops.presets ? " | presets" : ""}> [--json]`,
    );
  }
  const { flags, positional } = parseFlags(argv.slice(1), {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    "base-url": { type: "string" },
    model: { type: "string" },
    "env-key": { type: "string" },
    json: { type: "boolean" },
  });
  const json = flags["json"] === true;

  // `presets` is a static catalog listing; it needs no vault/config.
  if (action === "presets" && ops.presets) {
    if (json) {
      process.stdout.write(JSON.stringify(ops.presets) + "\n");
      return 0;
    }
    process.stdout.write(`curated embedding models (recommended: ${ops.recommendedModel}):\n`);
    for (const p of ops.presets) {
      const tag = p.multilingual ? "multilingual" : "monolingual";
      process.stdout.write(`  ${p.model}\n    dim=${p.dimension} ${tag} - ${p.note}\n`);
    }
    return 0;
  }

  const cfg = resolveConfig(flags);
  const name = typeof positional[0] === "string" ? positional[0] : undefined;

  if (action === "list") {
    const registry = ops.load(cfg.vault);
    if (json) {
      process.stdout.write(JSON.stringify(registry) + "\n");
      return 0;
    }
    if (registry.length === 0) {
      process.stdout.write(`no registered ${kind}s\n`);
      return 0;
    }
    for (const p of registry) {
      process.stdout.write(
        `${p.name}  ${p.baseUrl}  model=${p.defaultModel}  env=${formatEnvKey(p.envKey)}\n`,
      );
    }
    return 0;
  }

  if (action === "show") {
    if (!name) throw new CliError(`usage: o2b search ${verb} show NAME`);
    const profile = ops.get(cfg.vault, name);
    if (!profile) {
      process.stderr.write(`error: no registered ${kind} named '${name}'\n`);
      return 1;
    }
    process.stdout.write(
      json
        ? JSON.stringify(profile) + "\n"
        : `${profile.name}\n  base-url:  ${profile.baseUrl}\n  model:     ${profile.defaultModel}\n  env-key:   ${formatEnvKey(profile.envKey)}\n`,
    );
    return 0;
  }

  if (action === "remove") {
    if (!name) throw new CliError(`usage: o2b search ${verb} remove NAME`);
    const { removed } = ops.remove(cfg.vault, name);
    if (json) {
      process.stdout.write(JSON.stringify({ removed, name }) + "\n");
    } else {
      process.stdout.write(removed ? `removed ${kind} '${name}'\n` : `no such ${kind} '${name}'\n`);
    }
    return removed ? 0 : 1;
  }

  // add
  if (!name)
    throw new CliError(`usage: o2b search ${verb} add NAME --base-url U --model M --env-key K`);
  const baseUrl = typeof flags["base-url"] === "string" ? (flags["base-url"] as string) : undefined;
  const flagModel = typeof flags["model"] === "string" ? (flags["model"] as string) : undefined;
  const envKey = typeof flags["env-key"] === "string" ? (flags["env-key"] as string) : undefined;
  // `--model` may be omitted when the registry has a recommended default
  // (embedding provider); custom models remain first-class and verbatim.
  const model = flagModel ?? ops.recommendedModel;
  const modelHint = ops.recommendedModel ? "[--model M]" : "--model M";
  if (!baseUrl || !model || !envKey) {
    throw new CliError(
      `${verb} add requires --base-url, ${modelHint}, and --env-key (the env var NAME holding the API key)`,
    );
  }
  const envKeyValue = ops.multiKey ? parseEnvKeyFlag(envKey) : envKey;
  const registry = ops.add(cfg.vault, { name, baseUrl, defaultModel: model, envKey: envKeyValue });
  const added = registry.find((p) => p.name === name)!;
  if (json) {
    process.stdout.write(JSON.stringify(added) + "\n");
  } else {
    const envHint = Array.isArray(envKeyValue) ? envKeyValue.join(" or ") : envKeyValue;
    const modelNote = flagModel ? "" : ` (defaulted --model to recommended '${model}')`;
    process.stdout.write(
      `added ${kind} '${name}'${modelNote} (set ${envHint} in the environment to supply its key)\n`,
    );
  }
  return 0;
}

async function cmdSearchProvider(argv: ReadonlyArray<string>): Promise<number> {
  return runProviderRegistryCommand(argv, {
    verb: "provider",
    kind: "provider",
    load: loadProviderRegistry,
    get: getProviderProfile,
    add: addProviderProfile,
    remove: removeProviderProfile,
    multiKey: true,
    presets: EMBEDDING_MODEL_PRESETS,
    recommendedModel: RECOMMENDED_EMBEDDING_MODEL,
  });
}

// ─── rerank provider registry (retrieval-precision-quality-loop, card A) ─────

async function cmdSearchRerankProvider(argv: ReadonlyArray<string>): Promise<number> {
  return runProviderRegistryCommand(argv, {
    verb: "rerank-provider",
    kind: "rerank provider",
    load: loadRerankRegistry,
    get: getRerankProviderProfile,
    // Rerank stays single-key; coerce any probe-list shape back to a string.
    add: (vault, profile) =>
      addRerankProviderProfile(vault, { ...profile, envKey: formatEnvKey(profile.envKey) }),
    remove: removeRerankProviderProfile,
  });
}

// ─── rerank-fit (per-store reranker fit check diagnostic) ────────────────────

async function cmdSearchRerankFit(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    "max-queries": { type: "string" },
    "top-k": { type: "string" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);
  const maxQueries =
    typeof flags["max-queries"] === "string" ? Number(flags["max-queries"]) : undefined;
  const topK = typeof flags["top-k"] === "string" ? Number(flags["top-k"]) : undefined;
  if (maxQueries !== undefined && (!Number.isInteger(maxQueries) || maxQueries < 1)) {
    throw new CliError(`--max-queries must be a positive integer, got '${flags["max-queries"]}'`);
  }
  if (topK !== undefined && (!Number.isInteger(topK) || topK < 2)) {
    throw new CliError(`--top-k must be an integer >= 2, got '${flags["top-k"]}'`);
  }
  const report = await rerankFitCheck(cfg, {
    ...(maxQueries !== undefined ? { maxQueries } : {}),
    ...(topK !== undefined ? { topK } : {}),
  });
  if (flags["json"] === true) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        applicable: report.applicable,
        verdict: report.verdict,
        correlation: report.correlation,
        sampled_queries: report.sampledQueries,
        recommendation: report.recommendation,
        reason: report.reason,
      }) + "\n",
    );
    return 0;
  }
  process.stdout.write(`rerank fit: ${report.verdict}\n`);
  process.stdout.write(`  ${report.reason}\n`);
  if (report.correlation !== null) {
    process.stdout.write(
      `  correlation: ${report.correlation.toFixed(3)} over ${report.sampledQueries} query(ies)\n`,
    );
  }
  if (report.verdict !== "fits" && report.verdict !== "inapplicable") {
    process.stdout.write(`  recommendation: ${report.recommendation}\n`);
  }
  return 0;
}

// ─── plan (graph-index query pre-pass) ───────────────────────────────────────

async function cmdSearchPlan(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    hops: { type: "string", default: "2" },
    limit: { type: "string", default: "10" },
    "index-only": { type: "boolean" },
    json: { type: "boolean" },
  });
  const query = positional.join(" ").trim();
  if (query === "")
    throw new CliError('usage: o2b search plan "<query>" [--index-only] [--hops N]');
  const cfg = resolveConfig(flags);
  const maxHops = Number(flags["hops"] ?? "2");
  const shortlistLimit = Number(flags["limit"] ?? "10");
  if (!Number.isInteger(maxHops) || maxHops < 0) {
    throw new CliError(`--hops must be a non-negative integer, got '${flags["hops"]}'`);
  }
  if (!Number.isInteger(shortlistLimit) || shortlistLimit < 1) {
    throw new CliError(`--limit must be a positive integer, got '${flags["limit"]}'`);
  }
  const plan = await planRead(cfg, query, {
    indexOnly: flags["index-only"] === true,
    maxHops,
    shortlistLimit,
  });
  if (flags["json"] === true) {
    process.stdout.write(JSON.stringify(plan) + "\n");
    return 0;
  }
  process.stdout.write(`${plan.mode} (notes read: ${plan.notesRead})\n`);
  if (plan.shortlist.length === 0) {
    process.stdout.write("  no candidates\n");
    return 0;
  }
  for (const e of plan.shortlist) {
    const title = e.title ?? "(untitled)";
    process.stdout.write(
      `  ${e.path}  "${title}"  hops=${e.hops} degree=${e.degree} [${e.reasons.join(",")}]\n`,
    );
  }
  return 0;
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
    degree: { type: "string-array" },
    visibility: { type: "string-array" },
    "query-doc": { type: "string" },
    expand: { type: "boolean" },
    disclosure: { type: "string" },
    profile: { type: "string" },
    "evidence-pack": { type: "boolean" },
    "include-superseded": { type: "boolean" },
    since: { type: "string" },
    until: { type: "string" },
    global: { type: "boolean" },
    "no-record-access": { type: "boolean" },
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
  if (!Number.isInteger(limitNum) || limitNum < SEARCH_LIMIT_MIN || limitNum > SEARCH_LIMIT_MAX) {
    throw new CliError(`--limit must be an integer in ${SEARCH_LIMIT_MIN}..${SEARCH_LIMIT_MAX}`);
  }
  const disclosureRaw = typeof flags["disclosure"] === "string" ? flags["disclosure"] : undefined;
  if (disclosureRaw !== undefined && disclosureRaw !== "full" && disclosureRaw !== "cards") {
    throw new CliError("--disclosure must be 'full' or 'cards'");
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
  const degreeFilters = parseDegreeFlags(flags["degree"] as string[] | undefined);
  const visibility = flags["visibility"] as string[] | undefined;

  const searchOpts = {
    query,
    limit: limitNum,
    semantic: semanticOverride,
    keywordOnly: flags["keyword-only"] === true,
    pathPrefix: typeof flags["path"] === "string" ? (flags["path"] as string) : undefined,
    ...(properties !== undefined ? { properties } : {}),
    ...(degreeFilters !== undefined ? { degreeFilters } : {}),
    ...(visibility !== undefined && visibility.length > 0 ? { visibility } : {}),
    ...(structuredQuery !== undefined ? { structuredQuery } : {}),
    ...(flags["expand"] === true ? { expand: true } : {}),
    ...(disclosureRaw === "cards" ? { disclosure: "cards" as const } : {}),
    ...(typeof flags["profile"] === "string" ? { profile: flags["profile"] as string } : {}),
    ...(flags["evidence-pack"] === true ? { evidencePack: true } : {}),
    ...(flags["include-superseded"] === true ? { includeSuperseded: true } : {}),
    ...(typeof flags["since"] === "string" ? { since: flags["since"] as string } : {}),
    ...(typeof flags["until"] === "string" ? { until: flags["until"] as string } : {}),
    // Access recording (Time-Aware Recall & Activation Suite): the CLI
    // surface opts in by default; --no-record-access suppresses it, and
    // cross-vault union never records (results span foreign vaults).
    ...(flags["global"] !== true && flags["no-record-access"] !== true
      ? { recordAccess: true }
      : {}),
  };
  // Cross-vault union (t_72a22658): explicit per-call opt-in fans the
  // query out over profiles and read-only sources with origin labels.
  const outcome =
    flags["global"] === true
      ? await searchAcrossVaults(
          typeof flags["config"] === "string" ? (flags["config"] as string) : defaultConfigPath(),
          cfg.vault,
          searchOpts,
          cfg,
        )
      : await search(cfg, searchOpts);

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

/**
 * Parse the repeatable `--degree <field><op><count>` flag into the
 * `degreeFilters` predicate list that `search()` consumes, e.g.
 * `--degree backlinks=0` (orphans) or `--degree outlinks>=5` (hubs).
 * Invalid syntax throws a typed `SearchError` from
 * {@link parseDegreePredicate}, surfaced by the search verb's error
 * handler as exit 2.
 */
function parseDegreeFlags(raw: ReadonlyArray<string> | undefined): DegreePredicate[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  return raw.map((entry) => parseDegreePredicate(entry));
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
      // Conversation chronology (S1): present only for a note carrying an
      // authored_at instant, so the shape stays byte-identical otherwise.
      ...(r.authoredAt !== undefined ? { authored_at: r.authoredAt } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(o.evidencePack ? { why_retrieved: r.reasons } : {}),
      document_id: r.documentId,
      chunk_id: r.chunkId,
      ...(r.relations && r.relations.length > 0 ? { relations: r.relations } : {}),
    })),
    warnings: o.warnings,
    total: o.total,
    ...(o.cards ? { cards: o.cards.map(serializeSearchCard) } : {}),
    ...(o.evidencePack ? { evidence_pack: serializeEvidencePack(o.evidencePack) } : {}),
  };
}

function renderOutcomeHuman(o: SearchOutcome, verbose: boolean): string {
  // Progressive disclosure layer 1: render compact cards. The agent
  // drills a hit with `o2b search expand --chunk <chunk_id>`.
  if (o.cards !== undefined) {
    const lines: string[] = [];
    if (o.cards.length === 0) lines.push("(no results)");
    o.cards.forEach((c, i) => {
      const originSuffix = c.origin !== undefined ? `  •  ${c.origin}` : "";
      lines.push(`[${i + 1}] ${c.pointer}  •  ${c.score.toFixed(2)}${originSuffix}`);
      lines.push(`    ${c.snippet}`);
      lines.push(`    expand: o2b search expand --chunk ${c.chunkId}`);
      if (verbose && c.reasons.length > 0) lines.push(`    why: ${c.reasons.join(", ")}`);
      lines.push("");
    });
    for (const w of o.warnings) lines.push(`warning: ${w}`);
    return lines.join("\n") + (lines.length > 0 ? "" : "\n");
  }
  const lines: string[] = [];
  if (o.results.length === 0) {
    lines.push("(no results)");
  }
  o.results.forEach((r, i) => {
    const score = r.score.toFixed(2);
    const originSuffix = r.origin !== undefined ? `  •  ${r.origin}` : "";
    lines.push(`[${i + 1}] ${r.path}  •  ${score}${originSuffix}`);
    // Conversation chronology (S1): show the authoring instant only for a
    // note that carries one; a note without stays byte-identical.
    const authoredSuffix =
      r.authoredAt !== undefined
        ? `  •  authored ${new Date(r.authoredAt * 1000).toISOString()}`
        : "";
    lines.push(
      `    line ${r.startLine}-${r.endLine}  •  ${r.searchType}${authoredSuffix}` +
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

// ─── expand ───────────────────────────────────────────────────────────────────

/**
 * Progressive disclosure layers 2 + 3: drill a layer-1 card (from
 * `o2b search --disclosure cards`) into the fuller note and the paginated
 * raw chunk transcript. Read-only; never rebuilds the index.
 */
async function cmdSearchExpand(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    chunk: { type: "string" },
    "raw-limit": { type: "string" },
    cursor: { type: "string" },
    json: { type: "boolean" },
  });
  const chunkId = Number(flags["chunk"]);
  if (!Number.isInteger(chunkId) || chunkId < 1) {
    throw new CliError("--chunk must be a positive integer chunk id (from a card)");
  }
  let rawLimit: number | undefined;
  if (typeof flags["raw-limit"] === "string") {
    rawLimit = Number(flags["raw-limit"]);
    if (!Number.isInteger(rawLimit) || rawLimit < 1) {
      throw new CliError("--raw-limit must be a positive integer");
    }
  }
  const cfg = resolveConfig(flags);
  let result;
  try {
    result = await expandHit(cfg, {
      chunkId,
      ...(rawLimit !== undefined ? { rawLimit } : {}),
      ...(typeof flags["cursor"] === "string" ? { cursor: flags["cursor"] as string } : {}),
    });
  } catch (e) {
    if (e instanceof SearchError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
  if (flags["json"]) {
    process.stdout.write(
      JSON.stringify({
        chunk_id: result.chunkId,
        note: {
          document_id: result.note.documentId,
          path: result.note.path,
          title: result.note.title,
          line_start: result.note.lineStart,
          line_end: result.note.lineEnd,
          pointer: result.note.pointer,
          content: result.note.content,
        },
        raw_content: result.raw_content.map((c) => ({
          chunk_id: c.chunkId,
          chunk_index: c.chunkIndex,
          start_line: c.startLine,
          end_line: c.endLine,
          pointer: c.pointer,
          content: c.content,
        })),
        next_cursor: result.next_cursor,
      }) + "\n",
    );
    return 0;
  }
  const lines: string[] = [];
  lines.push(`note: ${result.note.pointer}`);
  if (result.note.title !== null) lines.push(`title: ${result.note.title}`);
  lines.push("");
  lines.push(result.note.content);
  lines.push("");
  lines.push(`── raw chunks (${result.raw_content.length}) ──`);
  for (const c of result.raw_content) {
    lines.push(`[${c.pointer}]`);
    lines.push(c.content);
    lines.push("");
  }
  if (result.next_cursor !== null) {
    lines.push(`more: o2b search expand --chunk ${result.chunkId} --cursor ${result.next_cursor}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

// ─── index ────────────────────────────────────────────────────────────────────

async function cmdSearchIndex(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    embeddings: { type: "boolean" },
    force: { type: "boolean" },
    "force-cost": { type: "boolean" },
    concurrency: { type: "string" },
    verbose: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cfg = resolveConfig(flags);

  const events: IndexProgressEvent[] = [];
  const safeguard = createSafeguard({
    operation: "reindex",
    timeoutMs: resolveSafeguardTimeoutMs("reindex", flags["config"] as string | undefined),
  });
  const stats = await indexVault(cfg, {
    safeguard,
    embeddings: flags["embeddings"] === true,
    force: flags["force"] === true,
    forceCost: flags["force-cost"] === true,
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

// ─── watch ──────────────────────────────────────────────────────────────────

/**
 * Long-running file-watcher (Unit 3): watch the vault for `.md` edits and
 * incrementally re-index after a quiet window. Reuses the existing
 * incremental `indexVault` (mtime/hash fastpath skips unchanged files),
 * so a debounced flush only does work for the files that actually
 * changed. A single-flight guard prevents overlapping passes; the
 * command runs until SIGINT/SIGTERM and shuts the watcher down cleanly.
 */
async function cmdSearchWatch(argv: ReadonlyArray<string>): Promise<number> {
  const { flags } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    db: { type: "string" },
    embeddings: { type: "boolean" },
    "debounce-ms": { type: "string", default: "800" },
  });
  const cfg = resolveConfig(flags);
  const debounceMs = Number(flags["debounce-ms"]);
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new CliError(`--debounce-ms must be a non-negative number, got ${flags["debounce-ms"]}`);
  }
  const planner = new IndexWatchPlanner({ debounceMs });

  let watcher: FSWatcher;
  try {
    watcher = watch(cfg.vault, { recursive: true, persistent: true });
  } catch (e) {
    // Fail loudly, not as a silent no-op: recursive fs.watch is not
    // available on every platform/filesystem.
    throw new CliError(
      `cannot start a recursive watch on ${cfg.vault}: ${e instanceof Error ? e.message : String(e)}. ` +
        "Recursive fs.watch is unsupported here; schedule `o2b search index` on a timer instead.",
    );
  }

  // Single-flight + graceful-shutdown coordinator (Indexer Durability
  // suite). A SIGINT/SIGTERM aborts the in-flight pass at its next file
  // boundary and waits for it to settle (bounded by the configured
  // grace window) before exiting, so a signal never kills a run
  // mid-write. indexInto closes its store in a finally, so the aborted
  // pass still consolidates the WAL and releases the writer lock.
  const runner = new IndexWatchRunner({
    graceMs: cfg.shutdownGraceMs,
    index: async (signal): Promise<void> => {
      const due = planner.take(Date.now());
      if (due.length === 0) return;
      try {
        const stats = await indexVault(cfg, { embeddings: flags["embeddings"] === true, signal });
        process.stderr.write(
          `synced ${due.length} change(s): +${stats.added} ~${stats.updated} =${stats.unchanged}` +
            (stats.errors.length > 0 ? ` (${stats.errors.length} error(s))` : "") +
            "\n",
        );
      } catch (e) {
        // An abort is the expected stop on shutdown - let the runner
        // observe it. Any other failure must not kill the watcher.
        if (e instanceof SafeguardAbortError) throw e;
        process.stderr.write(`index sync failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  });

  watcher.on("error", (e) => {
    process.stderr.write(`watch error: ${e instanceof Error ? e.message : String(e)}\n`);
  });
  watcher.on("change", (_eventType, filename) => {
    if (typeof filename !== "string") return;
    if (!filename.toLowerCase().endsWith(".md")) return;
    planner.record(canonicalNotePath(filename), Date.now());
  });

  const timer = setInterval(
    () => {
      void runner.flush();
    },
    Math.max(50, debounceMs),
  );

  return await new Promise<number>((resolve) => {
    const shutdown = async (): Promise<void> => {
      if (runner.isStopped) return;
      clearInterval(timer);
      watcher.close();
      // Drain the in-flight pass (aborted) within the grace window.
      // A second SIGINT/SIGTERM bypasses this (process.once consumed
      // the first), falling back to the default terminate = force exit.
      await runner.shutdown();
      process.stderr.write("watch stopped\n");
      resolve(0);
    };
    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
    process.stderr.write(
      `watching ${cfg.vault} for .md changes (debounce ${debounceMs}ms); Ctrl-C to stop\n`,
    );
  });
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
    "force-cost": { type: "boolean" },
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
    safeguard: createSafeguard({
      operation: "reindex",
      timeoutMs: resolveSafeguardTimeoutMs("reindex", flags["config"] as string | undefined),
    }),
    embeddings: flags["embeddings"] === true,
    forceCost: flags["force-cost"] === true,
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
    process.stdout.write(JSON.stringify(serializeIndexStatus(status)) + "\n");
    return 0;
  }
  process.stdout.write(renderStatusHuman(status));
  return 0;
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

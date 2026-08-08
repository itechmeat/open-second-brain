/**
 * `o2b search "<query>"` — the default verb: flags to `SearchOptions`,
 * one call into the core search (or the cross-vault union), and the
 * rendered outcome.
 */

import {
  indexVault,
  parseStructuredRecallQueryDocument,
  search,
  structuredRecallQueryText,
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
} from "../../../core/search/index.ts";
import { searchAcrossVaults } from "../../../core/search/cross-vault.ts";
import {
  parseDegreePredicate,
  type DegreePredicate,
} from "../../../core/search/property-filter.ts";
import { jsonForOutcome, renderOutcomeHuman } from "../outcome-render.ts";
import {
  CliError,
  flagBoolean,
  flagString,
  isIntegerWithin,
  parseFlags,
  resolveConfig,
  resolveConfigPath,
  VAULT_FLAGS,
} from "../helpers.ts";

/** Both malformed `--property` shapes report the same way. */
function propertyFormatError(entry: string): CliError {
  return new CliError(`--property must be KEY=VALUE, got: ${entry}`);
}

export async function cmdSearchQuery(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    ...VAULT_FLAGS,
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
    "agent-scope": { type: "string" },
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
    explain: { type: "boolean" },
  });

  const rawQueryDocument = flagString(flags, "query-doc");
  const structuredQuery =
    rawQueryDocument !== undefined
      ? parseStructuredRecallQueryDocument(rawQueryDocument)
      : undefined;

  if (positional.length === 0 && structuredQuery === undefined) {
    throw new CliError("query string is required");
  }
  if (flagBoolean(flags, "semantic") && flagBoolean(flags, "keyword-only")) {
    throw new CliError("--semantic and --keyword-only are mutually exclusive");
  }
  const query =
    positional.length > 0 ? positional.join(" ") : structuredRecallQueryText(structuredQuery!);
  if (query.trim().length === 0) {
    throw new CliError("query string is required when --query-doc has no searchable lanes");
  }
  const limitNum = Number(flags["limit"] ?? "10");
  if (!isIntegerWithin(limitNum, { min: SEARCH_LIMIT_MIN, max: SEARCH_LIMIT_MAX })) {
    throw new CliError(`--limit must be an integer in ${SEARCH_LIMIT_MIN}..${SEARCH_LIMIT_MAX}`);
  }
  const disclosureRaw = flagString(flags, "disclosure");
  if (disclosureRaw !== undefined && disclosureRaw !== "full" && disclosureRaw !== "cards") {
    throw new CliError("--disclosure must be 'full' or 'cards'");
  }

  const cfg = resolveConfig(flags);

  if (flagBoolean(flags, "auto-refresh")) {
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
  const semanticOverride: boolean | undefined = flagBoolean(flags, "semantic")
    ? true
    : flagBoolean(flags, "keyword-only")
      ? false
      : undefined;

  const properties = parsePropertyFlags(flags["property"] as string[] | undefined);
  const degreeFilters = parseDegreeFlags(flags["degree"] as string[] | undefined);
  const visibility = flags["visibility"] as string[] | undefined;
  const agentScope = flagString(flags, "agent-scope");
  const profile = flagString(flags, "profile");
  const since = flagString(flags, "since");
  const until = flagString(flags, "until");
  const isGlobal = flagBoolean(flags, "global");

  const searchOpts = {
    query,
    limit: limitNum,
    semantic: semanticOverride,
    keywordOnly: flagBoolean(flags, "keyword-only"),
    pathPrefix: flagString(flags, "path"),
    ...(properties !== undefined ? { properties } : {}),
    ...(degreeFilters !== undefined ? { degreeFilters } : {}),
    ...(visibility !== undefined && visibility.length > 0 ? { visibility } : {}),
    // Owner-scope isolation (context-integrity-gates, Unit A): an
    // owner-private page is returned only to its own scope. Omitting the
    // flag applies no ownership filtering at all.
    ...(agentScope !== undefined ? { agentScope } : {}),
    ...(structuredQuery !== undefined ? { structuredQuery } : {}),
    ...(flagBoolean(flags, "expand") ? { expand: true } : {}),
    ...(disclosureRaw === "cards" ? { disclosure: "cards" as const } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(flagBoolean(flags, "evidence-pack") ? { evidencePack: true } : {}),
    ...(flagBoolean(flags, "include-superseded") ? { includeSuperseded: true } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    // Access recording (Time-Aware Recall & Activation Suite): the CLI
    // surface opts in by default; --no-record-access suppresses it, and
    // cross-vault union never records (results span foreign vaults).
    ...(!isGlobal && !flagBoolean(flags, "no-record-access") ? { recordAccess: true } : {}),
  };
  // Cross-vault union (t_72a22658): explicit per-call opt-in fans the
  // query out over profiles and read-only sources with origin labels.
  const outcome = isGlobal
    ? await searchAcrossVaults(resolveConfigPath(flags), cfg.vault, searchOpts, cfg)
    : await search(cfg, searchOpts);

  // Retrieval receipts (what-the-index-already-knew, task F): --explain
  // appends the decision trace and the trust assessment the search
  // already built. Omitted, both projections are byte-identical to the
  // pre-flag ones.
  const explainOptions = {
    explain: flagBoolean(flags, "explain"),
    crossVault: isGlobal,
    trustGateEnabled: cfg.recall.retrievalTrustGateEnabled,
  };

  if (flagBoolean(flags, "json")) {
    process.stdout.write(JSON.stringify(jsonForOutcome(outcome, explainOptions)) + "\n");
    return 0;
  }
  process.stdout.write(
    renderOutcomeHuman(outcome, flagBoolean(flags, "verbose"), query, explainOptions),
  );
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
      throw propertyFormatError(entry);
    }
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (key.length === 0 || value.length === 0) {
      throw propertyFormatError(entry);
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

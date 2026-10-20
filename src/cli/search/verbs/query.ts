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
import type { SearchLaneTiming } from "../../../core/search/index.ts";
import { SEARCH_OPTION_ROWS } from "../../../core/search/search-options-descriptor.ts";
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
import { CLI_TRANSPORT_REACH } from "../../transport-reach.ts";
import { FTS_MATCH_MODES, isFtsMatchMode } from "../../../core/search/fts-match-mode.ts";
import { SEARCH_KINDS, isSearchKind } from "../../../core/search/property-pushdown.ts";
import {
  DISCLOSURE_MODE,
  DISCLOSURE_MODES,
  isDisclosureMode,
} from "../../../core/search/disclosure-mode.ts";

/** Both malformed `--property` shapes report the same way. */
function propertyFormatError(entry: string): CliError {
  return new CliError(`--property must be KEY=VALUE, got: ${entry}`);
}

/** The flags that belong to this verb's output and refresh behavior, not to the search language. */
const VERB_LOCAL_FLAGS: Readonly<Record<string, QueryFlagSpec>> = Object.freeze({
  "auto-refresh": { type: "boolean" },
  json: { type: "boolean" },
  verbose: { type: "boolean" },
});

/** The parser spec one flag carries - the verb's local spell of `FlagSpec`. */
interface QueryFlagSpec {
  readonly type: "string" | "boolean" | "string-array";
  readonly default?: string;
}

/**
 * The query verb's flag table, DERIVED from the search-options descriptor
 * (t_50c81d5c): one entry per cli-visible row, keyed by the row's declared
 * CLI spelling (`path_prefix` spells `--path`, `query_document` spells
 * `--query-doc`, `properties` the repeatable `--property`,
 * `record_access` its `cliNegates` inverse `--no-record-access`), with the
 * row's CLI parse kind. The served schema and this table are now two
 * projections of one table, so a flag cannot appear on one surface and
 * silently vanish from the other.
 *
 * Per-surface bounds stay where they are: the CLI limit keeps its
 * `SEARCH_LIMIT_MIN..SEARCH_LIMIT_MAX` bind at the read site (the MCP
 * schema's `MCP_LIMIT_MAX` is a different, deliberate edge), the query
 * stays uncapped here, and `semantic` stays the documented tri-state
 * asymmetry (the verb body passes `undefined` when no lane flag is given).
 * A row whose documented default is a bare integer carries it as the
 * parser default (`limit` -> "10"); prose defaults mean absent.
 */
export const SEARCH_QUERY_FLAGS: Readonly<Record<string, QueryFlagSpec>> = Object.freeze(
  (() => {
    const derived: Record<string, QueryFlagSpec> = {};
    for (const row of SEARCH_OPTION_ROWS) {
      if (!row.surfaces.includes("cli") || row.cliFlag === null) continue;
      // A pure-integer documented default is a parse default; prose ("absent:
      // ...", "false", "all") stays absent, exactly as the literal table did.
      derived[row.cliFlag] = /^\d+$/.test(row.default)
        ? { type: row.cliKind, default: row.default }
        : { type: row.cliKind };
    }
    return { ...VAULT_FLAGS, ...derived, ...VERB_LOCAL_FLAGS };
  })(),
);

export async function cmdSearchQuery(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, SEARCH_QUERY_FLAGS);

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
  if (disclosureRaw !== undefined && !isDisclosureMode(disclosureRaw)) {
    throw new CliError(`--disclosure must be one of ${DISCLOSURE_MODES.join(", ")}`);
  }
  const matchModeRaw = flagString(flags, "match-mode");
  if (matchModeRaw !== undefined && !isFtsMatchMode(matchModeRaw)) {
    throw new CliError(`--match-mode must be one of ${FTS_MATCH_MODES.join(", ")}`);
  }
  const matchMode = matchModeRaw;
  const kindRaw = flagString(flags, "kind");
  if (kindRaw !== undefined && !isSearchKind(kindRaw)) {
    throw new CliError(`--kind must be one of ${SEARCH_KINDS.join(", ")}`);
  }
  const kind = kindRaw;

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

  // Overlapped-lane timing (recall-lane-latency): captured only when
  // --explain asks and only on the single-vault path - a cross-vault
  // union merges one search per origin and no honest single figure
  // exists for it. Omitted, the pipeline records nothing and every
  // projection stays byte-identical.
  const captureTiming = flagBoolean(flags, "explain") && !isGlobal;
  let laneTiming: SearchLaneTiming | undefined;
  const searchOpts = {
    query,
    limit: limitNum,
    semantic: semanticOverride,
    keywordOnly: flagBoolean(flags, "keyword-only"),
    pathPrefix: flagString(flags, "path"),
    ...(kind !== undefined ? { kind } : {}),
    ...(matchMode !== undefined ? { matchMode } : {}),
    ...(properties !== undefined ? { properties } : {}),
    ...(degreeFilters !== undefined ? { degreeFilters } : {}),
    ...(visibility !== undefined && visibility.length > 0 ? { visibility } : {}),
    // The operator's own shell against the operator's own vault; carried
    // into the cross-vault union below on the same options object, so a
    // federated CLI query is bound by the same rule.
    transportReach: CLI_TRANSPORT_REACH,
    // Owner-scope isolation (context-integrity-gates, Unit A): an
    // owner-private page is returned only to its own scope. Omitting the
    // flag applies no ownership filtering at all.
    ...(agentScope !== undefined ? { agentScope } : {}),
    ...(structuredQuery !== undefined ? { structuredQuery } : {}),
    ...(flagBoolean(flags, "expand") ? { expand: true } : {}),
    ...(disclosureRaw === DISCLOSURE_MODE.cards ? { disclosure: disclosureRaw } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(flagBoolean(flags, "evidence-pack") ? { evidencePack: true } : {}),
    ...(flagBoolean(flags, "include-superseded") ? { includeSuperseded: true } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    // Access recording (Time-Aware Recall & Activation Suite): the CLI
    // surface opts in by default; --no-record-access suppresses it, and
    // cross-vault union never records (results span foreign vaults).
    ...(!isGlobal && !flagBoolean(flags, "no-record-access") ? { recordAccess: true } : {}),
    ...(captureTiming
      ? { laneTiming: (timing: SearchLaneTiming) => void (laneTiming = timing) }
      : {}),
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
    // Engaged means the resolved mode is not off - the legacy boolean
    // alone cannot answer that (an explicit search_trust_gate_mode runs
    // the gate with the boolean left false).
    trustGateEnabled: cfg.recall.searchTrustGateMode !== undefined,
  };

  if (flagBoolean(flags, "json")) {
    process.stdout.write(
      JSON.stringify(jsonForOutcome(outcome, explainOptions, laneTiming)) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    renderOutcomeHuman(outcome, flagBoolean(flags, "verbose"), query, explainOptions, laneTiming),
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

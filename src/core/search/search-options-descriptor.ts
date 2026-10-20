/**
 * The search-options descriptor (t_50c81d5c substrate): one typed row per
 * caller-facing field of the search language, declared once.
 *
 * The repo used to carry four hand-parallel copies of the brain_search
 * input contract - the served MCP schema (`SEARCH_INPUT_SCHEMA` in
 * `src/mcp/search-tools.ts`), the CLI `parseFlags` table
 * (`src/cli/search/verbs/query.ts`), the `SearchOptions` type
 * (`./types.ts`), and a vendored Python projection
 * (`plugins/hermes/_schemas.py`). Nothing connected them, so schema and
 * enforcement (and flag table and type) could drift independently. This
 * table is the single source of truth the copies now derive from:
 *
 *   - the MCP schema is the mcp-visible projection
 *     ({@link deriveSearchInputSchema}), pinned byte-identical to the
 *     pre-derivation literal by
 *     `tests/core/search/search-query-schema-artifact.test.ts`;
 *   - the CLI flag table derives from the cli-visible rows (snake_case
 *     name to kebab-case flag, mechanically) - the verb-local flags
 *     (`json`, `verbose`, `auto-refresh`) stay local to the verb;
 *   - the vendored projection stays untouched because day-one identity
 *     is byte-identity.
 *
 * ## Compile-time parity
 *
 * {@link SearchOptionRow.option} is typed `keyof SearchOptions | null`, so
 * a row that names a phantom option is a `tsc` error, not a runtime
 * surprise - the `satisfies`-style assertion the card asked for, made
 * structural by the row type itself. `null` is honest, not a loophole: it
 * marks a boundary-only argument (`explain`, `telemetry`, `global`) that
 * drives output or routing at the surface and never enters the core
 * options. The reverse direction - no caller-facing `SearchOptions` field
 * missing a row - is a runtime test in
 * `tests/core/search/search-query-schema-artifact.test.ts`.
 *
 * ## What this table deliberately does NOT reconcile
 *
 * The per-surface asymmetries are recorded, not flattened: the MCP
 * surface keeps `MCP_LIMIT_MAX` where the CLI keeps `SEARCH_LIMIT_MAX`,
 * the CLI query is uncapped where MCP caps at {@link MCP_QUERY_MAX_CHARS},
 * `path_prefix` spells `--path` and `record_access` spells
 * `--no-record-access` (the {@link SearchOptionRow.cliNegates} inverse) on
 * the CLI, and `semantic` is tri-state over MCP but deliberately
 * undefined-passing over the CLI. Flattening any of these would change a
 * frozen public surface; the rows say exactly where the edges are.
 */

import type { SearchOptions } from "./types.ts";
import { DISCLOSURE_MODES } from "./disclosure-mode.ts";
import { FTS_MATCH_MODES } from "./fts-match-mode.ts";
import { RECALL_PROFILE_NAMES } from "./profiles.ts";
import { SEARCH_KINDS } from "./property-pushdown.ts";

/** The longest `query` the served brain_search schema advertises, enforced by its handler. */
export const MCP_QUERY_MAX_CHARS = 2000;

/** The largest `limit` the served brain_search schema advertises; the CLI keeps `SEARCH_LIMIT_MAX`. */
export const MCP_LIMIT_MAX = 50;

/** The wire surface a row reaches. A row on neither is internal documentation. */
export type SearchOptionSurface = "mcp" | "cli";

/** How the CLI flag parses. `string-array` is a repeatable flag. */
export type SearchOptionCliKind = "boolean" | "string" | "string-array";

/**
 * The JSON Schema fragment one argument serves. Only the shapes the
 * brain_search language actually uses are expressible - a new shape is a
 * decision to extend this type, not a place to smuggle in an unchecked
 * keyword.
 */
export interface SearchOptionSchemaFragment {
  readonly type: "string" | "boolean" | "integer" | "number" | "array" | "object";
  readonly enum?: ReadonlyArray<string>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly maxItems?: number;
  readonly items?: Readonly<Record<string, unknown>>;
  readonly additionalProperties?: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** One caller-facing field of the search language. */
export interface SearchOptionRow {
  /** Canonical snake_case name - the MCP argument spelling. */
  readonly name: string;
  /**
   * The `SearchOptions` key this row feeds, or `null` for a
   * boundary-only argument. THE compile-time parity assertion: any other
   * spelling is refused by `tsc`.
   */
  readonly option: keyof SearchOptions | null;
  /** Present exactly on the one required argument. */
  readonly required?: true;
  /** The fragment the MCP surface serves for the argument. */
  readonly schema: SearchOptionSchemaFragment;
  /** CLI flag spelling, dashes omitted, or `null` when the CLI cannot reach it. */
  readonly cliFlag: string | null;
  /** How {@link cliFlag} parses. */
  readonly cliKind: SearchOptionCliKind;
  /** True when the CLI flag is the INVERSE sense of the option (`--no-record-access`). */
  readonly cliNegates?: true;
  /** The surfaces the argument is visible on. */
  readonly surfaces: ReadonlyArray<SearchOptionSurface>;
  /** The documented default, as the served description states it. */
  readonly default: string;
}

/**
 * Every caller-facing field of the search language, in the order the
 * served schema declares them. The three cli-only rows close the table:
 * they back `SearchOptions` fields the served MCP schema omits, and their
 * fragments are documentation (they never reach the mcp projection).
 */
export const SEARCH_OPTION_ROWS: ReadonlyArray<SearchOptionRow> = Object.freeze([
  {
    name: "query",
    option: "query",
    required: true,
    schema: {
      type: "string",
      minLength: 1,
      maxLength: MCP_QUERY_MAX_CHARS,
      description:
        "What to recall from the vault. Matched against the index by keyword, semantics, or both.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "required; the CLI takes it positionally",
  },
  {
    name: "query_document",
    option: "structuredQuery",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "Line-oriented query program with intent:, lex:, vec: and hyde: lanes, steering each retrieval layer separately. Absent means 'query' drives every lane.",
    },
    cliFlag: "query-doc",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: 'query' drives every lane",
  },
  {
    name: "focus_query",
    option: "sessionFocus",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description:
        "Steer this one call towards a working-set topic without persisting a session focus.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent: the persisted focus applies",
  },
  {
    name: "focus_path_prefix",
    option: "sessionFocus",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Steer this one call towards a vault subtree, paired with focus_query as a transient focus.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "focus_session",
    option: "focusSession",
    schema: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Session id whose bound focus applies (falls back to the global focus).",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent: the global focus",
  },
  {
    name: "evidence_pack",
    option: "evidencePack",
    schema: {
      type: "boolean",
      description:
        "Return the evidence pack: matched/missing terms, coverage, abstention text and the false-absence guard. Default false.",
    },
    cliFlag: "evidence-pack",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "false",
  },
  {
    name: "include_superseded",
    option: "includeSuperseded",
    schema: {
      type: "boolean",
      description:
        "History mode for relation polarity: keep matched superseded predecessors undemoted and skip successor pull-in. Default false.",
    },
    cliFlag: "include-superseded",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "false",
  },
  {
    name: "since",
    option: "since",
    schema: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/after this point. ISO date/datetime, today, yesterday, last week, last month, <n>h/<n>d/<n>w.",
    },
    cliFlag: "since",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: no time filter",
  },
  {
    name: "until",
    option: "until",
    schema: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/before this point. Same forms as 'since'.",
    },
    cliFlag: "until",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: no time filter",
  },
  {
    name: "limit",
    option: "limit",
    schema: {
      type: "integer",
      minimum: 1,
      maximum: MCP_LIMIT_MAX,
      description: "How many ranked results to return. Default 10.",
    },
    cliFlag: "limit",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "10",
  },
  {
    name: "semantic",
    option: "semantic",
    schema: {
      type: "boolean",
      description:
        "Force the semantic lane on or off. Absent lets the configured hybrid strategy decide.",
    },
    cliFlag: "semantic",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "absent: the configured hybrid strategy decides",
  },
  {
    name: "keyword_only",
    option: "keywordOnly",
    schema: {
      type: "boolean",
      description: "Skip the semantic lane entirely, so no embedding is needed. Default false.",
    },
    cliFlag: "keyword-only",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "false",
  },
  {
    name: "match_mode",
    option: "matchMode",
    schema: {
      type: "string",
      enum: [...FTS_MATCH_MODES],
      description:
        "FTS match breadth: 'all' (default) requires every term; 'any' matches a document carrying any one term. Absent leaves the implicit AND.",
    },
    cliFlag: "match-mode",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "all",
  },
  {
    name: "disclosure",
    option: "disclosure",
    schema: {
      type: "string",
      enum: [...DISCLOSURE_MODES],
      description:
        "Result depth: 'full' (default) returns full chunk content; 'cards' returns token-cheap layer-1 cards — drill a hit with brain_search_expand.",
    },
    cliFlag: "disclosure",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "full",
  },
  {
    name: "profile",
    option: "profile",
    schema: {
      type: "string",
      enum: [...RECALL_PROFILE_NAMES],
      description:
        "Named recall profile (fast|balanced|thorough): a fixed knob preset, preferred over persisted self-tuning. Absent leaves ranking unchanged.",
    },
    cliFlag: "profile",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: ranking unchanged",
  },
  {
    name: "explain",
    option: null,
    schema: {
      type: "boolean",
      description:
        "Add a per-result score_breakdown plus the retrieval_decision_trace and memory_trust_assessment receipts. Default false.",
    },
    cliFlag: "explain",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "false",
  },
  {
    name: "trust",
    option: "trust",
    schema: {
      type: "boolean",
      description:
        "Stamp each result with inline trust metadata (age_days, superseded, conflict), computed at read time. Default false.",
    },
    cliFlag: null,
    cliKind: "boolean",
    surfaces: ["mcp"],
    default: "false",
  },
  {
    name: "threshold",
    option: "threshold",
    schema: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Relevance floor in [0,1] on the final score; drops weaker hits so an irrelevant query returns no match. Default 0 (disabled).",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "0 (disabled)",
  },
  {
    name: "rerank",
    option: "rerank",
    schema: {
      type: "boolean",
      description:
        "Re-order the threshold-qualified results by core textual relevance (keyword + semantic). Default false.",
    },
    cliFlag: null,
    cliKind: "boolean",
    surfaces: ["mcp"],
    default: "false",
  },
  {
    name: "reinforce",
    option: "reinforce",
    schema: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description:
        "Paths proven useful: recorded to the reinforce ledger and lifted (bounded) before the top_k cut. Default absent.",
    },
    cliFlag: null,
    cliKind: "string-array",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "record_access",
    option: "recordAccess",
    schema: {
      type: "boolean",
      description:
        "Record the surfaced paths as one activation access event (feeds the usage-aware ranking layer). Default true; never recorded for global searches.",
    },
    cliFlag: "no-record-access",
    cliKind: "boolean",
    cliNegates: true,
    surfaces: ["mcp", "cli"],
    default: "true",
  },
  {
    name: "global",
    option: null,
    schema: {
      type: "boolean",
      description:
        "Cross-vault union: search profile vaults and read-only recall sources too, merging results with origin labels. Default false (active vault only).",
    },
    cliFlag: "global",
    cliKind: "boolean",
    surfaces: ["mcp", "cli"],
    default: "false (active vault only)",
  },
  {
    name: "path_prefix",
    option: "pathPrefix",
    schema: {
      type: "string",
      maxLength: 256,
      description: "Restrict results to this vault subtree. Absent searches the whole vault.",
    },
    cliFlag: "path",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: the whole vault",
  },
  {
    name: "telemetry",
    option: null,
    schema: {
      type: "boolean",
      description: "Emit one recall-telemetry continuity record for this call. Default false.",
    },
    cliFlag: null,
    cliKind: "boolean",
    surfaces: ["mcp"],
    default: "false",
  },
  {
    name: "telemetry_host",
    option: null,
    schema: {
      type: "string",
      maxLength: 200,
      description: "Optional host/client label recorded on the telemetry record.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "session_id",
    option: null,
    schema: {
      type: "string",
      maxLength: 512,
      description: "Optional session correlation id recorded on the telemetry record.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "turn_id",
    option: null,
    schema: {
      type: "string",
      maxLength: 512,
      description: "Optional turn correlation id recorded on the telemetry record.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "properties",
    option: "properties",
    schema: {
      type: "object",
      description:
        "Optional frontmatter filter; values within a key OR, keys AND. type, pinned, visibility as indexed; other keys narrow on the attribute snapshot, judged live.",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
    cliFlag: "property",
    cliKind: "string-array",
    surfaces: ["mcp", "cli"],
    default: "absent: no filter",
  },
  {
    name: "kind",
    option: "kind",
    schema: {
      type: "string",
      enum: [...SEARCH_KINDS],
      description:
        "Restrict candidates by chunk kind: 'page' matches each document's frontmatter/head chunk (chunk 0), 'section' everything after it. Absent searches all chunks.",
    },
    cliFlag: "kind",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: all chunks",
  },
  {
    name: "degree",
    option: "degreeFilters",
    schema: {
      type: "array",
      description:
        "Graph-degree predicates over backlink/outlink counts, e.g. 'backlinks=0' (orphans) or 'outlinks>=5' (hubs); ANDed. Absent = no filter.",
      items: { type: "string" },
    },
    cliFlag: "degree",
    cliKind: "string-array",
    surfaces: ["mcp", "cli"],
    default: "absent: no filter",
  },
  {
    name: "visibility",
    option: "visibility",
    schema: {
      type: "array",
      description:
        "Optional content-visibility scope; untagged pages always match, tagged pages only when this scope includes one of their values.",
      items: { type: "string" },
    },
    cliFlag: "visibility",
    cliKind: "string-array",
    surfaces: ["mcp", "cli"],
    default: "absent: untagged pages only",
  },
  {
    name: "agent_scope",
    option: "agentScope",
    schema: {
      type: "string",
      description:
        "Optional agent-ownership scope; shared (ownerless) pages always match, owner-tagged pages only their owner. Absent = no ownership filtering.",
    },
    cliFlag: "agent-scope",
    cliKind: "string",
    surfaces: ["mcp", "cli"],
    default: "absent: no ownership filtering",
  },
  {
    name: "session_scope",
    option: "scope",
    schema: {
      type: "string",
      description:
        "Optional session-scope filter; pages with no session always match, session-tagged pages only this session. Absent = no session filtering.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent: no session filtering",
  },
  {
    name: "project_scope",
    option: "scope",
    schema: {
      type: "string",
      description:
        "Optional project-scope filter; pages with no project always match, project-tagged pages only this project. Absent = no project filtering.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent: no project filtering",
  },
  {
    name: "iterative",
    option: "iterative",
    schema: {
      type: "boolean",
      description:
        "Opt in to the bounded iterative recall loop (default off). Surviving gaps pause with a plan; resume via iterative_payload. Inert unless the knob is on.",
    },
    cliFlag: null,
    cliKind: "boolean",
    surfaces: ["mcp"],
    default: "false",
  },
  {
    name: "iterative_token",
    option: "iterativeToken",
    schema: {
      type: "string",
      maxLength: 128,
      description:
        "The round token from a plan-phase response, submitted beside iterative_payload. Requires iterative: true; single use - a replayed token is refused by name.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  {
    name: "iterative_payload",
    option: "iterativePayload",
    schema: {
      type: "object",
      description:
        "Decider payload answering a plan-phase envelope: { evidence: [chunkId, ...], subQueries: [...] }, validated before any pull runs. Requires iterative_token.",
    },
    cliFlag: null,
    cliKind: "string",
    surfaces: ["mcp"],
    default: "absent",
  },
  // ----- Below here: the cli-only rows. Backed by real SearchOptions ----
  // fields the served MCP schema omits, so their fragments are
  // documentation (they never reach the mcp projection above).
  {
    name: "keyword_weight",
    option: "keywordWeight",
    schema: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Keyword-lane weight, folded with semantic_weight into ranking. CLI-only: the served MCP schema omits it, so an MCP caller cannot reach the lane weights.",
    },
    cliFlag: "keyword-weight",
    cliKind: "string",
    surfaces: ["cli"],
    default: "the resolved config default",
  },
  {
    name: "semantic_weight",
    option: "semanticWeight",
    schema: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Semantic-lane weight, folded with keyword_weight into ranking. CLI-only for the same reason as keyword_weight.",
    },
    cliFlag: "semantic-weight",
    cliKind: "string",
    surfaces: ["cli"],
    default: "the resolved config default",
  },
  {
    name: "expand",
    option: "expand",
    schema: {
      type: "boolean",
      description:
        "Opt-in deterministic query expansion into lex/vec/hyde lanes when no query document was supplied. CLI-only: the served MCP schema omits it.",
    },
    cliFlag: "expand",
    cliKind: "boolean",
    surfaces: ["cli"],
    default: "false",
  },
] satisfies readonly SearchOptionRow[]);

/** The derived shape of the served `brain_search` input schema. */
export type DerivedSearchInputSchema = {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required: string[];
  readonly additionalProperties: false;
};

/**
 * The mcp-visible projection of {@link SEARCH_OPTION_ROWS}: the served
 * `brain_search` input schema, in declaration order, with the one
 * required argument. `SEARCH_INPUT_SCHEMA` in `src/mcp/search-tools.ts`
 * IS this value; the schema-artifact test pins it byte-identical to the
 * literal this derivation replaced.
 */
export function deriveSearchInputSchema(): DerivedSearchInputSchema {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const row of SEARCH_OPTION_ROWS) {
    if (!row.surfaces.includes("mcp")) continue;
    // Fresh arrays, the way the literal minted them: the served schema is
    // a value handed to clients, not an alias into this table.
    properties[row.name] = {
      ...row.schema,
      ...(row.schema.enum !== undefined ? { enum: [...row.schema.enum] } : {}),
    };
    if (row.required === true) required.push(row.name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

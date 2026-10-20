/**
 * The search-query schema artifact guard (t_50c81d5c substrate): the
 * served `brain_search` input schema is DERIVED from the search-options
 * descriptor, and this suite proves the derivation changed nothing.
 *
 * `LEGACY_SEARCH_INPUT_SCHEMA` below is the literal object that lived in
 * `src/mcp/search-tools.ts` before the descriptor existed, pasted
 * verbatim: the numeric bounds are inlined (they are the frozen baseline
 * - importing the live constants would let the expected value drift with
 * the code), while the enum vocabularies are imported exactly as the old
 * literal spelled them, each frozen and pinned by its own suite. The
 * served constant must deep-equal the literal AND serialize to the same
 * JSON bytes: the vendored Hermes projection and every `tool.inputSchema`
 * reader depend on the shape, and the day-one contract is identity.
 *
 * The reverse-direction tests hold the descriptor to its own story:
 * every mcp row is served and nothing else is, every cli row carries its
 * flag spelling, and the descriptor's `option` spellings are checked
 * against a key-for-key enumeration of `SearchOptions` - the runtime
 * anchor for the compile-time assertion the row type itself makes
 * (`option: keyof SearchOptions | null` refuses a phantom key to tsc).
 * The walk runs BOTH ways: every `SearchOptions` field must be served by
 * a row or named in the documented non-surface list, so the
 * descriptor's claim - no caller-facing field missing a row - cannot rot.
 */

import { describe, expect, test } from "bun:test";

import { SEARCH_INPUT_SCHEMA } from "../../../src/mcp/search-tools.ts";
import {
  deriveSearchInputSchema,
  SEARCH_OPTION_ROWS,
} from "../../../src/core/search/search-options-descriptor.ts";
import { DISCLOSURE_MODES } from "../../../src/core/search/disclosure-mode.ts";
import { FTS_MATCH_MODES } from "../../../src/core/search/fts-match-mode.ts";
import { RECALL_PROFILE_NAMES } from "../../../src/core/search/profiles.ts";
import { SEARCH_KINDS } from "../../../src/core/search/property-pushdown.ts";
import type { SearchOptions } from "../../../src/core/search/types.ts";

/**
 * The pre-derivation literal, frozen. If this object and the served
 * schema ever disagree, the served schema moved first and this suite is
 * the tripwire.
 */
const LEGACY_SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      maxLength: 2000,
      description:
        "What to recall from the vault. Matched against the index by keyword, semantics, or both.",
    },
    query_document: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description:
        "Line-oriented query program with intent:, lex:, vec: and hyde: lanes, steering each retrieval layer separately. Absent means 'query' drives every lane.",
    },
    focus_query: {
      type: "string",
      minLength: 1,
      maxLength: 1000,
      description:
        "Steer this one call towards a working-set topic without persisting a session focus.",
    },
    focus_path_prefix: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "Steer this one call towards a vault subtree, paired with focus_query as a transient focus.",
    },
    focus_session: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      description: "Session id whose bound focus applies (falls back to the global focus).",
    },
    evidence_pack: {
      type: "boolean",
      description:
        "Return the evidence pack: matched/missing terms, coverage, abstention text and the false-absence guard. Default false.",
    },
    include_superseded: {
      type: "boolean",
      description:
        "History mode for relation polarity: keep matched superseded predecessors undemoted and skip successor pull-in. Default false.",
    },
    since: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/after this point. ISO date/datetime, today, yesterday, last week, last month, <n>h/<n>d/<n>w.",
    },
    until: {
      type: "string",
      maxLength: 64,
      description:
        "Hard filter on event time (validity, body anchor, mtime last): at/before this point. Same forms as 'since'.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "How many ranked results to return. Default 10.",
    },
    semantic: {
      type: "boolean",
      description:
        "Force the semantic lane on or off. Absent lets the configured hybrid strategy decide.",
    },
    keyword_only: {
      type: "boolean",
      description: "Skip the semantic lane entirely, so no embedding is needed. Default false.",
    },
    match_mode: {
      type: "string",
      enum: [...FTS_MATCH_MODES],
      description:
        "FTS match breadth: 'all' (default) requires every term; 'any' matches a document carrying any one term. Absent leaves the implicit AND.",
    },
    disclosure: {
      type: "string",
      enum: [...DISCLOSURE_MODES],
      description:
        "Result depth: 'full' (default) returns full chunk content; 'cards' returns token-cheap layer-1 cards — drill a hit with brain_search_expand.",
    },
    profile: {
      type: "string",
      enum: [...RECALL_PROFILE_NAMES],
      description:
        "Named recall profile (fast|balanced|thorough): a fixed knob preset, preferred over persisted self-tuning. Absent leaves ranking unchanged.",
    },
    explain: {
      type: "boolean",
      description:
        "Add a per-result score_breakdown plus the retrieval_decision_trace and memory_trust_assessment receipts. Default false.",
    },
    trust: {
      type: "boolean",
      description:
        "Stamp each result with inline trust metadata (age_days, superseded, conflict), computed at read time. Default false.",
    },
    threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description:
        "Relevance floor in [0,1] on the final score; drops weaker hits so an irrelevant query returns no match. Default 0 (disabled).",
    },
    rerank: {
      type: "boolean",
      description:
        "Re-order the threshold-qualified results by core textual relevance (keyword + semantic). Default false.",
    },
    reinforce: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 512 },
      description:
        "Paths proven useful: recorded to the reinforce ledger and lifted (bounded) before the top_k cut. Default absent.",
    },
    record_access: {
      type: "boolean",
      description:
        "Record the surfaced paths as one activation access event (feeds the usage-aware ranking layer). Default true; never recorded for global searches.",
    },
    global: {
      type: "boolean",
      description:
        "Cross-vault union: search profile vaults and read-only recall sources too, merging results with origin labels. Default false (active vault only).",
    },
    path_prefix: {
      type: "string",
      maxLength: 256,
      description: "Restrict results to this vault subtree. Absent searches the whole vault.",
    },
    telemetry: {
      type: "boolean",
      description: "Emit one recall-telemetry continuity record for this call. Default false.",
    },
    telemetry_host: {
      type: "string",
      maxLength: 200,
      description: "Optional host/client label recorded on the telemetry record.",
    },
    session_id: {
      type: "string",
      maxLength: 512,
      description: "Optional session correlation id recorded on the telemetry record.",
    },
    turn_id: {
      type: "string",
      maxLength: 512,
      description: "Optional turn correlation id recorded on the telemetry record.",
    },
    properties: {
      type: "object",
      description:
        "Optional frontmatter filter; values within a key OR, keys AND. type, pinned, visibility as indexed; other keys narrow on the attribute snapshot, judged live.",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    },
    kind: {
      type: "string",
      enum: [...SEARCH_KINDS],
      description:
        "Restrict candidates by chunk kind: 'page' matches each document's frontmatter/head chunk (chunk 0), 'section' everything after it. Absent searches all chunks.",
    },
    degree: {
      type: "array",
      description:
        "Graph-degree predicates over backlink/outlink counts, e.g. 'backlinks=0' (orphans) or 'outlinks>=5' (hubs); ANDed. Absent = no filter.",
      items: { type: "string" },
    },
    visibility: {
      type: "array",
      description:
        "Optional content-visibility scope; untagged pages always match, tagged pages only when this scope includes one of their values.",
      items: { type: "string" },
    },
    agent_scope: {
      type: "string",
      description:
        "Optional agent-ownership scope; shared (ownerless) pages always match, owner-tagged pages only their owner. Absent = no ownership filtering.",
    },
    session_scope: {
      type: "string",
      description:
        "Optional session-scope filter; pages with no session always match, session-tagged pages only this session. Absent = no session filtering.",
    },
    project_scope: {
      type: "string",
      description:
        "Optional project-scope filter; pages with no project always match, project-tagged pages only this project. Absent = no project filtering.",
    },
    iterative: {
      type: "boolean",
      description:
        "Opt in to the bounded iterative recall loop (default off). Surviving gaps pause with a plan; resume via iterative_payload. Inert unless the knob is on.",
    },
    iterative_token: {
      type: "string",
      maxLength: 128,
      description:
        "The round token from a plan-phase response, submitted beside iterative_payload. Requires iterative: true; single use - a replayed token is refused by name.",
    },
    iterative_payload: {
      type: "object",
      description:
        "Decider payload answering a plan-phase envelope: { evidence: [chunkId, ...], subQueries: [...] }, validated before any pull runs. Requires iterative_token.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

/**
 * Every `SearchOptions` key, enumerated. A missing or stale entry is a
 * COMPILE error here (the record type demands completeness), so the
 * enumeration cannot silently rot - which is what makes the runtime
 * phantom-key check below mean something.
 */
const SEARCH_OPTIONS_KEY_PROBE: Record<keyof SearchOptions, true> = {
  query: true,
  limit: true,
  semantic: true,
  keywordOnly: true,
  pathPrefix: true,
  keywordWeight: true,
  semanticWeight: true,
  matchMode: true,
  properties: true,
  kind: true,
  degreeFilters: true,
  mmrLambda: true,
  maxHops: true,
  poolMaxPerSession: true,
  visibility: true,
  transportReach: true,
  agentScope: true,
  scope: true,
  relationalArm: true,
  structuredQuery: true,
  expand: true,
  disclosure: true,
  profile: true,
  sessionFocus: true,
  focusSession: true,
  evidencePack: true,
  iterative: true,
  iterativeToken: true,
  iterativePayload: true,
  recordAccess: true,
  includeSuperseded: true,
  since: true,
  until: true,
  trust: true,
  threshold: true,
  rerank: true,
  reinforce: true,
  selfHeal: true,
  freshenSpawn: true,
  laneTiming: true,
  skipDecisionModelRerank: true,
};

/**
 * The `SearchOptions` fields that deliberately carry NO descriptor row:
 * they are not part of the caller-facing query language, so no mcp
 * argument and no CLI flag exists for them. This list is the ONLY way a
 * `SearchOptions` key skips the reverse-direction walk below, which is
 * what makes the walk able to fail: a NEW caller-facing field without a
 * row fails it, and demoting a field to non-surface is a documented,
 * reviewable edit here - never a silent gap. Compile-time anchored like
 * the probe above: a misspelled name is a `tsc` error.
 */
const NON_SURFACE_SEARCH_OPTIONS: ReadonlyArray<keyof SearchOptions> = [
  // Self-tuning knobs: resolved from config per query by the grid, no
  // surface argument reaches them.
  "mmrLambda",
  "maxHops",
  "poolMaxPerSession",
  "relationalArm",
  // Minted by the surface that accepted the call (the CLI's local reach,
  // the MCP server's transport), never spelled by a caller argument.
  "transportReach",
  // Routing policy: cross-vault traversal pins this false on non-active
  // origins so a read-only vault is never written to.
  "selfHeal",
  // Callback seams: the background-freshen spawn (tests), the per-call
  // lane-timing sink (the CLI and the bench project the timing
  // themselves), and the hook surfaces' decision-rerank skip.
  "freshenSpawn",
  "laneTiming",
  "skipDecisionModelRerank",
];

describe("search input schema derivation (t_50c81d5c substrate)", () => {
  test("the derived SEARCH_INPUT_SCHEMA deep-equals the pre-derivation literal", () => {
    expect(SEARCH_INPUT_SCHEMA).toEqual(LEGACY_SEARCH_INPUT_SCHEMA);
  });

  test("and serializes to identical JSON bytes, so tools/list and the vendored projection are untouched", () => {
    expect(JSON.stringify(SEARCH_INPUT_SCHEMA)).toBe(JSON.stringify(LEGACY_SEARCH_INPUT_SCHEMA));
  });

  test("the derivation serves exactly the mcp rows, in declaration order", () => {
    const served = deriveSearchInputSchema();
    const mcpRows = SEARCH_OPTION_ROWS.filter((row) => row.surfaces.includes("mcp"));
    expect(Object.keys(served.properties)).toEqual(mcpRows.map((row) => row.name));
    expect(served.required).toEqual(
      mcpRows.filter((row) => row.required === true).map((row) => row.name),
    );
    expect(served.additionalProperties).toBe(false);
  });

  test("every cli row names its flag spelling, and an unflagged row reaches neither surface's flags", () => {
    const drifted: string[] = [];
    for (const row of SEARCH_OPTION_ROWS) {
      const onCli = row.surfaces.includes("cli");
      if (onCli && row.cliFlag === null) drifted.push(`${row.name}: cli row without a flag`);
      if (!onCli && row.cliFlag !== null) drifted.push(`${row.name}: flag outside the cli surface`);
    }
    expect(drifted).toEqual([]);
  });

  test("every row option key exists on SearchOptions - the compile-time assertion, anchored at runtime", () => {
    const phantom: string[] = [];
    for (const row of SEARCH_OPTION_ROWS) {
      if (row.option !== null && SEARCH_OPTIONS_KEY_PROBE[row.option] !== true) {
        phantom.push(`${row.name}: ${String(row.option)}`);
      }
    }
    expect(phantom).toEqual([]);
  });

  test("every SearchOptions field has a descriptor row - the reverse direction", () => {
    const rows = new Set(
      SEARCH_OPTION_ROWS.filter((row) => row.option !== null).map((row) => String(row.option)),
    );
    const exempt = new Set(NON_SURFACE_SEARCH_OPTIONS.map(String));
    const drifted: string[] = [];
    for (const key of Object.keys(SEARCH_OPTIONS_KEY_PROBE)) {
      const hasRow = rows.has(key);
      const isExempt = exempt.has(key);
      if (hasRow && isExempt) drifted.push(`${key}: exempted from the walk but a row serves it`);
      if (!hasRow && !isExempt) drifted.push(`${key}: no descriptor row and not exempted`);
    }
    expect(drifted).toEqual([]);
  });
});

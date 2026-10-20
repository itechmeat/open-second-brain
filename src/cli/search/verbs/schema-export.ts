/**
 * `o2b search schema export|check` — the committed, versioned JSON Schema
 * artifact for the search query language (t_50c81d5c, Task E4).
 *
 * The artifact is DERIVED, never hand-edited: {@link
 * buildSearchQueryArtifact} projects the search-options descriptor (the
 * same table that derives the served `SEARCH_INPUT_SCHEMA` and the CLI
 * flag table) into `schemas/brain/search-query.schema.json`, and adds the
 * `brain.search_query_document.v1` sibling grammar for the line-oriented
 * query_document program as a `$defs` entry. Regeneration is a human
 * action (`o2b search schema export`); `check` re-derives and diffs, so a
 * descriptor change that outgrew the committed file is named in CI and by
 * any operator who runs it.
 *
 * Deliberately NOT `o2b brain schema ...`: that verb group is the VAULT
 * schema pack (`_brain.yaml`), a wholly unrelated "schema". This artifact
 * describes the search language, so it lives under the search verb group.
 *
 * The artifact documents the per-surface asymmetries the descriptor
 * records (the MCP-side `limit` maximum of MCP_LIMIT_MAX, the
 * `maxLength` on `query` that only the MCP surface enforces) instead of
 * silently flattening them; the CLI keeps its own bounds at its read
 * site.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readFileSync, writeFileSync } from "node:fs";
import { deriveSearchInputSchema } from "../../../core/search/search-options-descriptor.ts";
import type { QueryIntent } from "../../../core/search/types.ts";
import { info } from "../../output.ts";
import { CliError, parseFlags } from "../helpers.ts";

/** The committed artifact path, from the repo root this module ships in. */
export const SEARCH_QUERY_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "schemas",
  "brain",
  "search-query.schema.json",
);

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

/**
 * The intent vocabulary, kept complete against the `QueryIntent` union:
 * a new intent is a tsc error here until the grammar names it - the same
 * probe pattern the descriptor's runtime anchor uses for `SearchOptions`.
 */
const QUERY_INTENT_COVERAGE: Record<QueryIntent, true> = {
  neutral: true,
  exact: true,
  entity: true,
  broad: true,
};
const QUERY_INTENT_NAMES: ReadonlyArray<QueryIntent> = Object.keys(
  QUERY_INTENT_COVERAGE,
) as ReadonlyArray<QueryIntent>;

/**
 * The line-oriented query_document grammar, as the artifact describes it.
 * The parser is hand-rolled (`parseStructuredRecallQueryDocument`); this
 * block is a faithful DESCRIPTION of it, held to the documented example
 * by the doc-example tests - not an enforcement engine.
 */
function queryDocumentGrammar() {
  return {
    $id: "brain.search_query_document.v1",
    title: "Brain Search Query Document v1",
    description:
      "Line-oriented query program steering each retrieval layer separately. One '<lane>: <value>' line per lane; blank lines and #-comments are ignored. At least one lane is required; the intent lane may appear at most once.",
    type: "object",
    required: [],
    additionalProperties: false,
    properties: {
      intent: {
        type: "string",
        enum: [...QUERY_INTENT_NAMES],
        description:
          "Retrieval posture: neutral (default ranking), exact (verbatim phrase preference), entity (tightly scoped subject), broad (recall-favouring). At most one intent line.",
      },
      lex: {
        type: "string",
        description:
          "Keyword-lane tokens, space separated; quote a multi-word token. A leading '-' excludes the token. Repeatable: later lex lines add tokens.",
      },
      vec: {
        type: "string",
        description: "Embedding-lane query text. Repeatable: later vec lines add queries.",
      },
      hyde: {
        type: "string",
        description:
          "Hypothetical passage the answer would look like. Repeatable: later hyde lines add passages.",
      },
    },
  };
}

/** The artifact's full shape: the served input schema plus the grammar block. */
export type SearchQueryArtifact = {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
  readonly description: string;
  readonly type: "object";
  readonly required: string[];
  readonly additionalProperties: false;
  readonly properties: Record<string, unknown>;
  readonly $defs: Record<string, unknown>;
};

/**
 * The committed artifact, derived from the descriptor. The property set
 * IS `deriveSearchInputSchema()`'s - the served brain_search language -
 * re-anchored under a versioned `$id`, with the query-document grammar
 * beside it. Any descriptor row change flows here and is caught by the
 * generator check until `export` re-commits it.
 */
export function buildSearchQueryArtifact(): SearchQueryArtifact {
  const served = deriveSearchInputSchema();
  return {
    $schema: DRAFT_2020_12,
    $id: "brain.search_query.v1",
    title: "Brain Search Query v1",
    description:
      "The brain_search query language: every argument the MCP tool accepts, published as a versioned JSON Schema (draft 2020-12). The same table derives the served tools/list inputSchema and the o2b search CLI flags; see $defs.search_query_document for the line-oriented query_document grammar.",
    type: "object",
    required: [...served.required],
    additionalProperties: false,
    properties: JSON.parse(JSON.stringify(served.properties)),
    $defs: { search_query_document: queryDocumentGrammar() },
  };
}

/** The artifact serialized exactly the way `export` writes it. */
export function renderSearchQueryArtifact(): string {
  return `${JSON.stringify(buildSearchQueryArtifact(), null, 2)}\n`;
}

function usageError(message: string): CliError {
  return new CliError(
    `search schema: ${message} (usage: o2b search schema export [--stdout] | check)`,
  );
}

/** The property-name list of a schema object, for a one-line drift reason. */
function propertySetOf(schema: unknown): string {
  const properties =
    typeof schema === "object" && schema !== null && "properties" in schema
      ? (schema as { properties: Record<string, unknown> }).properties
      : {};
  return Object.keys(properties).toSorted().join(",");
}

/**
 * `o2b search schema export [--stdout]` - write the derived artifact to
 * the committed path (default) or, with `--stdout`, print exactly the
 * rendered bytes and touch nothing (the dry-run/CI preview the usage
 * string and cli-reference promise). `o2b search schema check` -
 * re-derive and compare with the committed file: exit 0 clean, exit 2 on
 * drift, so CI and operators share one named verdict. The comparison is
 * JSON equality, not byte equality: the committed file carries the repo
 * formatter's layout, so `export` writing raw builder bytes must never
 * read as drift - only content can drift. `--json` is `check`'s output
 * mode and is refused on export by name - `parseFlags` injects it into
 * every schema, and a flag the verb parses and ignores is the defect
 * `--stdout` once was.
 */
export async function cmdSearchSchema(argv: ReadonlyArray<string>): Promise<number> {
  const sub = argv[0];
  if (sub === "export") {
    const { flags } = parseFlags(argv.slice(1), {
      stdout: { type: "boolean" },
      json: { type: "boolean" },
    });
    if (flags["json"] === true) {
      throw usageError("--json is check's output mode; export takes only --stdout");
    }
    if (flags["stdout"] === true) {
      process.stdout.write(renderSearchQueryArtifact());
      return 0;
    }
    writeFileSync(SEARCH_QUERY_SCHEMA_PATH, renderSearchQueryArtifact(), "utf8");
    info(`search schema: wrote ${SEARCH_QUERY_SCHEMA_PATH}`);
    return 0;
  }
  if (sub === "check") {
    const { flags } = parseFlags(argv.slice(1), { json: { type: "boolean" } });
    const asJson = flags["json"] === true;
    let committed: unknown;
    try {
      committed = JSON.parse(readFileSync(SEARCH_QUERY_SCHEMA_PATH, "utf8"));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(
        `error: search schema: ${SEARCH_QUERY_SCHEMA_PATH} is missing or unreadable (${reason}) - run 'o2b search schema export'\n`,
      );
      return 2;
    }
    const derived: unknown = JSON.parse(JSON.stringify(buildSearchQueryArtifact()));
    if (JSON.stringify(committed) === JSON.stringify(derived)) {
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ ok: true, $id: "brain.search_query.v1" })}\n`);
      } else {
        info(`search schema: ${SEARCH_QUERY_SCHEMA_PATH} matches the descriptor`);
      }
      return 0;
    }
    const fileSet = propertySetOf(committed);
    const derivedSet = propertySetOf(derived);
    const detail =
      fileSet !== derivedSet
        ? `property set drifted (file: ${fileSet}; descriptor: ${derivedSet})`
        : "content drifted from the descriptor derivation";
    process.stderr.write(
      `error: search schema: ${SEARCH_QUERY_SCHEMA_PATH} ${detail} - run 'o2b search schema export' and commit the result\n`,
    );
    return 2;
  }
  throw usageError(`unknown subcommand '${sub ?? ""}'`);
}

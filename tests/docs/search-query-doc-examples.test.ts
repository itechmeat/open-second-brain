/**
 * The documented search examples say what the code does (t_50c81d5c,
 * Task E5), on the retrieval-trail-doc pattern: extraction is scoped to
 * the Search sections of the operator docs, and every documented token is
 * checked against the code that must honor it.
 *
 * Four checks, each a different direction:
 *
 *  - the documented structured-query example under "Structured recall
 *    query documents" parses with the REAL parser, and the brain_search
 *    argument object its claims describe validates against the COMMITTED
 *    artifact (schemas/brain/search-query.schema.json);
 *  - every intent token the documented grammar sentence names appears in
 *    the artifact's query_document enum AND parses with the real parser,
 *    so the artifact's grammar block cannot drift from either side;
 *  - every `--flag` in the scoped `o2b search "<query>"` block of
 *    docs/cli-reference.md is accepted by the descriptor-derived flag
 *    table (doc -> code; other search verbs are excluded by the scoping);
 *  - every backticked brain_search argument name in the docs/mcp.md
 *    paragraph is a property of the artifact (code vocabulary must have a
 *    documented row, inverted).
 *
 * Scope contract: this suite reads ONLY the operator docs listed below -
 * never docs/plans/** or docs/brainstorm/**, which are dated design
 * archives documenting superseded shapes.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSearchQueryArtifact } from "../../src/cli/search/verbs/schema-export.ts";
import { SEARCH_QUERY_FLAGS } from "../../src/cli/search/verbs/query.ts";
import { parseStructuredRecallQueryDocument } from "../../src/core/search/structured-query.ts";
import { SEARCH_OPTION_ROWS } from "../../src/core/search/search-options-descriptor.ts";
import {
  assertSupportedSchema,
  type SchemaNode,
  validateAgainstSchema,
} from "../helpers/json-schema-subset.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const CLI_REFERENCE = readFileSync(join(REPO_ROOT, "docs", "cli-reference.md"), "utf8");
const MCP_DOC = readFileSync(join(REPO_ROOT, "docs", "mcp.md"), "utf8");

/** The only files this suite reads. The scope assertion below pins them. */
const DOC_FILES_READ: ReadonlyArray<string> = ["docs/cli-reference.md", "docs/mcp.md"];

const ARTIFACT: SchemaNode = (() => {
  const artifact = buildSearchQueryArtifact();
  assertSupportedSchema(artifact);
  return JSON.parse(JSON.stringify(artifact)) as SchemaNode;
})();

/** The grammar lane names, which document lines but are not artifact properties. */
const QUERY_DOCUMENT_LANES: ReadonlySet<string> = new Set(["intent", "lex", "vec", "hyde"]);

/** The `## Search` section of cli-reference.md, up to the next section heading. */
function searchSection(): string {
  const start = CLI_REFERENCE.indexOf("\n## Search\n");
  expect(start).toBeGreaterThanOrEqual(0);
  const next = CLI_REFERENCE.indexOf("\n## ", start + 1);
  return CLI_REFERENCE.slice(start, next === -1 ? undefined : next);
}

/** The `o2b search "<query>"` entry block, up to the next `o2b search` verb line. */
function queryVerbBlock(): string {
  const section = searchSection();
  const start = section.indexOf('o2b search "<query>"');
  expect(start).toBeGreaterThanOrEqual(0);
  const next = section.indexOf("\no2b search ", start + 1);
  return section.slice(start, next === -1 ? undefined : next);
}

/** The structured-query prose plus its fenced example, from the Search section. */
function structuredQueryDoc(): { prose: string; example: string } {
  const section = searchSection();
  const start = section.indexOf("Structured recall query documents");
  expect(start).toBeGreaterThanOrEqual(0);
  const fence = section.indexOf("```text", start);
  expect(fence).toBeGreaterThan(start);
  const close = section.indexOf("```", fence + 7);
  return {
    prose: section.slice(start, fence),
    example: section
      .slice(fence + 7, close)
      .replace(/^\n/, "")
      .replace(/\n$/, ""),
  };
}

test("the suite stays scoped to the operator docs, never the design archives", () => {
  for (const file of DOC_FILES_READ) {
    expect(
      `${file} outside design archives: ${file.startsWith("docs/plans/") || file.startsWith("docs/brainstorm/")}`,
    ).toBe(`${file} outside design archives: false`);
  }
});

test("the documented structured-query example parses with the real parser", () => {
  const { example } = structuredQueryDoc();
  // The example is exactly what the docs show; the real parser accepts it.
  const document = parseStructuredRecallQueryDocument(example);
  expect(document.intent).toBe("entity");
  expect(document.lex.include).toContain("project alpha");
  expect(document.lex.exclude).toContain("archived");
});

test("a brain_search call built from the documented claims validates against the artifact", () => {
  const { example } = structuredQueryDoc();
  const args = {
    query: "project alpha",
    query_document: example,
    kind: "section",
    since: "last week",
    limit: 10,
    disclosure: "cards",
    match_mode: "any",
  };
  const result = validateAgainstSchema(ARTIFACT, args);
  expect(result.errors).toEqual([]);
});

test("every intent token in the documented grammar sentence is in the artifact's enum and parses", () => {
  const { prose } = structuredQueryDoc();
  const marker = "`intent:` accepts";
  const at = prose.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  const sentence = prose.slice(at + marker.length, prose.indexOf(";", at));
  const named = [...sentence.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
  // Not vacuous: the sentence names all four shipped intents.
  expect(named.toSorted()).toEqual(["broad", "entity", "exact", "neutral"]);
  const grammar = (
    ARTIFACT as unknown as {
      $defs: { search_query_document: { properties: { intent: { enum: string[] } } } };
    }
  ).$defs.search_query_document.properties.intent.enum;
  for (const token of named) {
    expect(`${token} in the artifact enum: ${grammar.includes(token)}`).toBe(
      `${token} in the artifact enum: true`,
    );
    // And the real parser accepts what the sentence and the artifact name.
    expect(() => parseStructuredRecallQueryDocument(`intent: ${token}`)).not.toThrow();
  }
});

test("every --flag in the documented query-verb block is accepted by the derived flag table", () => {
  const block = queryVerbBlock();
  const documented = [...new Set([...block.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]!.slice(2)))];
  // Not vacuous: the block documents the query verb's headline flags.
  expect(documented.length).toBeGreaterThanOrEqual(8);
  expect(documented).toContain("query-doc");
  const unknown = documented.filter((flag) => !(flag in SEARCH_QUERY_FLAGS));
  expect(unknown).toEqual([]);
});

test("the documented query-verb flags all name descriptor cli rows or the verb-local trio", () => {
  // The table the verb parses is descriptor rows + vault flags + the
  // verb-local output flags; the docs must never name a fourth kind.
  const cliRows = new Set(
    SEARCH_OPTION_ROWS.filter((row) => row.cliFlag !== null).map((row) => row.cliFlag!),
  );
  const vaultAndLocal = new Set(["vault", "config", "db", "auto-refresh", "json", "verbose"]);
  const block = queryVerbBlock();
  const documented = [...new Set([...block.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]!.slice(2)))];
  for (const flag of documented) {
    expect(
      `${flag} documented from the language: ${cliRows.has(flag) || vaultAndLocal.has(flag)}`,
    ).toBe(`${flag} documented from the language: true`);
  }
});

test("every backticked brain_search argument in the mcp paragraph is a property of the artifact", () => {
  const start = MCP_DOC.indexOf("`brain_search` accepts");
  expect(start).toBeGreaterThanOrEqual(0);
  // The input prose only: it flows into one printed paragraph with the
  // output-receipt history that follows it ("Since v<n> ... adds two
  // top-level receipts ..."), which documents OUTPUT fields - those are
  // the answer contract, not the query language, and stay out of scope.
  const paragraph = MCP_DOC.slice(start, MCP_DOC.indexOf("\nSince v", start));
  // Argument names appear in exactly three shapes in this prose; the
  // paragraph's output-field names (`why_retrieved`, `completeness`, ...)
  // never do, so the shapes are the scoping - no name allowlist to rot.
  const named = new Set<string>();
  for (const m of paragraph.matchAll(/`([a-z_]+):/g)) named.add(m[1]!); // argument: true / lane:
  for (const m of paragraph.matchAll(/`([a-z_]+)` with\b/g)) named.add(m[1]!); // `x` with ...
  for (const m of paragraph.matchAll(/`([a-z_]+)` \/ `([a-z_]+)`/g)) {
    named.add(m[1]!); // `x` / `y` pairs
    named.add(m[2]!);
  }
  named.delete("brain_search");
  for (const lane of QUERY_DOCUMENT_LANES) named.delete(lane);
  // Not vacuous: the paragraph documents the headline arguments.
  const argumentsNamed = [...named].toSorted();
  expect(argumentsNamed).toEqual([
    "evidence_pack",
    "focus_path_prefix",
    "focus_query",
    "include_superseded",
    "query_document",
    "since",
    "telemetry",
    "until",
  ]);
  const properties = ARTIFACT.properties as Record<string, unknown>;
  const missing = argumentsNamed.filter((token) => !(token in properties));
  expect(missing).toEqual([]);
});

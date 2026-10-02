/**
 * The distillation reference tables in docs/mcp.md stay in step with the
 * vocabularies and the input schema they describe. Every expected row is
 * derived from the source of truth, never copied, so a new outcome, scope or
 * argument that the docs do not name fails here.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  QUOTE_CHECK_OUTCOMES,
  QUOTE_UNVERIFIED_CODE,
  VERIFIED_QUOTE_OUTCOMES,
} from "../../src/core/brain/distill/quote-verdict.ts";
import { CAPTURE_SCOPES } from "../../src/core/brain/provenance/capture-scope.ts";
import { DISTILL_TOOLS } from "../../src/mcp/brain/distill-tools.ts";

const MCP_DOC = readFileSync(join(import.meta.dir, "..", "..", "docs", "mcp.md"), "utf8");

/** The text of one `## ` section, up to the next heading of the same depth. */
function section(heading: string): string {
  const start = MCP_DOC.indexOf(`\n## ${heading}`);
  expect(start).toBeGreaterThan(-1);
  const end = MCP_DOC.indexOf("\n## ", start + 4);
  return MCP_DOC.slice(start, end === -1 ? undefined : end);
}

const DISTILL = section("Source distillation");

test("every brain_distill_source input property has an argument row", () => {
  const props = Object.keys(DISTILL_TOOLS[0]!.inputSchema["properties"] as object);
  expect(props.length).toBeGreaterThan(0);
  for (const name of props) expect(DISTILL, name).toContain(`| \`${name}\` |`);
});

test("every failing quote outcome is named in the findings row", () => {
  const row = DISTILL.split("\n").find((line) => line.startsWith("| `findings` |"));
  expect(row).toBeDefined();
  const verified = new Set<string>(VERIFIED_QUOTE_OUTCOMES);
  for (const outcome of QUOTE_CHECK_OUTCOMES) {
    if (!verified.has(outcome)) expect(row, outcome).toContain(`\`${outcome}\``);
  }
});

test("every capture scope has a row", () => {
  for (const scope of CAPTURE_SCOPES) expect(DISTILL, scope).toContain(`| \`${scope}\` |`);
});

test("the strict refusal code has a row in the error-code table", () => {
  expect(MCP_DOC).toContain(`| \`${QUOTE_UNVERIFIED_CODE}\` |`);
});

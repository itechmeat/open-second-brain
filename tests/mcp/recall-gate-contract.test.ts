/**
 * `brain_recall_gate`'s advertised contract against the call it actually
 * accepts (a-label-is-not-a-boundary review, C3).
 *
 * Three things had drifted apart. The tool DESCRIPTION told a caller to
 * "pass `scores` … to also get an adequacy verdict", which is precisely
 * the call `coerceRecallAdequacyInput` refuses with INVALID_PARAMS unless
 * `match_quality` rides along. The INPUT SCHEMA expressed the pairing
 * nowhere - `match_quality` appeared in no `required` array anywhere in
 * the tree - so a schema-driven client could only discover it by making
 * the refused call. And the OUTPUT echoed `top_score` / `mean_score`, the
 * two numbers that decide nothing, while withholding the one that decides
 * the level.
 *
 * These assertions are about the advertised surface, so they read the
 * tool table rather than a transcript: a description is a contract with a
 * model that never sees this file.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assessRecallAdequacy } from "../../src/core/brain/recall-adequacy.ts";
import { MATCH_QUALITY_ARG_NAME } from "../../src/mcp/coerce.ts";
import { assertOutputContract } from "../../src/mcp/output-contract.ts";
import { MCPError } from "../../src/mcp/protocol.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

const TOOL_NAME = "brain_recall_gate";
const SCORES_ARG_NAME = "scores";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-recall-gate-contract-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function gate(): ToolDefinition {
  return findTool(buildToolTable("full"), TOOL_NAME);
}

test("the description names the pairing the handler enforces", () => {
  const description = gate().description;
  // Both names, so the sentence a model reads is the call the server
  // accepts rather than the one it refuses.
  expect(description).toContain(MATCH_QUALITY_ARG_NAME);
  expect(description).toContain(SCORES_ARG_NAME);
  // And it says what happens to an incomplete pair, in the vocabulary the
  // refusal itself uses.
  expect(description).toContain("INVALID_PARAMS");
});

test("the input schema states 'both or neither' declaratively", () => {
  const schema = gate().inputSchema as Record<string, unknown>;
  const dependent = schema["dependentRequired"] as
    | Record<string, ReadonlyArray<string>>
    | undefined;
  expect(dependent).toBeDefined();
  expect(dependent?.[SCORES_ARG_NAME]).toEqual([MATCH_QUALITY_ARG_NAME]);
  expect(dependent?.[MATCH_QUALITY_ARG_NAME]).toEqual([SCORES_ARG_NAME]);
  // A keyword a client's draft may not know is not on its own enough, so
  // the property description carries the same rule in prose.
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  expect(String(properties[SCORES_ARG_NAME]?.["description"])).toContain(MATCH_QUALITY_ARG_NAME);
});

test("the description's own call is the one the handler accepts", async () => {
  // The regression this file exists for: the shipped description told the
  // caller to pass scores alone, and that call is refused.
  await expect(
    gate().handler(ctx(), { prompt: "what did we decide?", scores: [0.7] }),
  ).rejects.toBeInstanceOf(MCPError);
  const paired = (await gate().handler(ctx(), {
    prompt: "what did we decide?",
    scores: [0.7],
    match_quality: 0.7,
  })) as Record<string, unknown>;
  expect(paired["adequacy"]).toBeDefined();
});

test("the verdict returns the quantity that decided it", async () => {
  const matchQuality = 0.42;
  const out = (await gate().handler(ctx(), {
    prompt: "what did we decide?",
    scores: [0.9, 0.1],
    match_quality: matchQuality,
  })) as { adequacy: Record<string, unknown> };

  expect(out.adequacy[MATCH_QUALITY_ARG_NAME]).toBe(matchQuality);
  // Not reconstructible from what the block used to carry: the top score
  // and the mean are both something else entirely.
  expect(out.adequacy["top_score"]).not.toBe(matchQuality);
  expect(out.adequacy["mean_score"]).not.toBe(matchQuality);
  // And it is the number the core graded on, not a copy of the argument
  // that happens to agree.
  expect(out.adequacy["level"]).toBe(
    assessRecallAdequacy({ matchQuality, scores: [0.9, 0.1] }).level,
  );

  // Declared, not merely emitted: the response is checked against the
  // tool's own output schema, which now requires the field.
  assertOutputContract(TOOL_NAME, gate().outputSchema, out);
});

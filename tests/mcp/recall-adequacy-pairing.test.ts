/**
 * Every tool that ENFORCES the recall-adequacy pairing must also DECLARE it.
 *
 * `coerceRecallAdequacyInput` refuses an incomplete `scores`/`match_quality`
 * pair with INVALID_PARAMS on every tool that calls it. `brain_recall_gate`
 * shipped `dependentRequired` so a schema-driven client could discover that
 * rule; `brain_context_pack` shipped the same refusal with no declaration at
 * all, so the only way to find it there was to make the call the server
 * refuses - the exact defect the keyword was added to remove, left sitting
 * inside the fix for it.
 *
 * The population is DERIVED from the tool table rather than listed here. A
 * third tool that gains `match_quality` without the pairing fails this file
 * on its way in, instead of waiting for someone to remember to add a case.
 * And the declaration is checked against the running handler, not against a
 * second copy of the rule written in the test: a schema that says "both or
 * neither" while the handler accepts one alone would be a new drift, not a
 * pass.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MATCH_QUALITY_ARG_NAME, RECALL_SCORES_SCHEMA } from "../../src/mcp/coerce.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import { buildToolTable } from "../../src/mcp/tools.ts";
import type { ServerContext, ToolDefinition } from "../../src/mcp/tool-contract.ts";

/**
 * Tools known to enforce the pairing today.
 *
 * Not the population the assertions iterate - that is derived below. This
 * exists so the derivation emptying out (a rename, a schema refactor) reads
 * as a failure rather than as a clean run over zero tools.
 */
const KNOWN_PAIRING_TOOLS = ["brain_recall_gate", "brain_context_pack"];

type Schema = Record<string, unknown>;

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-adequacy-pairing-"));
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

function properties(schema: Schema): Record<string, Schema> {
  return (schema["properties"] as Record<string, Schema> | undefined) ?? {};
}

/**
 * The key a tool spells its recall scores with, found by SHAPE rather than
 * by name, so the search does not depend on the very keyword under test.
 */
function scoresKeyOf(schema: Schema): string | undefined {
  for (const [key, prop] of Object.entries(properties(schema))) {
    if (key === MATCH_QUALITY_ARG_NAME) continue;
    if (JSON.stringify(prop) === JSON.stringify(RECALL_SCORES_SCHEMA)) return key;
  }
  return undefined;
}

/** An argument name as these descriptions spell one: inside backticks. */
function backticked(key: string): string {
  return `\`${key}\``;
}

/** Every curated tool whose input schema accepts `match_quality`. */
function pairingTools(): ToolDefinition[] {
  return buildToolTable("full").filter((tool) =>
    Object.hasOwn(properties(tool.inputSchema as Schema), MATCH_QUALITY_ARG_NAME),
  );
}

/** A conforming value for one declared property, from its own schema. */
function sampleFor(prop: Schema): unknown {
  const choices = prop["enum"];
  if (Array.isArray(choices) && choices.length > 0) return choices[0];
  switch (prop["type"]) {
    case "string": {
      const min = typeof prop["minLength"] === "number" ? prop["minLength"] : 1;
      return "x".repeat(Math.max(min, 1));
    }
    case "integer":
    case "number": {
      const min = typeof prop["minimum"] === "number" ? prop["minimum"] : 1;
      return Math.max(min, 1);
    }
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      throw new Error(`no sample value for property type ${String(prop["type"])}`);
  }
}

/**
 * The smallest payload a tool accepts, so the refusal under test is the
 * pairing's and not a missing unrelated argument's.
 */
function minimalArgs(schema: Schema): Record<string, unknown> {
  const props = properties(schema);
  const required = (schema["required"] as ReadonlyArray<string> | undefined) ?? [];
  const args: Record<string, unknown> = {};
  for (const key of required) {
    const prop = props[key];
    if (prop === undefined) throw new Error(`required arg ${key} has no property schema`);
    args[key] = sampleFor(prop);
  }
  return args;
}

test("the pairing population is derived and non-empty", () => {
  const found = pairingTools().map((tool) => tool.name);
  for (const name of KNOWN_PAIRING_TOOLS) expect(found).toContain(name);
});

test("every tool that accepts match_quality declares the pairing on its own scores key", () => {
  for (const tool of pairingTools()) {
    const schema = tool.inputSchema as Schema;
    const scoresKey = scoresKeyOf(schema);
    expect(
      scoresKey,
      `${tool.name} accepts ${MATCH_QUALITY_ARG_NAME} but declares no scores array`,
    ).toBeDefined();

    const dependent = schema["dependentRequired"] as
      | Record<string, ReadonlyArray<string>>
      | undefined;
    expect(
      dependent,
      `${tool.name} enforces the pairing but declares no dependentRequired; a client can only ` +
        `discover the rule by making the call the server refuses`,
    ).toBeDefined();
    // Both directions, each naming THIS tool's key: a pairing copied from
    // the other tool would name `scores` here and declare nothing real.
    expect(dependent?.[scoresKey as string]).toEqual([MATCH_QUALITY_ARG_NAME]);
    expect(dependent?.[MATCH_QUALITY_ARG_NAME]).toEqual([scoresKey as string]);

    // The prose says it too, for a client on a draft without the keyword.
    expect(String(properties(schema)[scoresKey as string]?.["description"])).toContain(
      MATCH_QUALITY_ARG_NAME,
    );
  }
});

test("no advertised prose sends a caller to the other tool's argument name", () => {
  const tools = pairingTools();
  // Every scores key in play, so "the other tool's name" is derived rather
  // than written down. A third tool with a third spelling joins this set on
  // its way in and is checked against the first two automatically.
  const allScoresKeys = tools.map((tool) => scoresKeyOf(tool.inputSchema as Schema) as string);

  for (const tool of tools) {
    const schema = tool.inputSchema as Schema;
    const ownKey = scoresKeyOf(schema) as string;
    const quality = properties(schema)[MATCH_QUALITY_ARG_NAME] ?? {};
    const qualityText = String(quality["description"]);

    // The companion argument's description is the sentence a schema-driven
    // client reads to learn WHICH argument to send alongside, and
    // `additionalProperties: false` refuses the wrong one - so naming the
    // other tool's key here hands the caller a rejected payload.
    expect(
      qualityText,
      `${tool.name}'s ${MATCH_QUALITY_ARG_NAME} description does not name its own scores key ` +
        `'${ownKey}'`,
    ).toContain(backticked(ownKey));

    // Backtick-delimited so the check is exact: `recall_scores` contains the
    // bare substring "scores", and only the delimiters tell the two apart.
    for (const foreign of allScoresKeys) {
      if (foreign === ownKey) continue;
      for (const [field, text] of [
        ["description", tool.description],
        [`${MATCH_QUALITY_ARG_NAME}.description`, qualityText],
        [`${ownKey}.description`, String(properties(schema)[ownKey]?.["description"])],
      ] as const) {
        expect(
          text,
          `${tool.name}'s ${field} names '${foreign}', which is another tool's argument; ` +
            `this tool spells it '${ownKey}' and refuses the other name`,
        ).not.toContain(backticked(foreign));
      }
    }
  }
});

test("every tool that declares the pairing actually refuses an incomplete pair", async () => {
  for (const tool of pairingTools()) {
    const schema = tool.inputSchema as Schema;
    const scoresKey = scoresKeyOf(schema) as string;
    const base = minimalArgs(schema);

    for (const incomplete of [
      { ...base, [scoresKey]: [0.7] },
      { ...base, [MATCH_QUALITY_ARG_NAME]: 0.7 },
    ]) {
      let thrown: unknown;
      try {
        await Promise.resolve(tool.handler(ctx(), incomplete));
      } catch (error) {
        thrown = error;
      }
      expect(
        thrown,
        `${tool.name} accepted an incomplete pair: ${JSON.stringify(incomplete)}`,
      ).toBeInstanceOf(MCPError);
      expect((thrown as MCPError).code).toBe(INVALID_PARAMS);
      // The refusal names both halves, so the message and the schema teach
      // the same rule.
      expect((thrown as MCPError).message).toContain(MATCH_QUALITY_ARG_NAME);
      expect((thrown as MCPError).message).toContain(scoresKey);
    }

    // And the complete pair is not refused, so the guard above is testing
    // the pairing rather than a tool that rejects everything.
    const complete = { ...base, [scoresKey]: [0.7], [MATCH_QUALITY_ARG_NAME]: 0.7 };
    expect(await Promise.resolve(tool.handler(ctx(), complete))).toBeDefined();
  }
});

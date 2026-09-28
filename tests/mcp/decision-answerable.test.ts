/**
 * Advisory `decision_answerable` on `brain_recall_gate` and
 * `brain_context_pack` (issue #213, Part 8).
 *
 * The argument annotates the deterministic adequacy verdict and never
 * changes its level or action. It needs the recall pair it annotates, and
 * it is honoured only while rerank kind `decision-model` runs with the
 * `answerable` use in shadow or enforce; otherwise it is ignored with one
 * warning. Neither surface ever sends a request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listGateTelemetry } from "../../src/core/brain/gate-telemetry.ts";
import { DECISION_ANSWERABLE_OFF_WARNING } from "../../src/core/decision-model/answerable.ts";
import { assertOutputContract } from "../../src/mcp/output-contract.ts";
import { INVALID_PARAMS, MCPError } from "../../src/mcp/protocol.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import { FAKE_DECISION_KEY } from "../helpers/fake-credentials.ts";

const KEY_VAR = "O2B_TEST_DECISION_ANSWERABLE_KEY";

let tmp: string;
let vault: string;
let configPath: string;
let fetchCalls = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-dm-answerable-mcp-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeConfig({});
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls++;
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
  delete process.env[KEY_VAR];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env[KEY_VAR];
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(entries: Record<string, string>): void {
  const lines = [`vault: "${vault}"`, ...Object.entries(entries).map(([k, v]) => `${k}: "${v}"`)];
  writeFileSync(configPath, lines.join("\n") + "\n");
}

const DECISION = {
  search_rerank_enabled: "true",
  search_rerank_kind: "decision-model",
  decision_model_enabled: "true",
  decision_model_provider: "typesafe",
  decision_model_env_key: KEY_VAR,
};

function activeWith(answerable: "off" | "shadow" | "enforce"): void {
  process.env[KEY_VAR] = FAKE_DECISION_KEY;
  writeConfig({ ...DECISION, decision_model_uses: `rerank:shadow,answerable:${answerable}` });
}

function ctx(): ServerContext {
  return { vault, configPath, repoRoot: null };
}

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

interface GateOut {
  adequacy?: Record<string, unknown>;
  warnings?: string[];
}

async function gate(args: Record<string, unknown>): Promise<GateOut> {
  const t = tool("brain_recall_gate");
  const out = (await t.handler(ctx(), { prompt: "what did we decide?", ...args })) as GateOut;
  assertOutputContract(t.name, t.outputSchema, out);
  return out;
}

async function expectInvalid(call: () => unknown, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve()
    .then(call)
    .then(
      () => null,
      (e: unknown) => e,
    );
  expect(err).toBeInstanceOf(MCPError);
  expect((err as MCPError).code).toBe(INVALID_PARAMS);
  expect((err as MCPError).message).toMatch(pattern);
}

async function verdict(pair: object, p: number): Promise<unknown> {
  return (await gate({ ...pair, decision_answerable: p })).adequacy!["decision_answerable"];
}

const SUFFICIENT = { scores: [0.2, 0.1], match_quality: 0.83 };
const INSUFFICIENT = { scores: [0.95, 0.9], match_quality: 0.2 };
const WEAK = { scores: [0.6], match_quality: 0.4 };

describe("brain_recall_gate decision_answerable", () => {
  test("alone, without the recall pair, is INVALID_PARAMS", async () => {
    activeWith("shadow");
    await expectInvalid(
      () => tool("brain_recall_gate").handler(ctx(), { prompt: "x", decision_answerable: 0.5 }),
      /decision_answerable/u,
    );
  });

  test("outside [0,1] or not a number is INVALID_PARAMS", async () => {
    activeWith("shadow");
    await expectInvalid(() => gate({ ...SUFFICIENT, decision_answerable: 1.2 }), /\[0,1\]/u);
    await expectInvalid(
      () => gate({ ...SUFFICIENT, decision_answerable: "high" }),
      /finite number/u,
    );
  });

  test("the schema declares the dependency on the pair", () => {
    const schema = tool("brain_recall_gate").inputSchema as {
      dependentRequired: Record<string, string[]>;
    };
    expect(schema.dependentRequired["decision_answerable"]).toEqual(["scores", "match_quality"]);
  });

  test("with no decision config the argument is ignored with one warning", async () => {
    const baseline = await gate(SUFFICIENT);
    const out = await gate({ ...SUFFICIENT, decision_answerable: 0.1 });
    expect(out.adequacy).toEqual(baseline.adequacy);
    expect(out.warnings).toEqual([DECISION_ANSWERABLE_OFF_WARNING]);
    expect(fetchCalls).toBe(0);
  });

  test("enabled without the key is off: ignored with the warning", async () => {
    writeConfig({ ...DECISION, decision_model_uses: "rerank:shadow,answerable:shadow" });
    const out = await gate({ ...SUFFICIENT, decision_answerable: 0.1 });
    expect(out.adequacy?.["decision_answerable"]).toBeUndefined();
    expect(out.warnings).toEqual([DECISION_ANSWERABLE_OFF_WARNING]);
    expect(fetchCalls).toBe(0);
  });

  test("the answerable use off, or another rerank kind, ignores it too", async () => {
    activeWith("off");
    expect((await gate({ ...SUFFICIENT, decision_answerable: 0.1 })).warnings).toEqual([
      DECISION_ANSWERABLE_OFF_WARNING,
    ]);
    writeConfig({
      ...DECISION,
      search_rerank_kind: "local",
      decision_model_uses: "rerank:shadow,answerable:shadow",
    });
    expect((await gate({ ...SUFFICIENT, decision_answerable: 0.1 })).warnings).toEqual([
      DECISION_ANSWERABLE_OFF_WARNING,
    ]);
  });

  test("a call without the argument is unchanged whatever the config", async () => {
    const baseline = await gate(SUFFICIENT);
    activeWith("enforce");
    expect(await gate(SUFFICIENT)).toEqual(baseline);
  });

  for (const mode of ["shadow", "enforce"] as const) {
    test(`${mode}: the verdict gains the field; level and action are unchanged`, async () => {
      activeWith(mode);
      const baseline = await gate(SUFFICIENT);
      const out = await gate({ ...SUFFICIENT, decision_answerable: 0.1 });
      const { decision_answerable: added, ...rest } = out.adequacy!;
      expect(rest).toEqual(baseline.adequacy!);
      expect(added).toEqual({ probability: 0.1, disagrees: true });
      expect(out.warnings).toBeUndefined();
      expect(fetchCalls).toBe(0);
    });
  }

  test("disagrees at the band edges, which are strict", async () => {
    activeWith("shadow");
    expect(await verdict(SUFFICIENT, 0.2999)).toEqual({ probability: 0.2999, disagrees: true });
    expect(await verdict(SUFFICIENT, 0.3)).toEqual({ probability: 0.3, disagrees: false });
    expect(await verdict(INSUFFICIENT, 0.8)).toEqual({ probability: 0.8, disagrees: false });
    expect(await verdict(INSUFFICIENT, 0.8001)).toEqual({ probability: 0.8001, disagrees: true });
    expect(await verdict(INSUFFICIENT, 0.1)).toEqual({ probability: 0.1, disagrees: false });
    expect(await verdict(WEAK, 0)).toEqual({ probability: 0, disagrees: false });
    expect(await verdict(WEAK, 1)).toEqual({ probability: 1, disagrees: false });
  });

  test("with recall_gate_telemetry on, the gate record carries level and probability", async () => {
    process.env[KEY_VAR] = FAKE_DECISION_KEY;
    writeConfig({
      ...DECISION,
      decision_model_uses: "rerank:shadow,answerable:shadow",
      recall_gate_telemetry: "true",
    });
    await gate(SUFFICIENT);
    await gate({ ...SUFFICIENT, decision_answerable: 0.1 });
    // Two records in the same millisecond list by id, not append order.
    const records = listGateTelemetry(vault);
    expect(records).toHaveLength(2);
    const annotated = records.find((r) => r.payload["decision_answerable"] !== undefined);
    const plain = records.find((r) => r.payload["decision_answerable"] === undefined);
    expect(annotated!.payload).toMatchObject({
      adequacy_level: "sufficient",
      decision_answerable: { probability: 0.1, disagrees: true },
    });
    expect(plain!.payload["decision_answerable"]).toBeUndefined();
    expect(plain!.payload["adequacy_level"]).toBeUndefined();
  });

  test("an ignored argument is not recorded", async () => {
    writeConfig({ recall_gate_telemetry: "true" });
    await gate({ ...SUFFICIENT, decision_answerable: 0.1 });
    const [record] = listGateTelemetry(vault);
    expect(record!.payload["decision_answerable"]).toBeUndefined();
  });
});

describe("brain_context_pack decision_answerable", () => {
  interface PackOut {
    adequacy?: Record<string, unknown>;
    receipt_id?: string;
    warnings?: string[];
  }

  async function pack(args: Record<string, unknown>): Promise<PackOut> {
    return (await tool("brain_context_pack").handler(ctx(), {
      max_tokens: 1000,
      ...args,
    })) as PackOut;
  }

  test("alone, without the recall pair, is INVALID_PARAMS", async () => {
    activeWith("shadow");
    await expectInvalid(() => pack({ decision_answerable: 0.5 }), /decision_answerable/u);
  });

  test("off: ignored with a warning; the verdict and the receipt are unchanged", async () => {
    const out = await pack({
      receipt: true,
      recall_scores: INSUFFICIENT.scores,
      match_quality: INSUFFICIENT.match_quality,
      decision_answerable: 0.95,
    });
    expect(out.warnings).toEqual([DECISION_ANSWERABLE_OFF_WARNING]);
    expect(out.adequacy?.["decision_answerable"]).toBeUndefined();
    const shown = (await tool("brain_context_receipts").handler(ctx(), {
      operation: "show",
      id: out.receipt_id,
    })) as { payload: Record<string, unknown> };
    expect(shown.payload["decision_answerable"]).toBeUndefined();
    expect(fetchCalls).toBe(0);
  });

  test("shadow: the verdict and its receipt gain the field; level and action unchanged", async () => {
    activeWith("shadow");
    const pair = {
      recall_scores: INSUFFICIENT.scores,
      match_quality: INSUFFICIENT.match_quality,
    };
    const baseline = await pack(pair);
    const out = await pack({ ...pair, receipt: true, decision_answerable: 0.95 });
    const { decision_answerable: added, ...rest } = out.adequacy!;
    expect(rest).toEqual(baseline.adequacy!);
    expect(added).toEqual({ probability: 0.95, disagrees: true });
    expect(out.warnings).toBeUndefined();
    const shown = (await tool("brain_context_receipts").handler(ctx(), {
      operation: "show",
      id: out.receipt_id,
    })) as { payload: Record<string, unknown> };
    expect(shown.payload["decision_answerable"]).toEqual({ probability: 0.95, disagrees: true });
    expect((shown.payload["adequacy"] as Record<string, unknown>)["level"]).toBe("insufficient");
    expect(fetchCalls).toBe(0);
  });
});

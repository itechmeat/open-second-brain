/**
 * Recall adequacy verdict wiring (retrieval-precision-quality-loop,
 * t_b8f66fec): `brain_recall_gate` returns a verdict when `scores` is
 * supplied, `brain_context_pack` persists it in the receipt, and
 * `brain_context_receipts` surfaces it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { aggregateUnmetRecall } from "../../src/core/brain/query-demand.ts";
import {
  NEGATIVE_RECALL_STATE,
  NEGATIVE_RECALL_STATES,
} from "../../src/core/brain/negative-recall.ts";
import { assertOutputContract } from "../../src/mcp/output-contract.ts";
import { RECALL_GATE_NEGATIVE_STATES } from "../../src/mcp/search-tools.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-adequacy-mcp-"));
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

function tool(name: string) {
  return findTool(buildToolTable("full"), name);
}

test("gate omits adequacy when no scores are supplied", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide?",
  })) as Record<string, unknown>;
  expect(out["retrieve"]).toBe(true);
  expect(out["adequacy"]).toBeUndefined();
});

test("gate returns a sufficient/proceed verdict for strong scores", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide?",
    scores: [0.83, 0.4],
  })) as { adequacy: Record<string, unknown> };
  expect(out.adequacy["level"]).toBe("sufficient");
  expect(out.adequacy["action"]).toBe("proceed");
  expect(out.adequacy["escalate"]).toBe(false);
  expect(out.adequacy["result_count"]).toBe(2);
});

test("gate returns weak/re_recall and insufficient/abstain per scores", async () => {
  const weak = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [0.4],
  })) as { adequacy: Record<string, unknown> };
  expect(weak.adequacy["level"]).toBe("weak");
  expect(weak.adequacy["action"]).toBe("re_recall");

  const insufficient = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [],
  })) as { adequacy: Record<string, unknown> };
  expect(insufficient.adequacy["level"]).toBe("insufficient");
  expect(insufficient.adequacy["action"]).toBe("abstain");
  expect(insufficient.adequacy["escalate"]).toBe(true);
});

test("gate honours configurable thresholds", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_adequacy_sufficient: "0.9"\n`);
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "x",
    scores: [0.7],
  })) as { adequacy: Record<string, unknown> };
  // 0.7 would be sufficient at the default 0.6 floor, but not at 0.9.
  expect(out.adequacy["level"]).toBe("weak");
});

// ----- typed negative recall (U2) -------------------------------------------
//
// The adequacy verdict says the hits were too weak; the negative block
// says what the corpus behind them was. It rides only on the
// zero-usable-result path, where a "no" is otherwise indistinguishable
// from a "no" over an index that was never built.

test("gate attaches a negative block when the query yields no usable result", async () => {
  const gate = tool("brain_recall_gate");
  const out = (await gate.handler(ctx(), {
    prompt: "reactor coolant",
    scores: [],
  })) as { negative?: Record<string, unknown> };
  // The server enforces the declared output schema on every call, so the
  // block and its declaration have to agree here rather than in
  // production. Handler-level tests otherwise never see that check.
  assertOutputContract(gate.name, gate.outputSchema, out);
  expect(out.negative).toBeDefined();
  // No index exists in this temp vault, so the honest answer is that
  // nothing is known about the corpus - never a silent not_found.
  expect(out.negative!["state"]).toBe("unknown");
  expect(out.negative!["unknown_reason"]).toBe("index-absent");
  expect(out.negative!["complete"]).toBe(false);
  expect(out.negative!["coverage"]).toBeUndefined();
});

test("gate omits the negative block entirely when scores are usable", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
    scores: [0.83],
  })) as Record<string, unknown>;
  expect(out["adequacy"]).toBeDefined();
  // Absent, never null - the convention the explain trace already sets.
  expect("negative" in out).toBe(false);
});

test("gate omits the negative block when no scores are supplied at all", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
  })) as Record<string, unknown>;
  expect("negative" in out).toBe(false);
});

function writeMd(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

async function buildIndex(): Promise<void> {
  await indexVault(resolveSearchConfig({ vault, configPath }));
}

test("over a keyword-only index a zero-result attempt is a not_found the receipt qualifies", async () => {
  writeMd("notes/coolant.md", "# Coolant\n\nThe reactor coolant loop was replaced in March.\n");
  await buildIndex();
  const gate = tool("brain_recall_gate");
  const out = (await gate.handler(ctx(), {
    prompt: "reactor coolant",
    scores: [],
  })) as { negative: Record<string, unknown> };
  // The populated-receipt shape has to clear the contract too.
  assertOutputContract(gate.name, gate.outputSchema, out);
  // No embedding provider is configured here, so the run built chunks and
  // recorded no model. That is a supported way to run this system, not an
  // unfinished job, so the negative is admitted rather than refused - a
  // vault without an embedding key would otherwise never be able to
  // receive this answer at all.
  expect(out.negative["state"]).toBe("not_found");
  expect(out.negative["complete"]).toBe(true);
  // What makes admitting it honest: the receipt says the search was
  // keyword-only, and the digest binds that, so the narrower claim is
  // visible to whoever reads the negative rather than implied by silence.
  const coverage = out.negative["coverage"] as Record<string, unknown>;
  expect(coverage["digest"]).toMatch(/^[0-9a-f]{64}$/);
  expect(coverage["documents"]).toBe(1);
  expect(coverage["embeddings"]).toBe(0);
  expect(coverage["embedding_signature"]).toBeNull();
  expect(coverage["chunks"]).toBeGreaterThan(0);
  expect(coverage["unindexed_roots"]).toEqual([]);
});

test("the gate declares only the negative states its handler can produce", async () => {
  // The gate reads no claim graph, so it supplies neither retraction
  // evidence nor the assertion, so `did_not_happen` is unreachable here.
  // Advertising it would leave a client unable to tell "this surface
  // cannot say that" from "it did not happen this time".
  const gate = tool("brain_recall_gate");
  const negative = gate.outputSchema?.properties?.["negative"];
  const declared = negative?.properties?.["state"]?.enum;
  expect(declared).toEqual([...RECALL_GATE_NEGATIVE_STATES]);
  expect(declared).not.toContain(NEGATIVE_RECALL_STATE.didNotHappen);
  // Not merely documentary: the server validates every response against
  // this schema, so a future producer of the third state fails loudly
  // here rather than emitting an undeclared value.
  expect([...NEGATIVE_RECALL_STATES]).toContain(NEGATIVE_RECALL_STATE.didNotHappen);
});

test("an authorized note root the index never reached forces unknown and names it", async () => {
  writeMd("notes/coolant.md", "# Coolant\n\nThe reactor coolant loop was replaced in March.\n");
  await buildIndex();
  // Declared AFTER the index run and holding no indexed document: the
  // authorized universe and the searched universe now disagree.
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\nnotes:\n  read_paths:\n    - notes\n    - archive\n",
  );
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
    scores: [],
  })) as { negative: Record<string, unknown> };
  expect(out.negative["state"]).toBe("unknown");
  expect(out.negative["unknown_reason"]).toBe("coverage-divergent");
  const coverage = out.negative["coverage"] as Record<string, unknown>;
  expect(coverage["scope"]).toEqual(["notes"]);
  expect(coverage["unindexed_roots"]).toEqual(["archive"]);
});

test("gate rejects a malformed scores argument", async () => {
  await expect(
    tool("brain_recall_gate").handler(ctx(), { prompt: "x", scores: ["nope"] }),
  ).rejects.toThrow();
});

test("context_pack persists the verdict into the receipt and returns it", async () => {
  const packed = (await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    receipt: true,
    recall_scores: [0.2, 0.1],
  })) as { adequacy?: Record<string, unknown>; receipt_id?: string };
  expect(packed.adequacy).toBeDefined();
  expect(packed.adequacy!["level"]).toBe("insufficient");
  expect(packed.receipt_id).toBeDefined();

  const summaries = (await tool("brain_context_receipts").handler(ctx(), {
    operation: "list",
  })) as { receipts: Array<{ adequacy?: Record<string, unknown> }> };
  expect(summaries.receipts.length).toBeGreaterThan(0);
  const withVerdict = summaries.receipts.find((r) => r.adequacy);
  expect(withVerdict?.adequacy?.["level"]).toBe("insufficient");
  expect(withVerdict?.adequacy?.["action"]).toBe("abstain");

  const shown = (await tool("brain_context_receipts").handler(ctx(), {
    operation: "show",
    id: packed.receipt_id,
  })) as { payload: Record<string, unknown> };
  const adequacy = shown.payload["adequacy"] as Record<string, unknown>;
  expect(adequacy["level"]).toBe("insufficient");
  expect(adequacy["top_score"]).toBeCloseTo(0.2);
});

test("context_pack omits adequacy when recall_scores is absent", async () => {
  const packed = (await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    receipt: true,
  })) as { adequacy?: unknown };
  expect(packed.adequacy).toBeUndefined();
});

// ----- one feature, one opt-in ---------------------------------------------
//
// The unmet-verdict stamp on the cross-query demand log is ONE durable
// write reachable from two surfaces. It is gated by the
// `recall_gate_telemetry` config key on both - never by the pack's own
// per-call `telemetry` argument, which selects whether that call emits its
// OWN continuity records and says nothing about this log.

function unmetTopics(): ReadonlyArray<string> {
  return aggregateUnmetRecall(vault).map((bucket) => bucket.key);
}

test("with the flag off neither surface writes the demand log", async () => {
  await tool("brain_recall_gate").handler(ctx(), { prompt: "reactor coolant", scores: [] });
  await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    query: "reactor coolant",
    recall_scores: [],
    telemetry: true,
  });
  expect(unmetTopics()).toEqual([]);
});

test("with the flag on both surfaces write it, pack telemetry argument or not", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), { prompt: "reactor coolant", scores: [] });
  expect(unmetTopics().length).toBeGreaterThan(0);

  const before = unmetTopics().length;
  await tool("brain_context_pack").handler(ctx(), {
    max_tokens: 1000,
    query: "turbine bearing vibration",
    recall_scores: [],
  });
  expect(unmetTopics().length).toBeGreaterThan(before);
});

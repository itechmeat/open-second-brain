/**
 * `brain_recall_gate` telemetry emission + `brain_recall_telemetry`
 * gate operations (Workspace Insight Suite, t_65036e02).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { listGateTelemetry } from "../../src/core/brain/gate-telemetry.ts";
import { buildToolTable, findTool } from "../../src/mcp/tools.ts";
import type { ServerContext } from "../../src/mcp/tool-contract.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-gate-mcp-"));
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

test("default off: the gate emits no telemetry", async () => {
  const decision = (await tool("brain_recall_gate").handler(ctx(), { prompt: "/help" })) as {
    retrieve: boolean;
  };
  expect(decision.retrieve).toBe(false);
  expect(listGateTelemetry(vault)).toHaveLength(0);
});

test("with recall_gate_telemetry on, decisions land as continuity records", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    telemetry_host: "hermes",
    session_id: "sess-1",
  });
  await tool("brain_recall_gate").handler(ctx(), { prompt: "/help" });
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(2);
  expect(records.some((r) => r.payload["decision"] === "retrieve")).toBe(true);
  expect(records.some((r) => r.payload["decision"] === "skip")).toBe(true);
  expect(records.some((r) => r.payload["host"] === "hermes")).toBe(true);
  // The raw prompt never lands on disk - assert against the PERSISTED
  // continuity files, not just the returned payloads, so a serializer
  // regression cannot slip through.
  for (const record of records) {
    expect(JSON.stringify(record.payload)).not.toContain("what did we decide");
  }
  const continuityDir = join(vault, "Brain", "log", "continuity");
  for (const name of readdirSync(continuityDir, { recursive: true }) as string[]) {
    const filePath = join(continuityDir, name);
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue; // directories
    }
    expect(content).not.toContain("what did we decide");
  }

  const summary = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_summary",
  })) as { total: number; retrieved: number; skipped: number };
  expect(summary.total).toBe(2);
  expect(summary.retrieved).toBe(1);
  expect(summary.skipped).toBe(1);

  const listed = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_list",
    limit: 1,
  })) as { total: number; records: unknown[] };
  expect(listed.total).toBe(1);
});

test("fail-open: a broken continuity store never breaks the gate decision", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  // The continuity directory path exists as a FILE, so every append throws.
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory");
  const decision = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
  })) as { retrieve: boolean; reason: string };
  expect(typeof decision.retrieve).toBe("boolean");
  expect(typeof decision.reason).toBe("string");

  // The same contract on the negative-recall path, whose record is the
  // third write this one handler makes.
  const negative = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [],
    match_quality: 0,
  })) as { retrieve: boolean; negative?: Record<string, unknown> };
  expect(typeof negative.retrieve).toBe("boolean");
  expect(negative.negative?.["state"]).toBe("unknown");
});

// ----- typed negative recall (U2) -------------------------------------------
//
// Persisted behind the SAME `recall_gate_telemetry` opt-in as the gate
// record and the unmet-demand stamp: one config decision per feature, not
// one per surface.

function negativeRecallRecords() {
  return listContinuityRecords(vault, { kind: "negative_recall" });
}

test("default off: a negative verdict writes no continuity record", async () => {
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
    scores: [],
    match_quality: 0,
  })) as { negative?: unknown };
  expect(out.negative).toBeDefined();
  expect(negativeRecallRecords()).toHaveLength(0);
});

test("with the opt-in on, a negative verdict lands as a continuity record", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
    scores: [],
    match_quality: 0,
  });
  const records = negativeRecallRecords();
  expect(records).toHaveLength(1);
  expect(records[0]!.payload["state"]).toBe("unknown");
  expect(records[0]!.payload["unknown_reason"]).toBe("index-absent");
  expect(records[0]!.payload["complete"]).toBe(false);
  // The prompt privacy invariant holds here too: only a hash lands.
  expect(JSON.stringify(records[0]!.payload)).not.toContain("reactor coolant");
  expect(typeof records[0]!.payload["prompt_hash"]).toBe("string");
  // A host filesystem path is not vault content and must not replicate.
  // Judge the JSON-escaped form: on win32 hosts a leaked path serializes
  // with doubled backslashes, so the raw tmp string can never match and
  // the invariant would silently stop being enforced.
  expect(JSON.stringify(records[0]!.payload)).not.toContain(JSON.stringify(tmp).slice(1, -1));
});

test("a usable-score call writes no negative record even with the opt-in on", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "reactor coolant",
    scores: [0.9],
    match_quality: 0.9,
  });
  expect(negativeRecallRecords()).toHaveLength(0);
});

// ----- graded surfacing telemetry (t_107a3249, lane C Task 14) ---------------

test("a measured call grades the verdict: below_floor refuses and records a skip", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.9],
    match_quality: 0.2,
  })) as Record<string, unknown>;
  // The graded admission decides the binary verdict when a measurement
  // rides the call: a below-floor quality is a refusal, so `retrieve`
  // and `admit` agree with the tier instead of contradicting it.
  expect(out["retrieve"]).toBe(false);
  expect(out["admit"]).toBe(false);
  expect(out["key"]).toBe(0.2);
  expect(out["tier"]).toBe("below_floor");
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(1);
  // The record's decision agrees with the admission: a below-floor call
  // is a skip, never a retrieved one.
  expect(records[0]!.payload["decision"]).toBe("skip");
  expect(records[0]!.payload["key"]).toBe(0.2);
  expect(records[0]!.payload["tier"]).toBe("below_floor");
  expect(records[0]!.payload["channel"]).toBe("mcp");
  // The privacy invariant holds for the graded payload: numbers land, the
  // prompt never does.
  expect(JSON.stringify(records[0]!.payload)).not.toContain("what did we decide");
  // The summary agrees: a below-floor measured call is not counted as
  // retrieved.
  const summary = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_summary",
  })) as { retrieved: number; skipped: number };
  expect(summary.retrieved).toBe(0);
  expect(summary.skipped).toBe(1);
});

test("a measured admitted call retrieves, admits and records a retrieve", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.9],
    match_quality: 0.8,
  })) as Record<string, unknown>;
  expect(out["retrieve"]).toBe(true);
  expect(out["admit"]).toBe(true);
  expect(out["tier"]).toBe("admitted");
  const records = listGateTelemetry(vault);
  expect(records[0]!.payload["decision"]).toBe("retrieve");
});

test("an unmeasured call records no key or tier and keeps the structural verdict", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  const out = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
  })) as Record<string, unknown>;
  expect("key" in out).toBe(false);
  expect("tier" in out).toBe(false);
  // Without a measurement the structural fail-open stands and `admit`
  // names it: the binary verdict is the structural one, unchanged.
  expect(out["retrieve"]).toBe(true);
  expect(out["admit"]).toBe(true);
  const records = listGateTelemetry(vault);
  expect(records).toHaveLength(1);
  expect("key" in records[0]!.payload).toBe(false);
  expect("tier" in records[0]!.payload).toBe(false);
  expect(records[0]!.payload["decision"]).toBe("retrieve");
  // The transport is recorded only on measured decisions: an unmeasured
  // structural verdict is already described by decision and reason.
  expect("channel" in records[0]!.payload).toBe(false);
});

test("a boundary quality grades admitted through the mcp channel constant", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.5],
    match_quality: 0.35,
  });
  const records = listGateTelemetry(vault);
  expect(records[0]!.payload["tier"]).toBe("admitted");
});

test("a suppressed prompt grades suppressed with a null key, never a measured one", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "git status",
    scores: [0.9],
    match_quality: 0.9,
  });
  const records = listGateTelemetry(vault);
  expect(records[0]!.payload["tier"]).toBe("suppressed");
  expect(records[0]!.payload["key"]).toBeNull();
  expect(records[0]!.payload["decision"]).toBe("skip");
});

test("gate_summary summarizes counts by tier", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.9],
    match_quality: 0.2,
  });
  await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.9],
    match_quality: 0.8,
  });
  // Unmeasured: counted in by_reason as always, absent from by_tier.
  await tool("brain_recall_gate").handler(ctx(), { prompt: "/help" });
  const summary = (await tool("brain_recall_telemetry").handler(ctx(), {
    operation: "gate_summary",
  })) as {
    total: number;
    retrieved: number;
    skipped: number;
    by_reason: Record<string, number>;
    by_tier: Record<string, number>;
  };
  expect(summary.total).toBe(3);
  expect(summary.by_tier).toEqual({ below_floor: 1, admitted: 1 });
  expect(summary.by_reason["slash_command"]).toBe(1);
  // The below-floor measured call is a skip under the graded verdict:
  // only the admitted call counts as retrieved.
  expect(summary.retrieved).toBe(1);
  expect(summary.skipped).toBe(2);
});

test("fail-open: a broken store never breaks the graded response", async () => {
  writeFileSync(configPath, `vault: "${vault}"\nrecall_gate_telemetry: "true"\n`);
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(join(vault, "Brain", "log", "continuity"), "not a directory");
  const decision = (await tool("brain_recall_gate").handler(ctx(), {
    prompt: "what did we decide about the index?",
    scores: [0.9],
    match_quality: 0.2,
  })) as Record<string, unknown>;
  expect(typeof decision["retrieve"]).toBe("boolean");
  expect(decision["admit"]).toBe(false);
  expect(decision["key"]).toBe(0.2);
  expect(decision["tier"]).toBe("below_floor");
});

/**
 * `brain_tension verify` (issue #213, Part 5, use `tension`) through the
 * MCP tool, the real config resolution, the `systemone` adapter and a
 * loopback fake server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NoteContradictionFinding } from "../../../src/core/brain/health/contradiction.ts";
import { listTensions, persistTension } from "../../../src/core/brain/tensions.ts";
import { verifyTensions } from "../../../src/core/brain/tension-verdicts.ts";
import {
  emitDecisionModelCall,
  listDecisionModelCalls,
  resetDecisionSpendCache,
} from "../../../src/core/decision-model/record.ts";
import {
  activeDecisionConfig,
  startFakeSystemOne,
  type FakeSystemOne,
} from "../../helpers/fake-decision-provider.ts";
import { choiceReply, FakeChoiceProvider } from "../../helpers/fake-choice-decision.ts";
import {
  callTool,
  countFetch,
  decisionEntries,
  mcpServer,
  setKey,
  writeConfig,
} from "../../helpers/advisory-decision-harness.ts";
import { digestVaultFiles } from "../../helpers/vault-digest.ts";

let server: FakeSystemOne;
let root: string;
let vault: string;
let fetchCounter: ReturnType<typeof countFetch>;

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

function note(rel: string, body: string, extra: string[] = []): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, ["---", "title: t", ...extra, "---", "", body, ""].join("\n"));
}

function seed(aId: string, bId: string, aQuote: string, bQuote: string): string {
  const finding: NoteContradictionFinding = {
    aId,
    bId,
    subject: "tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote,
    bQuote,
    action: "ask_user",
  };
  return persistTension(vault, finding, { agent: "tester" }).record.slug;
}

let quotedSlug: string;
let clashSlug: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-dm-tension-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  note("notes/tabs.md", "Always use tabs.");
  note("notes/spaces.md", "Never use tabs.");
  note("notes/quote.md", "Someone wrote: never use tabs. We disagree.");
  clashSlug = seed("notes/spaces.md", "notes/tabs.md", "Never use tabs.", "Always use tabs.");
  quotedSlug = seed("notes/quote.md", "notes/tabs.md", "never use tabs", "Always use tabs.");
  server.requests.length = 0;
  setKey(false);
  fetchCounter = countFetch();
});
afterEach(() => {
  fetchCounter.restore();
  setKey(false);
  rmSync(root, { recursive: true, force: true });
});

function scriptedReply(): void {
  server.setReply((req) => {
    const pairs = (req.body["state"] as { pairs: Record<string, string> }).pairs;
    return {
      json: choiceReply(req, (id) => {
        const k = id.slice("pair_".length);
        return (pairs[`A${k}`] ?? "").startsWith("never")
          ? { choice: "compatible", p: 0.93 }
          : { choice: "contradicts", p: 0.88 };
      }),
    };
  });
}

async function verify(configPath: string, args: Record<string, unknown> = {}) {
  const mcp = await mcpServer(vault, configPath);
  const reply = await callTool(mcp, "brain_tension", { action: "verify", ...args });
  expect(reply.isError).toBe(false);
  return reply.payload!;
}

type Row = Record<string, unknown>;

describe("brain_tension verify: activation", () => {
  test("1-3: unavailable, rows as `list --unresolved`, no request", async () => {
    const mcp = await mcpServer(vault, writeConfig(root, {}));
    const listed = (await callTool(mcp, "brain_tension", { action: "list", unresolved: true }))
      .payload!["tensions"];
    const expected = {
      action: "verify",
      available: false,
      reason: "decision_model_off",
      tensions: listed,
    };

    expect(await verify(writeConfig(root, {}))).toEqual(expected);
    setKey(true);
    const notEnabled = {
      ...decisionEntries(server, "tension:enforce"),
      decision_model_enabled: "false",
    };
    expect(await verify(writeConfig(root, notEnabled))).toEqual(expected);
    setKey(false);
    expect(await verify(writeConfig(root, decisionEntries(server, "tension:enforce")))).toEqual(
      expected,
    );
    expect(fetchCounter.calls()).toBe(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("4, shadow: rows unchanged, mode shadow, one request and record", async () => {
    setKey(true);
    scriptedReply();
    const out = await verify(writeConfig(root, decisionEntries(server, "tension:shadow")));
    expect(out["available"]).toBe(true);
    expect(out["mode"]).toBe("shadow");
    const rows = out["tensions"] as Row[];
    expect(rows.map((r) => r["slug"])).toEqual(listTensions(vault).map((t) => t.slug));
    expect(rows.every((r) => r["decision_model"] === undefined)).toBe(true);
    expect(server.requests).toHaveLength(1);
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["use"]).toBe("tension");
    expect((record["pairs"] as Row[]).map((p) => p["id"]).toSorted()).toEqual(
      [clashSlug, quotedSlug].toSorted(),
    );
    expect(JSON.stringify(record)).not.toContain("use tabs");
  });

  test("4, enforce: verdicts, a confident `compatible` listed last and marked", async () => {
    setKey(true);
    scriptedReply();
    const before = listTensions(vault);
    const out = await verify(writeConfig(root, decisionEntries(server, "tension:enforce")));
    const rows = out["tensions"] as Row[];
    expect(rows).toHaveLength(2);
    expect(rows[1]!["slug"]).toBe(quotedSlug);
    expect(rows[1]!["decision_model_low_priority"]).toBe(true);
    expect(rows[1]!["decision_model"]).toMatchObject({ verdict: "compatible", calibrated: true });
    expect(rows[0]!["decision_model"]).toMatchObject({ verdict: "contradicts" });
    // Detection, persistence and status are untouched.
    expect(listTensions(vault)).toEqual(before);
  });

  test("4, a slug verifies that tension only", async () => {
    setKey(true);
    scriptedReply();
    const out = await verify(writeConfig(root, decisionEntries(server, "tension:enforce")), {
      slug: clashSlug,
    });
    expect((out["tensions"] as Row[]).map((r) => r["slug"])).toEqual([clashSlug]);
  });

  test("4, a provider failure: unavailable with the reason, rows unchanged", async () => {
    setKey(true);
    server.setReply(() => ({ status: 401, json: {} }));
    const out = await verify(writeConfig(root, decisionEntries(server, "tension:enforce")));
    expect(out["available"]).toBe(false);
    expect(out["reason"]).toBe("http_401");
    expect((out["tensions"] as Row[]).every((r) => r["decision_model"] === undefined)).toBe(true);
  });
});

describe("tension verify privacy and writes", () => {
  const enforce = () =>
    activeDecisionConfig({
      vault,
      uses: { ...activeDecisionConfig().uses, rerank: "off", tension: "enforce" },
    });

  test("a private subject note is never sent and its tension gets no verdict", async () => {
    note("notes/spaces.md", "Never use tabs.", ["visibility: private"]);
    const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }));
    const out = await verifyTensions(vault, listTensions(vault), { config: enforce(), provider });
    expect(out.available).toBe(true);
    const clash = out.rows.find((r) => r.item.slug === clashSlug)!;
    expect(clash.verdict).toBeNull();
    expect(JSON.stringify(provider.requests)).not.toContain("Never use tabs.");
  });

  test("an unresolvable subject is never sent", async () => {
    const orphan = seed("notes/gone.md", "notes/tabs.md", "Gone quote", "Always use tabs.");
    const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }));
    const out = await verifyTensions(vault, listTensions(vault), { config: enforce(), provider });
    expect(out.rows.find((r) => r.item.slug === orphan)!.verdict).toBeNull();
    expect(JSON.stringify(provider.requests)).not.toContain("Gone quote");
  });

  test("a frontmatter id two notes declare resolves to nothing and is never sent", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nnotes:\n  read_paths:\n    - notes\n",
    );
    note("notes/a-twin.md", "Use tabs here.", ["id: note-twin"]);
    note("notes/z-twin.md", "Use tabs here.", ["id: note-twin"]);
    note("notes/solo.md", "Keep spaces.", ["id: note-solo"]);
    const twin = seed("note-twin", "note-solo", "Use tabs here.", "Keep spaces.");
    const solo = seed("note-solo", "notes/tabs.md", "Keep spaces.", "Always use tabs.");
    const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }));
    const out = await verifyTensions(vault, listTensions(vault), { config: enforce(), provider });
    expect(out.rows.find((r) => r.item.slug === twin)!.verdict).toBeNull();
    expect(out.rows.find((r) => r.item.slug === solo)!.verdict?.verdict).toBe("contradicts");
    expect(JSON.stringify(provider.requests)).not.toContain("Use tabs here.");
  });

  for (const reason of ["timeout", "network", "http_529", "invalid_reply", "budget"] as const) {
    test(`a ${reason} failure: unavailable with the reason, no verdicts`, async () => {
      const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }), {
        fail: reason,
      });
      const out = await verifyTensions(vault, listTensions(vault), { config: enforce(), provider });
      expect(out).toMatchObject({ available: false, reason });
      expect(out.rows.every((r) => r.verdict === null)).toBe(true);
    });
  }

  test("the cost gate: unavailable with cost_gate, nothing sent", async () => {
    // Today's recorded spend is already over the gate.
    emitDecisionModelCall(vault, {
      use: "tension",
      mode: "enforce",
      provider: "fake",
      model: "fake-choice-1",
      calibrated: true,
      questionCount: 1,
      candidateCount: 1,
      usage: { costUsd: 1 },
      inputPriceUsdPerMtok: null,
      latencyMs: 1,
      outcome: "ok",
    });
    resetDecisionSpendCache();
    const provider = new FakeChoiceProvider(() => ({ choice: "contradicts", p: 0.9 }));
    const out = await verifyTensions(vault, listTensions(vault), {
      config: { ...enforce(), dailyCostGateUsd: 0.5 },
      provider,
    });
    expect(out).toMatchObject({ available: false, reason: "cost_gate" });
    expect(provider.requests).toHaveLength(0);
  });

  test("the vault tree is unchanged apart from the accounting log", async () => {
    const before = digestVaultFiles(vault);
    const provider = new FakeChoiceProvider(() => ({ choice: "unrelated", p: 0.99 }));
    const out = await verifyTensions(vault, listTensions(vault), { config: enforce(), provider });
    expect(out.rows.every((r) => r.lowPriority)).toBe(true);
    const after = digestVaultFiles(vault);
    for (const key of Array.from(after.keys()))
      if (key.startsWith("Brain/log/continuity/")) after.delete(key);
    expect(after).toEqual(before);
  });
});

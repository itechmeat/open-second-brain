/**
 * `brain_labels suggest` (issue #213, Part 6, use `labels`) through the
 * MCP tool, the real config resolution, the `systemone` adapter and a
 * loopback fake server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LabelSuggestPrivateNoteError,
  suggestNoteLabels,
} from "../../../src/core/brain/label-suggest.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { listDecisionModelCalls } from "../../../src/core/decision-model/record.ts";
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

let server: FakeSystemOne;
let root: string;
let vault: string;
let fetchCounter: ReturnType<typeof countFetch>;

const SCHEMA = [
  "schema_version: 1",
  "schema:",
  "  labels:",
  "    - priority=low",
  "    - priority=high",
  "    - area=work",
  "    - area=home",
].join("\n");

beforeAll(async () => {
  server = await startFakeSystemOne();
});
afterAll(async () => {
  await server.close();
});

const NOTE = "notes/plan.md";
const NOTE_TEXT = [
  "---",
  "title: Quarterly plan",
  "labels: [area/home]",
  "---",
  "",
  "Ship the release before the deadline.",
  "<private>",
  "salary figures here",
  "</private>",
  "",
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-dm-labels-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), `${SCHEMA}\n`);
  writeFileSync(join(vault, NOTE), NOTE_TEXT);
  writeFileSync(
    join(vault, "notes", "secret.md"),
    "---\nvisibility: private\n---\n\nprivate thoughts\n",
  );
  server.requests.length = 0;
  setKey(false);
  fetchCounter = countFetch();
});
afterEach(() => {
  fetchCounter.restore();
  setKey(false);
  rmSync(root, { recursive: true, force: true });
});

/** `priority` -> high (confident), `area` -> work (not confident). */
function scriptedReply(): void {
  server.setReply((req) => ({
    json: choiceReply(req, (_id, options) =>
      options.includes("high") ? { choice: "high", p: 0.9 } : { choice: "work", p: 0.55 },
    ),
  }));
}

async function suggest(configPath: string, args: Record<string, unknown> = {}) {
  const mcp = await mcpServer(vault, configPath);
  return callTool(mcp, "brain_labels", { operation: "suggest", path: NOTE, ...args });
}

type Dim = Record<string, unknown>;

describe("brain_labels suggest: activation", () => {
  test("1-3: `available: false` with `decision_model_off`, not an error, no request", async () => {
    const expected = { available: false, reason: "decision_model_off", path: NOTE };
    expect((await suggest(writeConfig(root, {}))).payload).toEqual(expected);
    setKey(true);
    const notEnabled = {
      ...decisionEntries(server, "labels:enforce"),
      decision_model_enabled: "false",
    };
    expect((await suggest(writeConfig(root, notEnabled))).payload).toEqual(expected);
    setKey(false);
    const noKey = await suggest(writeConfig(root, decisionEntries(server, "labels:enforce")));
    expect(noKey.isError).toBe(false);
    expect(noKey.payload).toEqual(expected);
    expect(fetchCounter.calls()).toBe(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("4, enforce: one request, suggestions, current labels, the note unchanged", async () => {
    setKey(true);
    scriptedReply();
    const out = (await suggest(writeConfig(root, decisionEntries(server, "labels:enforce"))))
      .payload!;
    expect(out["available"]).toBe(true);
    expect(out["mode"]).toBe("enforce");
    const dims = out["dimensions"] as Dim[];
    const priority = dims.find((d) => d["dimension"] === "priority")!;
    expect(Object.keys(priority).toSorted()).toEqual(
      [
        "dimension",
        "suggestion",
        "probabilities",
        "confidence",
        "current",
        "model",
        "calibrated",
      ].toSorted(),
    );
    expect(priority["suggestion"]).toBe("high");
    expect(priority["current"]).toBeNull();
    expect(priority["model"]).toBe("fake-model-1.0");
    const area = dims.find((d) => d["dimension"] === "area")!;
    expect(area["suggestion"]).toBeNull(); // confidence below the threshold
    expect(area["current"]).toBe("home");
    expect(server.requests).toHaveLength(1);
    const body = server.requests[0]!.bodyText;
    expect(body).toContain("Ship the release");
    expect(body).not.toContain("salary figures");
    expect(readFileSync(join(vault, NOTE), "utf8")).toBe(NOTE_TEXT);
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["note_path"]).toBe(NOTE);
    expect(JSON.stringify(record)).not.toContain("Ship the release");
  });

  test("4, shadow: null suggestions everywhere, `mode: shadow`, one record", async () => {
    setKey(true);
    scriptedReply();
    const out = (await suggest(writeConfig(root, decisionEntries(server, "labels:shadow"))))
      .payload!;
    expect(out["mode"]).toBe("shadow");
    for (const d of out["dimensions"] as Dim[]) {
      expect(d["suggestion"]).toBeNull();
      expect(d["probabilities"]).toBeNull();
    }
    const record = listDecisionModelCalls(vault)[0]!.payload;
    expect(record["mode"]).toBe("shadow");
    const recorded = record["dimensions"] as Dim[];
    expect(recorded.find((d) => d["dimension"] === "priority")!["suggested"]).toBe("high");
  });

  test("4, a provider failure: `available: false` with the reason", async () => {
    setKey(true);
    server.setReply(() => ({ status: 422, json: {} }));
    const out = (await suggest(writeConfig(root, decisionEntries(server, "labels:enforce"))))
      .payload!;
    expect(out).toEqual({ available: false, reason: "http_422", path: NOTE });
  });

  test("a private note is refused with an error and nothing is sent", async () => {
    setKey(true);
    scriptedReply();
    const out = await suggest(writeConfig(root, decisionEntries(server, "labels:enforce")), {
      path: "notes/secret.md",
    });
    // At the tool, a page reserved against remote reads answers as absent.
    expect(out.isError).toBe(true);
    expect(server.requests).toHaveLength(0);
  });

  test("unknown dimensions are refused like `assign`", async () => {
    setKey(true);
    const out = await suggest(writeConfig(root, decisionEntries(server, "labels:enforce")), {
      dimensions: ["colour"],
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("unknown label dimension");
    expect(server.requests).toHaveLength(0);
  });
});

describe("suggestNoteLabels", () => {
  const enforce = () =>
    activeDecisionConfig({
      vault,
      uses: { ...activeDecisionConfig().uses, rerank: "off", labels: "enforce" },
    });

  test("`none` gives null; requested dimensions only", async () => {
    const provider = new FakeChoiceProvider((_id, options) => ({
      choice: options.find((o) => o.includes("none"))!,
      p: 0.99,
    }));
    const out = await suggestNoteLabels(vault, NOTE, {
      pack: parseSchemaPack(`${SCHEMA}\n`),
      dimensions: ["priority"],
      config: enforce(),
      provider,
    });
    expect(out.available && out.dimensions.map((d) => [d.dimension, d.suggestion])).toEqual([
      ["priority", null],
    ]);
    expect(out.available && out.dimensions[0]!.probabilities?.["none"]).toBeCloseTo(0.99);
    expect(Object.keys(provider.requests[0]!.questions)).toEqual(["dim_0"]);
  });

  test("a private note is refused with a clear error and nothing is sent", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "low", p: 0.9 }));
    await expect(
      suggestNoteLabels(vault, "notes/secret.md", {
        pack: parseSchemaPack(`${SCHEMA}\n`),
        config: enforce(),
        provider,
      }),
    ).rejects.toThrow(LabelSuggestPrivateNoteError);
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("a dimension with more than 254 values is skipped with a reason", async () => {
    const many = Array.from({ length: 255 }, (_, i) => `    - big=v${i}`);
    const pack = parseSchemaPack(`${SCHEMA}\n${many.join("\n")}\n`);
    const provider = new FakeChoiceProvider(() => ({ choice: "low", p: 0.9 }));
    const out = await suggestNoteLabels(vault, NOTE, { pack, config: enforce(), provider });
    expect(out.available && out.skipped).toEqual([{ dimension: "big", reason: "too_many_values" }]);
    expect(out.available && out.dimensions.map((d) => d.dimension).toSorted()).toEqual([
      "area",
      "priority",
    ]);
  });

  test("a dimension above the route's option limit is skipped, the others are asked", async () => {
    const many = Array.from({ length: 52 }, (_, i) => `    - big=v${i}`);
    const pack = parseSchemaPack(`${SCHEMA}\n${many.join("\n")}\n`);
    const provider = new FakeChoiceProvider(() => ({ choice: "low", p: 0.9 }));
    const out = await suggestNoteLabels(vault, NOTE, {
      pack,
      config: { ...enforce(), maxChoiceOptions: 52 },
      provider,
    });
    expect(out.available && out.skipped).toEqual([{ dimension: "big", reason: "too_many_values" }]);
    expect(provider.requests).toHaveLength(1);
  });

  test("a declared value `none` stays apart from the none-of-these option", async () => {
    const pack = parseSchemaPack(`${SCHEMA}\n    - status=none\n    - status=done\n`);
    const provider = new FakeChoiceProvider((_id, options) =>
      options.includes("_none") ? { choice: "none", p: 0.9 } : undefined,
    );
    const out = await suggestNoteLabels(vault, NOTE, {
      pack,
      dimensions: ["status"],
      config: enforce(),
      provider,
    });
    if (!out.available) throw new Error("expected available");
    const status = out.dimensions[0]!;
    expect(status.suggestion).toBe("none");
    expect(Object.keys(status.probabilities ?? {}).toSorted()).toEqual(["_none", "done", "none"]);
    expect(status.probabilities?.["none"]).toBeCloseTo(0.9);
  });

  for (const reason of ["timeout", "network", "http_503", "invalid_reply"] as const) {
    test(`a ${reason} failure answers available: false with the reason, nothing written`, async () => {
      const provider = new FakeChoiceProvider(() => ({ choice: "low", p: 0.9 }), { fail: reason });
      const out = await suggestNoteLabels(vault, NOTE, {
        pack: parseSchemaPack(`${SCHEMA}\n`),
        config: enforce(),
        provider,
      });
      expect(out).toMatchObject({ available: false, reason });
      expect(listDecisionModelCalls(vault).map((r) => r.payload["outcome"])).toEqual([reason]);
    });
  }

  test("a state over max_state_tokens degrades with budget and sends nothing", async () => {
    const provider = new FakeChoiceProvider(() => ({ choice: "low", p: 0.9 }));
    const out = await suggestNoteLabels(vault, NOTE, {
      pack: parseSchemaPack(`${SCHEMA}\n`),
      config: { ...enforce(), maxStateTokens: 20 },
      provider,
    });
    expect(out).toMatchObject({ available: false, reason: "budget" });
    expect(provider.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault).map((r) => r.payload["outcome"])).toEqual(["budget"]);
  });
});

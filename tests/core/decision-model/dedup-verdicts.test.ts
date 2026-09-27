/**
 * Advisory `dedup` verdicts (issue #213, Part 5) on `brain_hygiene scan`
 * preference findings and on the doctor's entity alias-merge candidates,
 * through the real config resolution, the `systemone` adapter and a
 * loopback fake server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { annotateDedupFindings } from "../../../src/core/brain/hygiene/dedup-verdicts.ts";
import { runHygieneScan } from "../../../src/core/brain/hygiene/scan.ts";
import { annotateEntityAliasIssues } from "../../../src/core/brain/doctor/entity-alias-verdicts.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
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

function writePref(slug: string, topic: string, principle: string, extra: string[] = []): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "tags: [brain, brain/preference]",
      `topic: ${topic}`,
      "_status: confirmed",
      `principle: ${principle}`,
      "created_at: 2026-01-01T00:00:00Z",
      "unconfirmed_until: 2026-01-15T00:00:00Z",
      ...extra,
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-dm-dedup-"));
  vault = join(root, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  // Two lexical near-duplicate pairs in two topic buckets.
  writePref("tabs-a", "indent", "always indent code with tabs not spaces in every file");
  writePref("tabs-b", "indent", "always indent code with tabs not spaces in every file please");
  writePref("docs-a", "docs", "write every doc page in plain english with short sentences");
  writePref("docs-b", "docs", "write every doc page in plain english with short sentences only");
  server.requests.length = 0;
  setKey(false);
  fetchCounter = countFetch();
});
afterEach(() => {
  fetchCounter.restore();
  setKey(false);
  rmSync(root, { recursive: true, force: true });
});

/** Verdict script: the indent pair is `different`, everything else `same`. */
function scriptedReply(): void {
  server.setReply((req) => {
    const pairs = (req.body["state"] as { pairs: Record<string, string> }).pairs;
    return {
      json: choiceReply(req, (id) => {
        const k = id.slice("pair_".length);
        return (pairs[`A${k}`] ?? "").includes("tabs")
          ? { choice: "different", p: 0.95 }
          : { choice: "same", p: 0.85 };
      }),
    };
  });
}

async function scan(configPath: string): Promise<Record<string, unknown>> {
  const mcp = await mcpServer(vault, configPath);
  const reply = await callTool(mcp, "brain_hygiene", { mode: "scan" });
  expect(reply.isError).toBe(false);
  const payload = { ...reply.payload! };
  delete payload["generated_at"];
  return payload;
}

function dedupFindings(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return (payload["findings"] as Array<Record<string, unknown>>).filter(
    (f) => f["detector"] === "dedup",
  );
}

describe("brain_hygiene scan: activation", () => {
  test("1-3: no config, key without enabling, enabling without key: identical, no request", async () => {
    const baseline = await scan(writeConfig(root, {}));
    expect(dedupFindings(baseline)).toHaveLength(2);

    setKey(true);
    expect(await scan(writeConfig(root, {}))).toEqual(baseline);

    setKey(true);
    const notEnabled = { ...decisionEntries(server, "dedup:enforce") };
    notEnabled["decision_model_enabled"] = "false";
    expect(await scan(writeConfig(root, notEnabled))).toEqual(baseline);

    setKey(false);
    expect(await scan(writeConfig(root, decisionEntries(server, "dedup:enforce")))).toEqual(
      baseline,
    );

    expect(fetchCounter.calls()).toBe(0);
    expect(server.requests).toHaveLength(0);
    expect(listDecisionModelCalls(vault)).toHaveLength(0);
  });

  test("4, use off: identical and nothing sent", async () => {
    const baseline = await scan(writeConfig(root, {}));
    setKey(true);
    expect(await scan(writeConfig(root, decisionEntries(server, "rerank:shadow")))).toEqual(
      baseline,
    );
    expect(server.requests).toHaveLength(0);
  });

  test("4, shadow: byte-identical output, one request and one record", async () => {
    const baseline = await scan(writeConfig(root, {}));
    setKey(true);
    scriptedReply();
    const shadow = await scan(writeConfig(root, decisionEntries(server, "dedup:shadow")));
    expect(JSON.stringify(shadow)).toBe(JSON.stringify(baseline));
    expect(server.requests).toHaveLength(1);
    const records = listDecisionModelCalls(vault);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["mode"]).toBe("shadow");
    expect(records[0]!.payload["use"]).toBe("dedup");
    const recorded = records[0]!.payload["pairs"] as Array<Record<string, unknown>>;
    expect(recorded.map((p) => p["verdict"]).toSorted()).toEqual(["different", "same"]);
    expect(JSON.stringify(records[0]!.payload)).not.toContain("indent code");
  });

  test("4, enforce: annotates, moves the confident `different` last, removes nothing", async () => {
    const baseline = await scan(writeConfig(root, {}));
    setKey(true);
    scriptedReply();
    const enforced = await scan(writeConfig(root, decisionEntries(server, "dedup:enforce")));
    const before = baseline["findings"] as Array<Record<string, unknown>>;
    const after = enforced["findings"] as Array<Record<string, unknown>>;
    expect(after.map((f) => f["id"]).toSorted()).toEqual(before.map((f) => f["id"]).toSorted());
    expect(enforced["counts"]).toEqual(baseline["counts"]);
    const last = after[after.length - 1]!;
    expect(last["targets"]).toEqual(["pref-tabs-a", "pref-tabs-b"]);
    expect(last["decision_model_low_priority"]).toBe(true);
    expect(last["decision_model"]).toMatchObject({
      verdict: "different",
      model: "fake-model-1.0",
      calibrated: true,
    });
    const docs = dedupFindings(enforced).find((f) =>
      (f["targets"] as string[]).includes("pref-docs-a"),
    )!;
    expect(docs["decision_model"]).toMatchObject({ verdict: "same" });
    expect(docs["decision_model_low_priority"]).toBeUndefined();
    // A request body names no page and carries only principles.
    expect(server.requests[0]!.bodyText).not.toContain("pref-tabs-a");
  });

  test("4, a provider failure: output identical to the use being off", async () => {
    const baseline = await scan(writeConfig(root, {}));
    setKey(true);
    server.setReply(() => ({ status: 529, json: { error: "overloaded" } }));
    const failed = await scan(writeConfig(root, decisionEntries(server, "dedup:enforce")));
    expect(failed).toEqual(baseline);
    expect(listDecisionModelCalls(vault)[0]!.payload["outcome"]).toBe("http_529");
  });

  test("a private preference is never sent and its finding gets no verdict", async () => {
    writePref("tabs-b", "indent", "always indent code with tabs not spaces in every file please", [
      "visibility: private",
    ]);
    const report = runHygieneScan(vault, { now: new Date() });
    const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
    const annotated = await annotateDedupFindings(vault, report.findings, {
      config: activeDecisionConfig({
        vault,
        uses: { ...activeDecisionConfig().uses, rerank: "off", dedup: "enforce" },
      }),
      provider,
    });
    const tabs = annotated!.find((a) => a.item.targets.includes("pref-tabs-a"))!;
    expect(tabs.verdict).toBeNull();
    const docs = annotated!.find((a) => a.item.targets.includes("pref-docs-a"))!;
    expect(docs.verdict?.verdict).toBe("same");
    expect(JSON.stringify(provider.requests)).not.toContain("tabs");
  });
});

describe("dedup verdicts write nothing", () => {
  test("the vault tree is unchanged apart from the accounting log, in enforce", async () => {
    const report = runHygieneScan(vault, { now: new Date() });
    const before = digestVaultFiles(vault);
    const provider = new FakeChoiceProvider(() => ({ choice: "different", p: 0.99 }));
    const cfg = activeDecisionConfig({
      vault,
      uses: { ...activeDecisionConfig().uses, rerank: "off", dedup: "enforce" },
    });
    const annotated = await annotateDedupFindings(vault, report.findings, {
      config: cfg,
      provider,
    });
    expect(annotated).not.toBeNull();
    expect(annotated!.length).toBe(report.findings.length);
    const after = digestVaultFiles(vault);
    for (const key of Array.from(after.keys()))
      if (key.startsWith("Brain/log/continuity/")) after.delete(key);
    expect(after).toEqual(before);
  });

  test("apply is identical with and without verdicts", async () => {
    const run = async (configPath: string): Promise<unknown> => {
      const mcp = await mcpServer(vault, configPath);
      const scanned = await callTool(mcp, "brain_hygiene", { mode: "scan" });
      const ids = dedupFindings(scanned.payload!).map((f) => f["id"]);
      const applied = await callTool(mcp, "brain_hygiene", { mode: "apply", ids, dry_run: true });
      return applied.payload;
    };
    const plain = await run(writeConfig(root, {}));
    setKey(true);
    scriptedReply();
    const withVerdicts = await run(writeConfig(root, decisionEntries(server, "dedup:enforce")));
    expect(withVerdicts).toEqual(plain);
    expect(server.requests.length).toBeGreaterThan(0);
  });
});

describe("entity alias candidates in the doctor output", () => {
  const NOW = new Date("2026-06-01T00:00:00Z");

  function entity(name: string): string {
    return upsertEntity(vault, { category: "org", name, agent: "a", now: NOW }).entity.path;
  }

  function makePrivate(path: string): void {
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace("---\n", "---\nvisibility: private\n"));
  }

  const cfgWith = (mode: "shadow" | "enforce" | "off") =>
    activeDecisionConfig({
      vault,
      uses: { ...activeDecisionConfig().uses, rerank: "off", dedup: mode },
    });

  async function withEntityDedup<T>(fn: () => Promise<T> | T): Promise<T> {
    process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"] = "1";
    process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"] = "0.3";
    try {
      return await fn();
    } finally {
      delete process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_ENABLED"];
      delete process.env["OPEN_SECOND_BRAIN_ENTITY_SEMANTIC_DEDUP_LEXICAL_THRESHOLD"];
    }
  }

  test("enforce annotates each candidate and moves a confident `different` last", async () => {
    entity("Acme LLC");
    entity("Acme Inc");
    entity("Globex LLC");
    entity("Globex Inc");
    await withEntityDedup(async () => {
      const warnings = runDoctor(vault).warnings;
      const candidates = warnings.filter((w) => w.code === "entity-alias-candidate");
      expect(candidates.length).toBeGreaterThanOrEqual(2);
      const provider = new FakeChoiceProvider((id, _o, req) => {
        const pairs = (req!.state as { pairs: Record<string, string> }).pairs;
        const k = id.slice("pair_".length);
        const a = pairs[`A${k}`] ?? "";
        const b = pairs[`B${k}`] ?? "";
        return a.startsWith("Acme") && b.startsWith("Acme")
          ? { choice: "different", p: 0.97 }
          : { choice: "same", p: 0.9 };
      });
      const annotated = await annotateEntityAliasIssues(vault, warnings, {
        config: cfgWith("enforce"),
        provider,
      });
      expect(annotated).not.toBeNull();
      expect(annotated!.map((a) => a.item.message).toSorted()).toEqual(
        warnings.map((w) => w.message).toSorted(),
      );
      const last = annotated![annotated!.length - 1]!;
      expect(last.item.message).toContain("'Acme");
      expect(last.item.message).not.toContain("Globex");
      expect(last.lowPriority).toBe(true);
      expect(
        annotated!.every((a) => a.item.code !== "entity-alias-candidate" || a.verdict !== null),
      ).toBe(true);
      expect(listDecisionModelCalls(vault)[0]!.payload["pair_kind"]).toBe("entity");
    });
  });

  test("off: null and nothing sent; a private entity is never sent", async () => {
    entity("Acme LLC");
    makePrivate(entity("Acme Inc"));
    await withEntityDedup(async () => {
      const warnings = runDoctor(vault).warnings;
      expect(warnings.some((w) => w.code === "entity-alias-candidate")).toBe(true);
      const provider = new FakeChoiceProvider(() => ({ choice: "same", p: 0.9 }));
      expect(
        await annotateEntityAliasIssues(vault, warnings, { config: cfgWith("off"), provider }),
      ).toBeNull();
      expect(provider.requests).toHaveLength(0);
      const annotated = await annotateEntityAliasIssues(vault, warnings, {
        config: cfgWith("enforce"),
        provider,
      });
      expect(annotated!.every((a) => a.verdict === null)).toBe(true);
      expect(provider.requests).toHaveLength(0);
    });
  });

  test("brain_doctor: off identical; enforce adds the verdict to alias warnings", async () => {
    entity("Acme LLC");
    entity("Acme Inc");
    await withEntityDedup(async () => {
      const doctor = async (configPath: string) =>
        (await callTool(await mcpServer(vault, configPath), "brain_doctor", {})).payload!;
      const baseline = await doctor(writeConfig(root, {}));
      setKey(true);
      server.setReply((req) => ({
        json: choiceReply(req, () => ({ choice: "same", p: 0.9 })),
      }));
      expect(await doctor(writeConfig(root, decisionEntries(server, "rerank:shadow")))).toEqual(
        baseline,
      );
      expect(await doctor(writeConfig(root, decisionEntries(server, "dedup:shadow")))).toEqual(
        baseline,
      );
      const enforced = await doctor(writeConfig(root, decisionEntries(server, "dedup:enforce")));
      const alias = (enforced["warnings"] as Array<Record<string, unknown>>).find(
        (w) => w["code"] === "entity-alias-candidate",
      )!;
      expect(alias["decision_model"]).toMatchObject({ verdict: "same" });
      expect(server.requests).toHaveLength(2);
    });
  });
});

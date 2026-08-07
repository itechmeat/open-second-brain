/**
 * `brain_search` records the computable recall-quality signals on the
 * EXISTING per-query `recall_telemetry` record, behind the EXISTING
 * `telemetry` gate (what-the-index-already-knew, task G).
 *
 * Three properties are asserted here that the unit test cannot reach:
 *
 *   - one record per query, never one per result - the continuity log has
 *     no retention policy, so the record count is the thing that matters;
 *   - production ordering is unchanged with the gate on, compared as
 *     bytes rather than argued;
 *   - the signals are derived from what the pipeline surfaced, so the
 *     trust block is empty until the caller opts into `trust` while the
 *     typed `contradicts` edges are counted either way.
 *
 * The fixture is deliberately clock-free: notes are aged well past the
 * recency epsilon and access recording is suppressed, so two identical
 * requests serialize identically and the gate-off / gate-on comparison
 * is a real byte comparison.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { listRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";

const QUERY = "widget calibration";
const TELEMETRY_HOST = "mcp-recall-signals";
/** Older than the recency epsilon (~202 days), so the boost is exactly 0. */
const AGED_SECONDS = Math.floor(Date.now() / 1000) - 900 * 24 * 60 * 60;

const CLAIM = [
  "---",
  "title: Claim",
  "contradicts: [[counter]]",
  "---",
  "",
  "The widget calibration routine runs daily against the reference jig.",
].join("\n");
const COUNTER = [
  "---",
  "title: Counter",
  "---",
  "",
  "The widget calibration routine is scheduled weekly, never daily.",
].join("\n");

interface SignalsBlock {
  readonly rows: number;
  readonly alignment: {
    readonly top: number;
    readonly mean: number;
    readonly margin?: number;
    readonly keyword_sum: number;
    readonly semantic_sum: number;
  };
  readonly trust: {
    readonly assessed: number;
    readonly superseded: number;
    readonly conflict: number;
    readonly max_age_days?: number;
  };
  readonly contradiction: { readonly rows: number; readonly edges: number };
  readonly diversity: {
    readonly compared: number;
    readonly pairs: number;
    readonly mean_similarity?: number;
    readonly max_similarity?: number;
  };
  readonly unmeasured?: string;
}

let vault: string;
let configHome: string;
let ctx: { vault: string; configPath: string };

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

async function call(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool().handler(ctx as any, {
    query: QUERY,
    record_access: false,
    ...args,
  })) as Record<string, unknown>;
}

function signalsOf(): SignalsBlock {
  const records = listRecallTelemetry(vault, { mode: "search", host: TELEMETRY_HOST });
  expect(records).toHaveLength(1);
  return records[0]!.payload["signals"] as SignalsBlock;
}

function writeAged(relPath: string, body: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  utimesSync(abs, AGED_SECONDS, AGED_SECONDS);
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-signals-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-signals-cfg-"));
  writeAged("notes/claim.md", CLAIM);
  writeAged("notes/counter.md", COUNTER);
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  ctx = { vault, configPath };
  await indexVault(resolveSearchConfig({ vault, configPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search recall signals", () => {
  test("the gate is off by default and writes no record at all", async () => {
    const out = await call();

    expect((out["results"] as unknown[]).length).toBeGreaterThan(1);
    expect(listRecallTelemetry(vault, { mode: "search" })).toHaveLength(0);
    expect("telemetry_id" in out).toBe(false);
  });

  test("one record per query, not one per result", async () => {
    const out = await call({ telemetry: true, telemetry_host: TELEMETRY_HOST });

    const rows = out["results"] as unknown[];
    expect(rows.length).toBeGreaterThan(1);
    const records = listRecallTelemetry(vault, { mode: "search", host: TELEMETRY_HOST });
    expect(records).toHaveLength(1);
    expect(records[0]!.payload["result_count"]).toBe(rows.length);
  });

  test("production ordering is byte-identical with the gate on", async () => {
    const off = await call();
    const on = await call({ telemetry: true, telemetry_host: TELEMETRY_HOST });

    expect(JSON.stringify(on["results"])).toBe(JSON.stringify(off["results"]));
    expect(on["total"]).toBe(off["total"]);
    // Everything except the record pointer the gate adds is unchanged.
    delete on["telemetry_id"];
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  test("alignment carries the scores the ranker already computed", async () => {
    const out = await call({ telemetry: true, telemetry_host: TELEMETRY_HOST });
    const rows = out["results"] as Array<Record<string, number>>;
    const signals = signalsOf();

    expect(signals.rows).toBe(rows.length);
    expect(signals.alignment.top).toBeCloseTo(rows[0]!["score"]!, 4);
    expect(signals.alignment.margin).toBeCloseTo(rows[0]!["score"]! - rows[1]!["score"]!, 4);
    expect(signals.alignment.keyword_sum).toBeGreaterThan(0);
  });

  test("contradiction counts typed edges with no trust opt-in", async () => {
    await call({ telemetry: true, telemetry_host: TELEMETRY_HOST });
    const signals = signalsOf();

    expect(signals.contradiction).toEqual({ rows: 1, edges: 1 });
    expect(signals.trust).toEqual({ assessed: 0, superseded: 0, conflict: 0 });
  });

  test("trust is assessed only when the caller asked for it", async () => {
    await call({ telemetry: true, telemetry_host: TELEMETRY_HOST, trust: true });
    const signals = signalsOf();

    expect(signals.trust.assessed).toBe(2);
    expect(signals.trust.conflict).toBe(1);
    expect(signals.trust.max_age_days).toBeGreaterThan(800);
  });

  test("diversity is a bounded pool-level overlap of the surfaced rows", async () => {
    await call({ telemetry: true, telemetry_host: TELEMETRY_HOST });
    const signals = signalsOf();

    expect(signals.diversity.compared).toBe(2);
    expect(signals.diversity.pairs).toBe(1);
    expect(signals.diversity.mean_similarity!).toBeGreaterThan(0);
    expect(signals.diversity.mean_similarity!).toBeLessThan(1);
  });

  test("the cards surface names why it could not measure instead of going quiet", async () => {
    await call({
      telemetry: true,
      telemetry_host: TELEMETRY_HOST,
      disclosure: "cards",
    });
    const signals = signalsOf();

    expect(signals.unmeasured).toBe("disclosure_cards");
    expect("alignment" in signals).toBe(false);
  });

  test("a single-row window omits the pairwise numbers it cannot compute", async () => {
    await call({ telemetry: true, telemetry_host: TELEMETRY_HOST, limit: 1 });
    const one = listRecallTelemetry(vault, { mode: "search", host: TELEMETRY_HOST })[0]!;
    const signals = one.payload["signals"] as SignalsBlock;
    expect(signals.rows).toBe(1);
    expect("margin" in signals.alignment).toBe(false);
    expect(signals.diversity).toEqual({ compared: 1, pairs: 0 });
  });
});

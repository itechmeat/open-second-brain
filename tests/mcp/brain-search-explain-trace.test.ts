/**
 * `brain_search` serializes the retrieval decision trace and the memory
 * trust assessment under the existing `explain` flag
 * (what-the-index-already-knew, task F).
 *
 * Both receipts are built on every gated search and were, until this
 * unit, reachable only from a test: neither the MCP response nor the CLI
 * `--json` payload carried them. With the flag off the response shape is
 * byte-identical to the legacy one - no key, not a null.
 *
 * The fixture is deliberately clock-free: the notes are aged past the
 * recency epsilon and access recording is suppressed, so two identical
 * requests serialize to the same bytes and the flag-off / flag-on
 * comparison below is a real byte comparison rather than a tolerant one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexVault, resolveSearchConfig } from "../../src/core/search/index.ts";
import { RETRIEVAL_TRACE_UNAVAILABLE } from "../../src/core/search/explain-envelope.ts";
import { SEARCH_TOOLS } from "../../src/mcp/search-tools.ts";

const QUERY = "widget calibration";
const CLEAN = "---\ntitle: Clean\n---\n\n# Clean\n\nThe widget calibration routine runs daily.\n";
const QUARANTINED =
  "---\ntitle: Bad\nstatus: quarantine\n---\n\n# Bad\n\nThe widget calibration is unsafe.\n";
/** Older than the recency epsilon (~202 days), so the boost is exactly 0. */
const AGED_SECONDS = Math.floor(Date.now() / 1000) - 900 * 24 * 60 * 60;

interface SearchResponse {
  readonly results: ReadonlyArray<Record<string, unknown>>;
  readonly total: number;
  readonly retrieval_decision_trace?: {
    readonly evaluated: number;
    readonly surfaced: number;
    readonly excluded: number;
    readonly exclusions: ReadonlyArray<{
      readonly document_id: number;
      readonly chunk_id: number;
      readonly path: string;
      readonly reasons: ReadonlyArray<string>;
    }>;
  };
  readonly memory_trust_assessment?: {
    readonly evaluated: number;
    readonly surfaced: number;
    readonly quarantined: number;
    readonly reason_counts: Record<string, number>;
  };
  readonly retrieval_trace_unavailable?: string;
}

let vault: string;
let configHome: string;
let gateOn: { vault: string; configPath: string };
let gateOff: { vault: string; configPath: string };

const tool = () => SEARCH_TOOLS.find((t) => t.name === "brain_search")!;

async function call(
  ctx: { vault: string; configPath: string },
  args: Record<string, unknown>,
): Promise<SearchResponse> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await tool().handler(ctx as any, {
    query: QUERY,
    record_access: false,
    ...args,
  })) as unknown as SearchResponse;
}

function writeAged(relPath: string, body: string): void {
  const abs = join(vault, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
  utimesSync(abs, AGED_SECONDS, AGED_SECONDS);
}

beforeEach(async () => {
  vault = mkdtempSync(join(tmpdir(), "o2b-trace-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-trace-cfg-"));
  writeAged("notes/clean.md", CLEAN);
  writeAged("notes/quarantined.md", QUARANTINED);

  const onPath = join(configHome, "gate-on.yaml");
  atomicWriteFileSync(onPath, `vault: ${vault}\nsearch_trust_gate_enabled: true\n`);
  const offPath = join(configHome, "gate-off.yaml");
  atomicWriteFileSync(offPath, `vault: ${vault}\n`);
  gateOn = { vault, configPath: onPath };
  gateOff = { vault, configPath: offPath };

  await indexVault(resolveSearchConfig({ vault, configPath: offPath }), {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("brain_search explain: retrieval receipts", () => {
  test("no trace and no assessment key when explain is absent", async () => {
    const out = await call(gateOn, {});

    expect(out.total).toBeGreaterThan(0);
    expect("retrieval_decision_trace" in out).toBe(false);
    expect("memory_trust_assessment" in out).toBe(false);
    expect("retrieval_trace_unavailable" in out).toBe(false);
  });

  test("explain serializes the trace and the assessment the gate already built", async () => {
    const out = await call(gateOn, { explain: true });

    const trace = out.retrieval_decision_trace!;
    expect(trace.evaluated).toBe(2);
    expect(trace.surfaced).toBe(1);
    expect(trace.excluded).toBe(1);
    expect(trace.exclusions).toHaveLength(1);
    expect(trace.exclusions[0]!.path).toBe("notes/quarantined.md");
    expect(trace.exclusions[0]!.reasons).toEqual(["trust_gate:self_approval_quarantine"]);
    expect(typeof trace.exclusions[0]!.document_id).toBe("number");
    expect(typeof trace.exclusions[0]!.chunk_id).toBe("number");

    const assessment = out.memory_trust_assessment!;
    expect(assessment.surfaced).toBe(1);
    expect(assessment.quarantined).toBe(1);
    expect(assessment.reason_counts).toEqual({ "trust_gate:self_approval_quarantine": 1 });

    // The excluded row is counted, never surfaced.
    expect(out.results.map((r) => r["path"])).toEqual(["notes/clean.md"]);
  });

  test("explain with the gate off names why there is no trace instead of going quiet", async () => {
    const out = await call(gateOff, { explain: true });

    expect("retrieval_decision_trace" in out).toBe(false);
    expect("memory_trust_assessment" in out).toBe(false);
    expect(out.retrieval_trace_unavailable).toBe(RETRIEVAL_TRACE_UNAVAILABLE);
    expect(out.retrieval_trace_unavailable).toContain("search_trust_gate_enabled");
  });

  test("byte identity: the flag-off payload is the flag-on payload minus the explain keys", async () => {
    const first = await call(gateOn, {});
    const second = await call(gateOn, {});
    // Precondition: this fixture is deterministic, so the comparison below
    // measures the flag and nothing else.
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const on = (await call(gateOn, { explain: true })) as unknown as Record<string, unknown>;
    delete on["retrieval_decision_trace"];
    delete on["memory_trust_assessment"];
    for (const r of on["results"] as Array<Record<string, unknown>>) delete r["score_breakdown"];

    expect(JSON.stringify(on)).toBe(JSON.stringify(first));
  });
});

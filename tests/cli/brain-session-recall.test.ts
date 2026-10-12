import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
import { appendContinuityRecord } from "../../src/core/brain/continuity/store.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";
import { runCli } from "../helpers/run-cli.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cli-session-recall-"));
  const turns: SessionTurn[] = [
    {
      turnId: "t1",
      role: "user",
      timestamp: "2026-05-20T17:00:01.000Z",
      text: "Need receipt search.",
    },
    {
      turnId: "t2",
      role: "assistant",
      timestamp: "2026-05-20T17:00:02.000Z",
      text: "Decision: add session recall summaries.",
    },
    {
      turnId: "t3",
      role: "user",
      timestamp: "2026-05-20T17:00:03.000Z",
      text: "Another receipt ask.",
    },
  ];
  importSessionRecall(vault, {
    sessionId: "session-cli",
    turns,
    summaryGroupSize: 2,
    createdAt: "2026-05-20T17:00:00.000Z",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("brain session-grep/describe/expand query imported recall DAG", async () => {
  const describe = await runCli([
    "brain",
    "session-describe",
    "--vault",
    vault,
    "--session-id",
    "session-cli",
    "--json",
  ]);
  expect(describe.returncode).toBe(0);
  expect(JSON.parse(describe.stdout)).toMatchObject({
    raw_turns: 3,
    summary_nodes: 3,
  });

  const grep = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--query",
    "receipt",
    "--session-id",
    "session-cli",
    "--json",
  ]);
  expect(grep.returncode).toBe(0);
  const hits = JSON.parse(grep.stdout).hits as Array<{
    id: string;
    kind: string;
  }>;
  expect(hits.some((hit) => hit.kind === "session_turn")).toBe(true);
  expect(hits.some((hit) => hit.kind === "session_summary_node")).toBe(true);

  const expand = await runCli([
    "brain",
    "session-expand",
    hits.find((hit) => hit.kind === "session_summary_node")!.id,
    "--vault",
    vault,
    "--raw-limit",
    "1",
    "--json",
  ]);
  expect(expand.returncode).toBe(0);
  const expanded = JSON.parse(expand.stdout);
  expect(expanded.immediate_sources.length).toBeGreaterThan(0);
  expect(expanded.raw_content).toHaveLength(1);
});

test("brain session-grep coverage operation and describe topics (t_2c2a883c)", async () => {
  const coverage = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--char-budget",
    "100000",
    "--session-id",
    "session-cli",
    "--json",
  ]);
  expect(coverage.returncode).toBe(0);
  const parsed = JSON.parse(coverage.stdout);
  expect(parsed.turns.length).toBe(3);
  expect(parsed.diagnostics.topics_requested).toBe(12);
  expect(parsed.diagnostics.topics_realized).toBe(2);
  expect(parsed.diagnostics.chars_used).toBeGreaterThan(0);

  const described = await runCli([
    "brain",
    "session-describe",
    "--vault",
    vault,
    "--session-id",
    "session-cli",
    "--topics",
    "--json",
  ]);
  expect(described.returncode).toBe(0);
  expect(JSON.parse(described.stdout).topic_report.topics_realized).toBe(2);
});

test("entity-key seeds the fan-out and match-only flags are refused under coverage", async () => {
  appendContinuityRecord(vault, {
    kind: "session_entity_mention",
    createdAt: "2026-05-20T17:00:04.000Z",
    sourceRefs: [{ id: "session-cli:t1:symbol:ReceiptSearch" }],
    payload: { family: "symbol", key: "ReceiptSearch", session_ref: "session-cli", turn_id: "t1" },
  });

  const seeded = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--char-budget",
    "100000",
    "--entity-key",
    "ReceiptSearch",
    "--json",
  ]);
  expect(seeded.returncode).toBe(0);
  const parsed = JSON.parse(seeded.stdout);
  // The seeded facet leads the fan-out: the mention's establishing turn
  // is first; the budget may still realize further topics after it.
  const turnIds = parsed.turns.map((t: { turn_id: string }) => t.turn_id);
  expect(turnIds[0]).toBe("t1");
  expect(turnIds).toContain("t1");

  for (const extra of [
    ["--query", "receipt"],
    ["--since", "2026-05-01"],
    ["--before", "2026-05-21"],
    ["--limit", "5"],
    ["--snippet-chars", "40"],
  ] as const) {
    const refused = await runCli([
      "brain",
      "session-grep",
      "--vault",
      vault,
      "--operation",
      "coverage",
      "--char-budget",
      "100000",
      ...extra,
    ]);
    expect(refused.returncode).not.toBe(0);
    expect(`${refused.stderr}${refused.stdout}`).toContain(extra[0]);
  }
});

test("coverage without a character budget is refused by name", async () => {
  const missing = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--json",
  ]);
  expect(missing.returncode).not.toBe(0);
  expect(`${missing.stderr}${missing.stdout}`).toContain("char-budget");
});

test("--entity-key accepts the mined-key length (200) and refuses longer", async () => {
  // Mined keys run to MINED_KEY_MAX_LENGTH = 200, so the CLI cap matches
  // the miner's - parity with the MCP tool, where a longer key is refused.
  const tooLong = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--char-budget",
    "100000",
    "--entity-key",
    "K".repeat(201),
    "--json",
  ]);
  expect(tooLong.returncode).not.toBe(0);
  expect(`${tooLong.stderr}${tooLong.stdout}`).toContain("at most 200 characters");

  const atCap = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--char-budget",
    "100000",
    "--entity-key",
    "K".repeat(200),
    "--json",
  ]);
  // A 200-character key is a legal mined key: the refusal is about the
  // unknown key, never about its length.
  expect(atCap.returncode).not.toBe(0);
  expect(`${atCap.stderr}${atCap.stdout}`).toContain("no session_entity_mention row names");
});

test("coverage-only flags are refused under the match operation", async () => {
  // The mirror of the refusal matrix above: --char-budget and --entity-key
  // name the coverage operation's knobs, so the default match operation
  // refuses them instead of silently ignoring them.
  for (const extra of [
    ["--char-budget", "100000"],
    ["--entity-key", "ReceiptSearch"],
  ] as const) {
    const refused = await runCli([
      "brain",
      "session-grep",
      "--vault",
      vault,
      "--query",
      "receipt",
      ...extra,
      "--json",
    ]);
    expect(refused.returncode).not.toBe(0);
    expect(`${refused.stderr}${refused.stdout}`).toContain(
      `${extra[0]} applies to --operation coverage only`,
    );
  }
});

test("a budget below the floor-weighted selection surfaces the typed infeasibility", async () => {
  const infeasible = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "coverage",
    "--char-budget",
    "1",
    "--session-id",
    "session-cli",
    "--json",
  ]);
  expect(infeasible.returncode).not.toBe(0);
  expect(`${infeasible.stderr}${infeasible.stdout}`).toContain("required chars");
});

test("an unknown operation value is refused by name", async () => {
  const unknown = await runCli([
    "brain",
    "session-grep",
    "--vault",
    vault,
    "--operation",
    "widely",
    "--query",
    "receipt",
    "--json",
  ]);
  expect(unknown.returncode).not.toBe(0);
  expect(`${unknown.stderr}${unknown.stdout}`).toContain("operation");
});

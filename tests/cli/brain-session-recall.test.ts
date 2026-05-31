import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importSessionRecall } from "../../src/core/brain/session-recall.ts";
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

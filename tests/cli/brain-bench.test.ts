/**
 * `o2b brain bench memory` (Memory Observability Suite, t_882c396a):
 * the CLI surface over the bench pipeline. The harness materializes a
 * disposable vault inside the runs directory and never resolves the
 * operator's configured vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let runsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bench-cli-"));
  runsDir = join(tmp, "bench-runs");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b brain bench memory", () => {
  test("runs the repo core-recall fixture green and reports separate metric families", async () => {
    const out = await runCli(
      ["brain", "bench", "memory", "--fixture", "core-recall", "--runs-dir", runsDir, "--json"],
      {},
    );
    expect(out.returncode).toBe(0);
    const report = JSON.parse(out.stdout) as {
      schema: string;
      run_id: string;
      quality: { passed: number; total: number };
      latency_ms: { avg: number };
      context_cost: { avg_chars: number };
      judge: { status: string };
    };
    expect(report.schema).toBe("o2b.bench.v1");
    expect(report.quality.total).toBe(6);
    expect(report.quality.passed).toBe(6);
    expect(report.judge.status).toBe("skipped");
    // The disposable vault lives inside the run directory.
    expect(existsSync(join(runsDir, report.run_id, "vault", "Brain"))).toBe(true);
    expect(existsSync(join(runsDir, report.run_id, "report.json"))).toBe(true);
  }, 60_000);

  test("resume reuses the checkpoint instead of creating a second run", async () => {
    const first = await runCli(
      ["brain", "bench", "memory", "--fixture", "stale-recall", "--runs-dir", runsDir, "--json"],
      {},
    );
    expect(first.returncode).toBe(0);
    const report = JSON.parse(first.stdout) as { run_id: string };
    const resumed = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "stale-recall",
        "--runs-dir",
        runsDir,
        "--resume",
        report.run_id,
        "--json",
      ],
      {},
    );
    expect(resumed.returncode).toBe(0);
    expect((JSON.parse(resumed.stdout) as { run_id: string }).run_id).toBe(report.run_id);
    expect(readdirSync(runsDir)).toHaveLength(1);
  }, 60_000);

  test("an unknown fixture fails with a clear error", async () => {
    const out = await runCli(
      ["brain", "bench", "memory", "--fixture", "no-such-fixture", "--runs-dir", runsDir],
      {},
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("fixture not found");
  });
});

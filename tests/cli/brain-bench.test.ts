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

import {
  benchSuite,
  benchSuiteNames,
  registerBenchSuite,
} from "../../src/cli/brain/verbs/bench.ts";
import { parseBenchFixture } from "../../src/core/bench/fixture.ts";
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
    expect(report.schema).toBe("o2b.bench.v2");
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

/**
 * The suite registry (recall-quality wave, t_607d429d): a --suite name
 * maps to `{ loader, capabilities }`, the registry is the appendable
 * registration point for suite modules, and the no-flag default path is
 * byte-identical to the pre-registry dispatch.
 */
describe("bench suite registry", () => {
  const STUB_SUITE = "registry-stub";
  const STUB_FIXTURE = parseBenchFixture({
    name: "registry-stub",
    notes: [{ path: "Brain/notes/a.md", body: "alpha note" }],
    questions: [
      { id: "q1", category: "single_hop", query: "alpha", expected_paths: ["Brain/notes/a.md"] },
    ],
  });
  const stubLoaderCalls: string[] = [];

  registerBenchSuite(STUB_SUITE, {
    loader: (fixturePath: string) => {
      stubLoaderCalls.push(fixturePath);
      return STUB_FIXTURE;
    },
    capabilities: { embeddings: false },
  });

  beforeEach(() => {
    stubLoaderCalls.length = 0;
  });

  test("the registry maps suite names to loader and capabilities", () => {
    const locomo = benchSuite("locomo");
    expect(locomo).toBeDefined();
    expect(locomo!.capabilities).toEqual({ embeddings: false });
    expect(typeof locomo!.loader).toBe("function");
    expect(benchSuiteNames()).toContain("locomo");
    // Sorted for stable listings (order-dependent assertions use sorted listings).
    expect(benchSuiteNames()).toEqual(benchSuiteNames().toSorted());
  });

  test("a registered suite reaches its loader through --suite", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        STUB_SUITE,
        "--runs-dir",
        runsDir,
        "--json",
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    // The stub loader received the RESOLVED fixture path.
    expect(stubLoaderCalls).toEqual([join("tests", "fixtures", "bench", "core-recall.json")]);
    const report = JSON.parse(out.stdout) as { fixture: string };
    expect(report.fixture).toBe("registry-stub");
  }, 60_000);

  test("an unknown suite fails with the current message shape", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        "bogus",
        "--runs-dir",
        runsDir,
      ],
      {},
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("unknown --suite 'bogus' (supported:");
  });

  test("omitting --suite keeps the native loader and the report shape unchanged", async () => {
    const out = await runCli(
      ["brain", "bench", "memory", "--fixture", "core-recall", "--runs-dir", runsDir, "--json"],
      {},
    );
    expect(out.returncode).toBe(0);
    const report = JSON.parse(out.stdout) as { fixture: string };
    expect(report.fixture).toBe("core-recall");
    // The native default path is not a named suite and adds no suite fields.
    expect("suite" in report).toBe(false);
    expect(stubLoaderCalls).toEqual([]);
  }, 60_000);

  test("a duplicate suite registration is refused by name", () => {
    expect(() =>
      registerBenchSuite("locomo", {
        loader: () => STUB_FIXTURE,
        capabilities: { embeddings: false },
      }),
    ).toThrow(/already registered/);
  });
});

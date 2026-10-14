/**
 * `o2b brain bench memory` (Memory Observability Suite, t_882c396a):
 * the CLI surface over the bench pipeline. The harness materializes a
 * disposable vault inside the runs directory and never resolves the
 * operator's configured vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERB_HELP } from "../../src/cli/brain/help-text.ts";
import {
  benchSuite,
  benchSuiteNames,
  parseBenchPinnedKnobs,
  parseRecallFloorFlag,
  parseSampleCapFlag,
  parseSampleSeedFlag,
  registerBenchSuite,
} from "../../src/cli/brain/verbs/bench.ts";
import { parseBenchFixture } from "../../src/core/bench/fixture.ts";
import type { BenchSuiteLoadOptions } from "../../src/core/bench/types.ts";
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
      return { fixture: STUB_FIXTURE };
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

  test("the longmemeval suite prints its strict recall_all@5 family", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "longmemeval-sample",
        "--suite",
        "longmemeval",
        "--runs-dir",
        runsDir,
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    // The named metric family rides the CLI output beside the existing
    // families - never folded into the pass rate.
    expect(out.stdout).toContain("longmemeval: recall_all@5 1 abstention_excluded 1");
  }, 60_000);

  test("the longmemeval report family rides the --json report", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "longmemeval-sample",
        "--suite",
        "longmemeval",
        "--runs-dir",
        runsDir,
        "--json",
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    const report = JSON.parse(out.stdout) as {
      longmemeval?: { recall_all_at_5: number; abstention_excluded: number };
    };
    expect(report.longmemeval).toEqual({ recall_all_at_5: 1, abstention_excluded: 1 });
  }, 60_000);

  test("a duplicate suite registration is refused by name", () => {
    expect(() =>
      registerBenchSuite("locomo", {
        loader: () => ({ fixture: STUB_FIXTURE }),
        capabilities: { embeddings: false },
      }),
    ).toThrow(/already registered/);
  });
});

/**
 * The knob pin and the recall floor reach `runMemoryBench` from the CLI
 * (pr-250 review, M7): the pin is the run's search configuration and the
 * floor is the admission bound the surfacing-replay suite sweeps, and
 * both are part of the run identity - asserted here through the
 * checkpoint each run persists.
 */
describe("bench knob pin and recall floor", () => {
  /** A one-question fixture, so each e2e run stays cheap. */
  function writePinFixture(): string {
    const path = join(tmp, "pin-fixture.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "pin-check",
        notes: [{ path: "Brain/notes/a.md", body: "alpha note" }],
        questions: [
          {
            id: "q1",
            category: "single_hop",
            query: "alpha",
            expected_paths: ["Brain/notes/a.md"],
          },
        ],
      }),
    );
    return path;
  }

  function checkpointOf(
    runsDir: string,
    runId: string,
  ): {
    pinned_knobs?: unknown;
    knobs_hash?: string;
  } {
    return JSON.parse(readFileSync(join(runsDir, runId, "checkpoint.json"), "utf8")) as {
      pinned_knobs?: unknown;
      knobs_hash?: string;
    };
  }

  test("--pin reaches the run identity verbatim, replacing the default pin", async () => {
    const fixturePath = writePinFixture();
    // A pin the resolver accepts: the semantic lane stays off and one
    // chunking knob moves. Value semantics are the resolver's, not this
    // flag's - a pin like `keywordWeight: 0.7` alone dies there with its
    // named sum-to-one error, which is the loud path by design.
    const pin = { semantic: { enabled: false }, chunkSize: 512 };
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        runsDir,
        "--pin",
        JSON.stringify(pin),
        "--json",
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    const report = JSON.parse(out.stdout) as { run_id: string };
    const checkpoint = checkpointOf(runsDir, report.run_id);
    // The pin rides the checkpoint byte for byte - nothing merged in, so
    // the run the report describes is exactly the configuration asked for.
    expect(checkpoint.pinned_knobs).toEqual(pin);
  }, 60_000);

  test("--recall-floor reaches the run identity: a floor change is a different run", async () => {
    const fixturePath = writePinFixture();
    const plain = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--runs-dir", runsDir, "--json"],
      {},
    );
    expect(plain.returncode).toBe(0);
    const plainId = (JSON.parse(plain.stdout) as { run_id: string }).run_id;
    const floored = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        runsDir,
        "--recall-floor",
        "0.5",
        "--json",
      ],
      {},
    );
    expect(floored.returncode).toBe(0);
    const flooredId = (JSON.parse(floored.stdout) as { run_id: string }).run_id;
    expect(flooredId).not.toBe(plainId);
    // And resuming with the SAME floor reuses the run; the identity
    // guard, not the CLI, owns what a floor change on resume means.
    const resumed = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        runsDir,
        "--recall-floor",
        "0.5",
        "--resume",
        flooredId,
        "--json",
      ],
      {},
    );
    expect(resumed.returncode).toBe(0);
    expect((JSON.parse(resumed.stdout) as { run_id: string }).run_id).toBe(flooredId);
    expect(readdirSync(runsDir)).toHaveLength(2);
  }, 60_000);

  test("garbage is refused by name", async () => {
    const fixturePath = writePinFixture();
    const badJson = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        fixturePath,
        "--runs-dir",
        runsDir,
        "--pin",
        "{not json",
      ],
      {},
    );
    expect(badJson.returncode).not.toBe(0);
    expect(badJson.stderr).toContain("--pin is not valid JSON");

    const notAnObject = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--pin", "[1,2]"],
      {},
    );
    expect(notAnObject.stderr).toContain("--pin must be a JSON object");

    const unknownKnob = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--pin", '{"frobNobs":1}'],
      {},
    );
    expect(unknownKnob.stderr).toContain("unknown knob 'frobNobs'");

    const unknownMember = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        fixturePath,
        "--pin",
        '{"semantic":{"enabeled":true}}',
      ],
      {},
    );
    expect(unknownMember.stderr).toContain("--pin 'semantic.enabeled' is not a known knob");

    const harnessOwned = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--pin", '{"vault":"/elsewhere"}'],
      {},
    );
    expect(harnessOwned.stderr).toContain("--pin may not set 'vault'");

    const badFloor = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--recall-floor", "abc"],
      {},
    );
    expect(badFloor.returncode).not.toBe(0);
    expect(badFloor.stderr).toContain("--recall-floor must be a positive number, got 'abc'");

    const zeroFloor = await runCli(
      ["brain", "bench", "memory", "--fixture", fixturePath, "--recall-floor", "0"],
      {},
    );
    expect(zeroFloor.stderr).toContain("--recall-floor must be a positive number, got '0'");
  }, 60_000);

  test("the pin parser refuses shape garbage and leaves value semantics to the resolver", () => {
    expect(parseBenchPinnedKnobs('{"semantic":{"enabled":false}}')).toEqual({
      semantic: { enabled: false },
    });
    // A scalar knob's VALUE is not shape-checked here: an out-of-range
    // number is resolveSearchConfig's named error, not this parser's.
    expect(parseBenchPinnedKnobs('{"keywordWeight":99}')).toEqual({ keywordWeight: 99 });
    // The standing-instruction facet lane's arm is pinnable, so the
    // lane-off arm of the category is reachable from the CLI too
    // (recall-lane-latency).
    expect(parseBenchPinnedKnobs('{"standingInstructionFacets":false}')).toEqual({
      standingInstructionFacets: false,
    });
    expect(() => parseBenchPinnedKnobs('{"semantic":false}')).toThrow(
      /'semantic' must be a JSON object/,
    );
    expect(() => parseRecallFloorFlag(undefined)).not.toThrow();
    expect(parseRecallFloorFlag("0.35")).toBe(0.35);
    expect(() => parseRecallFloorFlag("")).toThrow(/got ''/);
    expect(() => parseRecallFloorFlag("-1")).toThrow(/got '-1'/);
  });
});

/**
 * The seeded sampling flags (wiring-shipped-seams wave, t_4501c662):
 * `--sample-seed` and `--sample-cap` are a PAIR - refused singly and on
 * any suite that does not declare the sampling capability - and
 * together they reach the suite loader as
 * `BenchSuiteLoadOptions { sample }`. Omitting both leaves today's CLI
 * behavior byte-identical.
 */
describe("bench sampling flags", () => {
  const SAMPLING_SUITE = "sampling-stub";
  const SAMPLING_FIXTURE = parseBenchFixture({
    name: "sampling-stub",
    notes: [{ path: "Brain/notes/a.md", body: "alpha note" }],
    questions: [
      { id: "q1", category: "single_hop", query: "alpha", expected_paths: ["Brain/notes/a.md"] },
    ],
  });
  /** Every loader invocation with the options object it received. */
  const samplingLoaderCalls: Array<{ path: string; options: BenchSuiteLoadOptions }> = [];

  registerBenchSuite(SAMPLING_SUITE, {
    // The second parameter is OPTIONAL by contract: a suite registered
    // before an option existed keeps its one-parameter loader and never
    // sees the request. This stub declares it to record what arrives.
    loader: (fixturePath: string, options?: BenchSuiteLoadOptions) => {
      samplingLoaderCalls.push({ path: fixturePath, options: options ?? {} });
      return { fixture: SAMPLING_FIXTURE };
    },
    capabilities: { embeddings: false, sampling: true },
  });

  beforeEach(() => {
    samplingLoaderCalls.length = 0;
  });

  test("the sampling flag validators refuse garbage by name", () => {
    expect(parseSampleSeedFlag(undefined)).toBeUndefined();
    expect(parseSampleSeedFlag("run-42")).toBe("run-42");
    // pr-251 L2: the parser validates but does not transform - the
    // sampler trims the seed in one place before hashing, so the CLI and
    // the API path hash the same value for the same input, and a padded
    // seed reaches the loader verbatim.
    expect(parseSampleSeedFlag("  seed-1  ")).toBe("  seed-1  ");
    expect(() => parseSampleSeedFlag("   ")).toThrow(/--sample-seed/);
    expect(parseSampleCapFlag(undefined)).toBeUndefined();
    expect(parseSampleCapFlag("12")).toBe(12);
    expect(() => parseSampleCapFlag("0")).toThrow(/got '0'/);
    expect(() => parseSampleCapFlag("-2")).toThrow(/got '-2'/);
    expect(() => parseSampleCapFlag("1.5")).toThrow(/got '1.5'/);
    expect(() => parseSampleCapFlag("abc")).toThrow(/got 'abc'/);
  });

  test("--sample-seed alone is refused by name", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--runs-dir",
        runsDir,
        "--sample-seed",
        "seed-1",
      ],
      {},
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("--sample-seed and --sample-cap must be given together");
  });

  test("--sample-cap alone is refused by name", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--runs-dir",
        runsDir,
        "--sample-cap",
        "4",
      ],
      {},
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("--sample-seed and --sample-cap must be given together");
  });

  test("a non-positive or non-integer cap is refused naming the value", async () => {
    for (const cap of ["0", "-2", "1.5", "abc"]) {
      const out = await runCli(
        [
          "brain",
          "bench",
          "memory",
          "--fixture",
          "core-recall",
          "--sample-seed",
          "seed-1",
          "--sample-cap",
          cap,
        ],
        {},
      );
      expect(out.returncode).not.toBe(0);
      expect(out.stderr).toContain(`--sample-cap must be a positive integer, got '${cap}'`);
    }
  });

  test("an empty seed is refused naming the flag", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--sample-seed",
        "   ",
        "--sample-cap",
        "4",
      ],
      {},
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("--sample-seed must be a non-empty string");
  });

  test("both flags without a sampling-capable suite are refused naming the suite", async () => {
    for (const suite of ["locomo", "surfacing-replay"]) {
      const out = await runCli(
        [
          "brain",
          "bench",
          "memory",
          "--fixture",
          "core-recall",
          "--suite",
          suite,
          "--sample-seed",
          "seed-1",
          "--sample-cap",
          "4",
        ],
        {},
      );
      expect(out.returncode).not.toBe(0);
      expect(out.stderr).toContain(`suite '${suite}' does not declare it`);
    }
    // The no-suite default path has no sampling capability either.
    const noSuite = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--sample-seed",
        "seed-1",
        "--sample-cap",
        "4",
      ],
      {},
    );
    expect(noSuite.returncode).not.toBe(0);
    expect(noSuite.stderr).toContain("no --suite was given");
  });

  test("both flags with a sampling-capable suite reach the loader as a sample request", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        SAMPLING_SUITE,
        "--sample-seed",
        "seed-1",
        "--sample-cap",
        "3",
        "--runs-dir",
        runsDir,
        "--json",
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    expect(samplingLoaderCalls).toEqual([
      {
        path: join("tests", "fixtures", "bench", "core-recall.json"),
        options: { sample: { seed: "seed-1", cap: 3 } },
      },
    ]);
    const report = JSON.parse(out.stdout) as { fixture: string };
    expect(report.fixture).toBe("sampling-stub");
  }, 60_000);

  test("omitting the flags passes empty load options - the off path is unchanged", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        SAMPLING_SUITE,
        "--runs-dir",
        runsDir,
        "--json",
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    expect(samplingLoaderCalls).toEqual([
      { path: join("tests", "fixtures", "bench", "core-recall.json"), options: {} },
    ]);
  }, 60_000);

  test("the longmemeval suite samples through the flags and pins the run identity", async () => {
    // The committed sample carries 3 eligible questions across 3 types;
    // a cap of 2 selects 2, the CLI line reports the sampled count, and
    // the run checkpoint carries the sampling request - so a resumed run
    // under different sampling options fails the identity guard.
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "longmemeval-sample",
        "--suite",
        "longmemeval",
        "--sample-seed",
        "seed-1",
        "--sample-cap",
        "2",
        "--runs-dir",
        runsDir,
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("longmemeval: recall_all@5");
    // The sampled text line shows the covered share: the population the
    // sampler chose from beside the selected count (pr-251 L3). The
    // whole-dataset line carries neither field.
    expect(out.stdout).toContain("sample_population 3 sample_selected 2");
    const runId = /^bench \S+ run (\S+)$/m.exec(out.stdout)?.[1];
    expect(runId).toBeDefined();
    const checkpoint = JSON.parse(
      readFileSync(join(runsDir, runId!, "checkpoint.json"), "utf8"),
    ) as { sample?: unknown };
    expect(checkpoint.sample).toEqual({ seed: "seed-1", cap: 2 });
  }, 60_000);
});

/**
 * The help prose's usage block (CodeRabbit, pr-251): it mirrors the
 * verb's USAGE constant - the usage line plus its 7-space continuation
 * lines - so a flag the verb accepts is listed there too, and the line
 * cannot drift back to a subset of the accepted flags.
 */
describe("bench help text", () => {
  test("the usage block lists every flag the verb accepts", () => {
    const usageBlock = (VERB_HELP["bench"] ?? "")
      .split("\n")
      .filter((line) => line.startsWith("usage:") || line.startsWith("       "))
      .join("\n");
    for (const flag of [
      "--fixture",
      "--suite",
      "--pin",
      "--recall-floor",
      "--sample-seed",
      "--sample-cap",
      "--resume",
      "--runs-dir",
      "--json",
    ]) {
      expect(usageBlock).toContain(flag);
    }
    // The sample flags sit in the usage block itself, not only in the
    // prose below it; the block wraps, so adjacency is checked over the
    // continuation lines flattened back into one line.
    const flattened = usageBlock.replaceAll("\n       ", " ");
    expect(flattened).toContain("[--sample-seed <value>] [--sample-cap <n>]");
  });
});

/**
 * The standing_instruction human line (recall-lane-latency): printed only
 * when the report's quality buckets carry the category - a run without
 * standing_instruction questions keeps its stdout byte-identical, a
 * lane-on run prints the category beside its rates, and the exit code
 * stays all-pass-or-nonzero with the category in play.
 */
describe("bench standing_instruction human line", () => {
  /** The surfacing lane's fixture vault files, in the live writers' shapes. */
  const STANDING_FLOW_MD = [
    "---",
    "kind: brain-attention-flow",
    "id: open-loops",
    "title: Open loops",
    "actions:",
    "  - standing_query",
    "standing_queries:",
    "  - testing",
    "status: active",
    "---",
    "",
    "# Open loops",
    "",
  ].join("\n");
  const STANDING_PREF_MD = [
    "---",
    "kind: brain-preference",
    "id: pref-tabs",
    "created_at: 2026-06-01T00:00:00Z",
    "_confirmed_at: 2026-06-02T00:00:00Z",
    "unconfirmed_until: 2026-07-01T00:00:00Z",
    "tags:",
    "  - bench",
    "topic: tabs",
    "_status: confirmed",
    "principle: Use tabs for indentation",
    "_evidenced_by:",
    '  - "[[sig-bench-turn]]"',
    "_applied_count: 0",
    "_violated_count: 0",
    "_last_evidence_at: null",
    "_confidence: low",
    "_confidence_value: null",
    "pinned: false",
    "scope: testing",
    "---",
    "",
    "Use tabs for indentation",
    "",
  ].join("\n");
  const STANDING_SIGNAL_MD = [
    "---",
    "kind: brain-signal",
    "id: sig-bench-turn",
    "created_at: 2026-06-01T00:00:00Z",
    "tags:",
    "  - bench",
    "topic: tabs",
    "signal: positive",
    "agent: bench",
    "principle: use tabs for indentation",
    "scope: testing",
    "session_ref: bench-session.json#turn-2",
    "---",
    "",
    "recorded preference signal",
    "",
  ].join("\n");

  const STANDING_SUITE = "standing-stub";
  registerBenchSuite(STANDING_SUITE, {
    loader: () => ({
      fixture: parseBenchFixture({
        name: "standing-cli",
        notes: [
          { path: "Brain/attention/flows/open-loops.md", body: STANDING_FLOW_MD },
          { path: "Brain/preferences/pref-tabs.md", body: STANDING_PREF_MD },
          { path: "Brain/inbox/sig-bench-turn.md", body: STANDING_SIGNAL_MD },
        ],
        continuity: [],
        questions: [
          {
            id: "q-standing",
            category: "standing_instruction",
            expected_ids: ["pref:pref-tabs"],
            expected_text: "earliest cited turn bench-session.json#turn-2]",
          },
        ],
      }),
    }),
    capabilities: { embeddings: false },
  });

  /** The same fixture with the expectation unmet: the question fails. */
  const FAILING_SUITE = "standing-failing-stub";
  registerBenchSuite(FAILING_SUITE, {
    loader: () => ({
      fixture: parseBenchFixture({
        name: "standing-cli-failing",
        notes: [
          { path: "Brain/attention/flows/open-loops.md", body: STANDING_FLOW_MD },
          { path: "Brain/preferences/pref-tabs.md", body: STANDING_PREF_MD },
          { path: "Brain/inbox/sig-bench-turn.md", body: STANDING_SIGNAL_MD },
        ],
        continuity: [],
        questions: [
          {
            id: "q-standing",
            category: "standing_instruction",
            expected_ids: ["pref:pref-never-resolves"],
          },
        ],
      }),
    }),
    capabilities: { embeddings: false },
  });

  test("a run without the category keeps stdout byte-identical", async () => {
    const out = await runCli(
      ["brain", "bench", "memory", "--fixture", "core-recall", "--runs-dir", runsDir],
      {},
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).not.toContain("standing_instruction");
  }, 60_000);

  test("a lane-on run prints the new category and its rates", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        STANDING_SUITE,
        "--runs-dir",
        join(runsDir, "lane-on"),
      ],
      {},
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("standing_instruction: 1/1 (pass rate 1)");
  }, 60_000);

  test("the exit code stays all-pass-or-nonzero with the new category in play", async () => {
    const out = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        FAILING_SUITE,
        "--runs-dir",
        join(runsDir, "failing"),
      ],
      {},
    );
    expect(out.returncode).not.toBe(0);
    // The failing question names the category and the missing facet.
    expect(out.stdout).toContain("FAIL  q-standing (standing_instruction)");
    expect(out.stdout).toContain("pref:pref-never-resolves");
  }, 60_000);
});

/**
 * The overlapped_ms human line (recall-lane-latency): printed only when
 * the aggregate latency family carries the figure - a keyword-only run
 * (the default pin) keeps its stdout byte-identical, and a lane-on run
 * through an embeddings-capable suite prints it.
 */
describe("bench overlapped_ms human line", () => {
  const OVERLAP_SUITE = "overlap-stub";
  const OVERLAP_FIXTURE = parseBenchFixture({
    name: "overlap-stub",
    notes: [
      {
        path: "Brain/notes/rust.md",
        body: "# Rust\n\nThe systems team standardized on Rust for the new ingest service.\n",
      },
    ],
    questions: [
      {
        id: "q-rust",
        category: "single_hop",
        query: "systems language for the ingest service",
        expected_paths: ["Brain/notes/rust.md"],
      },
    ],
  });

  registerBenchSuite(OVERLAP_SUITE, {
    loader: () => ({ fixture: OVERLAP_FIXTURE }),
    capabilities: { embeddings: true },
  });

  test("the overlapped_ms line prints only when the aggregate carries it", async () => {
    // Keyword-only default run: no line, byte-identical stdout.
    const plain = await runCli(
      ["brain", "bench", "memory", "--fixture", "core-recall", "--runs-dir", runsDir],
      {},
    );
    expect(plain.returncode).toBe(0);
    expect(plain.stdout).not.toContain("overlapped_ms");

    // Lane-on run through the embeddings-capable suite: the line prints.
    const laneOn = await runCli(
      [
        "brain",
        "bench",
        "memory",
        "--fixture",
        "core-recall",
        "--suite",
        OVERLAP_SUITE,
        "--runs-dir",
        join(runsDir, "lane-on"),
        "--pin",
        JSON.stringify({ semantic: { enabled: true, provider: "local" } }),
      ],
      {},
    );
    expect(laneOn.returncode).toBe(0);
    expect(laneOn.stdout).toMatch(/overlapped_ms: avg \d+/);
  }, 60_000);
});

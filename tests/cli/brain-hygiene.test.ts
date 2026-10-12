/**
 * `o2b brain hygiene` at the CLI level (no-dead-ends, task 23).
 *
 * The verb is write-capable and had no CLI-level test: the scan, the
 * plan and the applier under it were covered, but nothing exercised the
 * subcommand dispatch, the detector list parsing, the JSON surfaces, the
 * `--ids` requirement, or the `--dry-run` claim through the CLI. This
 * release touches the applier (task 8 moved its write guard and routed
 * its exclusion decision through the capability table), so the tier is
 * established here.
 *
 * As for lint: a dry run is measured against the whole tree digest, and
 * an apply is measured against the exact set of paths that changed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { ingestSource as ingestCore } from "../../src/core/brain/ingest/ingest.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { HYGIENE_TOOLS } from "../../src/mcp/brain/hygiene-tools.ts";
import { PROPERTY_DESCRIPTION_MAX, TOOL_DESCRIPTION_MAX } from "../../src/mcp/registry-guard.ts";
import { runCli } from "../helpers/run-cli.ts";
import { changedPaths, digestVaultFiles, digestVaultTree } from "../helpers/vault-digest.ts";

let tmp: string;
let vault: string;
let configPath: string;

interface ScanJson {
  readonly generated_at: string;
  readonly detectors_run: ReadonlyArray<string>;
  readonly findings: ReadonlyArray<{ id: string; detector: string; proposed_action: string }>;
  readonly counts: Readonly<Record<string, number>>;
  readonly errors: ReadonlyArray<unknown>;
}

interface ApplyJson {
  readonly plan: {
    readonly selected: ReadonlyArray<{ id: string }>;
    readonly excluded_review: ReadonlyArray<string>;
    readonly unknown_ids: ReadonlyArray<string>;
  };
  readonly result: {
    readonly dry_run: boolean;
    readonly planned: ReadonlyArray<{ action: string; finding_id: string }>;
    readonly applied: ReadonlyArray<{ action: string; finding_id: string }>;
    readonly errors: ReadonlyArray<unknown>;
  };
}

beforeEach(() => {
  resetVaultIdentityPins();
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-hygiene-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  resetVaultIdentityPins();
  rmSync(tmp, { recursive: true, force: true });
});

function env(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_CONFIG: configPath };
}

function writePref(slug: string, topic: string, principle: string): void {
  writeFileSync(
    join(brainDirs(vault).preferences, `pref-${slug}.md`),
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
      "---",
      "",
    ].join("\n"),
    "utf8",
  );
}

/** Two near-identical confirmed rules: the dedup detector proposes a merge. */
function seedDuplicatePair(): void {
  writePref("dup-a", "same-topic", "collect metrics before optimizing the code");
  writePref("dup-b", "same-topic", "collect metrics before optimizing the code base");
}

async function scan(...extra: string[]): Promise<ScanJson> {
  const out = await runCli(["brain", "hygiene", "scan", "--vault", vault, "--json", ...extra], {
    env: env(),
  });
  expect(out.returncode).toBe(0);
  return JSON.parse(out.stdout) as ScanJson;
}

describe("o2b brain hygiene scan", () => {
  test("the JSON surface parses and names the dedup finding", async () => {
    seedDuplicatePair();

    const report = await scan("--detectors", "dedup");

    expect(report.detectors_run).toEqual(["dedup"]);
    expect(report.errors).toEqual([]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.proposed_action).toBe("merge");
    expect(report.counts["dedup"]).toBe(1);
  });

  test("scan is read-only", async () => {
    seedDuplicatePair();
    const before = digestVaultTree(vault);
    await scan("--detectors", "dedup");
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("the human surface prints the finding and its proposed action", async () => {
    seedDuplicatePair();
    const out = await runCli(
      ["brain", "hygiene", "scan", "--vault", vault, "--detectors", "dedup"],
      { env: env() },
    );
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("dedup: 1 finding(s)");
    expect(out.stdout).toContain("-> merge");
  });

  test("an unknown detector is a named refusal", async () => {
    const out = await runCli(
      ["brain", "hygiene", "scan", "--vault", vault, "--detectors", "not-a-detector"],
      { env: env() },
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("conflicts, dedup, freshness, usefulness");
  });
});

describe("o2b brain hygiene apply", () => {
  test("a dry run reports the routed action and leaves the tree digest unchanged", async () => {
    seedDuplicatePair();
    const id = (await scan("--detectors", "dedup")).findings[0]!.id;
    const before = digestVaultTree(vault);

    const out = await runCli(
      [
        "brain",
        "hygiene",
        "apply",
        "--vault",
        vault,
        "--detectors",
        "dedup",
        "--ids",
        id,
        "--dry-run",
        "--json",
      ],
      { env: env() },
    );

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as ApplyJson;
    expect(payload.result.dry_run).toBe(true);
    expect(payload.result.applied).toEqual([]);
    expect(payload.result.planned.map((a) => a.action)).toEqual(["merge"]);
    expect(payload.plan.selected.map((f) => f.id)).toEqual([id]);

    expect(digestVaultTree(vault)).toBe(before);
  });

  test("an apply changes exactly the set the merge reports", async () => {
    seedDuplicatePair();
    const id = (await scan("--detectors", "dedup")).findings[0]!.id;
    const before = digestVaultFiles(vault);

    const out = await runCli(
      [
        "brain",
        "hygiene",
        "apply",
        "--vault",
        vault,
        "--detectors",
        "dedup",
        "--ids",
        id,
        "--json",
      ],
      { env: env() },
    );

    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as ApplyJson;
    expect(payload.result.dry_run).toBe(false);
    expect(payload.result.errors).toEqual([]);
    expect(payload.result.applied.map((a) => a.action)).toEqual(["merge"]);

    // A merge keeps the first target, retires the second, and records the
    // action in the hygiene audit log. Naming the set means a write
    // anywhere else fails this test.
    const changed = changedPaths(before, digestVaultFiles(vault));
    expect(changed.filter((p) => p.startsWith("Brain/preferences/"))).toEqual([
      "Brain/preferences/pref-dup-a.md",
      "Brain/preferences/pref-dup-b.md",
    ]);
    expect(changed.some((p) => p.startsWith("Brain/retired/ret-"))).toBe(true);
    expect(changed.some((p) => p.startsWith("Brain/log/hygiene/"))).toBe(true);
  });

  test("apply without --ids is refused and writes nothing", async () => {
    seedDuplicatePair();
    const before = digestVaultTree(vault);

    const out = await runCli(
      ["brain", "hygiene", "apply", "--vault", vault, "--detectors", "dedup"],
      { env: env() },
    );

    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("--ids");
    expect(digestVaultTree(vault)).toBe(before);
  });

  test("an unknown subcommand is a named refusal", async () => {
    const out = await runCli(["brain", "hygiene", "sniff", "--vault", vault], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("scan|apply");
  });
});

/**
 * The `capture-scope` detector reaches both surfaces (distilled provenance,
 * D3): it runs in the default sweep, it is a named subset member, and the
 * MCP schema offers it within the registry caps.
 */
describe("the capture-scope detector on the hygiene surfaces", () => {
  const DETECTOR = "capture-scope";

  test("the default sweep runs it and an explicit subset accepts it", async () => {
    expect((await scan()).detectors_run).toContain(DETECTOR);
    expect((await scan("--detectors", DETECTOR)).detectors_run).toEqual([DETECTOR]);
  });

  test("an unknown detector refusal lists it", async () => {
    const out = await runCli(
      ["brain", "hygiene", "scan", "--vault", vault, "--detectors", "not-a-detector"],
      { env: env() },
    );
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain(DETECTOR);
  });

  test("the brain_hygiene schema offers it within the registry caps", () => {
    const tool = HYGIENE_TOOLS[0]!;
    const props = tool.inputSchema["properties"] as Record<
      string,
      { description: string; items?: { enum?: string[] } }
    >;
    expect(props["detectors"]!.items!.enum).toContain(DETECTOR);
    expect(props["detectors"]!.description).toContain(DETECTOR);
    expect(props["detectors"]!.description.length).toBeLessThanOrEqual(PROPERTY_DESCRIPTION_MAX);
    expect(tool.description).toContain("url-only");
    expect(tool.description.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_MAX);
  });
});

/**
 * The archive finding (answer trust, Task C5) rides the same CLI scan: a
 * summary page stamped with an archive digest whose entry is gone is a
 * named finding in the default sweep, and the scan stays read-only about
 * it. An intact entry and an unstamped page are not findings.
 */
describe("the capture-scope archive finding on the CLI scan", () => {
  const DETECTOR = "capture-scope";
  const SOURCE = "Articles/keep.md";
  const ingestSource = (contents: string): { summaryPath: string; hash: string } => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, SOURCE), contents, "utf8");
    const res = ingestCore(
      vault,
      {
        sourcePath: SOURCE,
        summary: "Kept durable.",
        extraction: { entities: [{ category: "concept", name: "Keep" }], relations: [] },
      },
      { agent: "test-agent", now: new Date("2026-02-02T00:00:00Z") },
    );
    if (res.sourceArchiveHash === undefined) throw new Error("expected an archive stamp");
    return { summaryPath: res.summaryPath, hash: res.sourceArchiveHash };
  };

  test("a missing entry is a finding in the default sweep; an intact one is not", async () => {
    const { hash } = ingestSource("kept bytes\n");
    expect((await scan()).findings).toEqual([]);

    rmSync(join(vault, "Brain", ".archives", `${hash}.txt`));
    const report = await scan();
    const finding = report.findings.find((f) => f.detector === DETECTOR);
    expect(finding).toBeDefined();
    expect(finding!.proposed_action).toBe("review");
    expect(report.counts[DETECTOR]).toBeGreaterThanOrEqual(1);
  });

  test("the finding names the summary page and the scan stays read-only", async () => {
    const { summaryPath, hash } = ingestSource("other bytes\n");
    rmSync(join(vault, "Brain", ".archives", `${hash}.txt`));
    const before = digestVaultTree(vault);

    const report = await scan("--detectors", DETECTOR);
    const finding = report.findings.find((f) => f.detector === DETECTOR);
    expect(finding).toBeDefined();
    expect(JSON.stringify(finding)).toContain(summaryPath);
    expect(digestVaultTree(vault)).toBe(before);
  });
});

/**
 * The doctor's informational archive section (answer trust, Task C6):
 * count-only - entry count, total bytes, missing/mismatched counts - always
 * present in the JSON, a line in the human output only when there is
 * something to describe, and no fix verb anywhere.
 */
describe("the doctor archive section", () => {
  interface ArchivesJson {
    readonly archives: {
      readonly entries: number;
      readonly totalBytes: number;
      readonly missing: number;
      readonly mismatched: number;
      readonly uncited: number;
    };
  }
  const doctorJson = async (): Promise<ArchivesJson> => {
    const out = await runCli(["brain", "doctor", "--vault", vault, "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    return JSON.parse(out.stdout) as ArchivesJson;
  };

  const ingestOne = (
    contents: string,
    rel = "Articles/counted.md",
  ): { hash: string; summaryPath: string } => {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), contents, "utf8");
    const res = ingestCore(
      vault,
      {
        sourcePath: rel,
        summary: "Counted.",
        extraction: { entities: [{ category: "concept", name: "Counted" }], relations: [] },
      },
      { agent: "test-agent", now: new Date("2026-02-03T00:00:00Z") },
    );
    if (res.sourceArchiveHash === undefined) throw new Error("expected an archive stamp");
    return { hash: res.sourceArchiveHash, summaryPath: res.summaryPath };
  };

  test("a vault that never archived reports an all-zero section, and prints no line", async () => {
    expect(await doctorJson()).toMatchObject({
      archives: { entries: 0, totalBytes: 0, missing: 0, mismatched: 0, uncited: 0 },
    });
    const human = await runCli(["brain", "doctor", "--vault", vault], { env: env() });
    expect(human.returncode).toBe(0);
    expect(human.stdout).not.toContain("archives:");
  });

  test("an ingested source is one entry with its bytes, on both surfaces", async () => {
    ingestOne("counted bytes\n");
    // Whole-object, not a subset match: a key smuggled into the section
    // (or an old shape drifting back) fails here.
    expect((await doctorJson()).archives).toEqual({
      entries: 1,
      totalBytes: Buffer.byteLength("counted bytes\n", "utf8"),
      missing: 0,
      mismatched: 0,
      uncited: 0,
    });

    const human = await runCli(["brain", "doctor", "--vault", vault], { env: env() });
    expect(human.stdout).toContain(
      `archives: 1 entries, ${Buffer.byteLength("counted bytes\n", "utf8")} bytes, 0 missing, 0 mismatched, 0 uncited`,
    );
  });

  test("a removed entry counts as missing; a tampered one as mismatched", async () => {
    const { hash } = ingestOne("audited bytes\n");
    const entry = join(vault, "Brain", ".archives", `${hash}.txt`);

    rmSync(entry);
    expect((await doctorJson()).archives).toMatchObject({ entries: 0, missing: 1 });

    writeFileSync(entry, "rewritten", "utf8");
    expect((await doctorJson()).archives).toMatchObject({ entries: 1, mismatched: 1 });
  });

  test("a page deleted out-of-band leaves its entry counted as uncited", async () => {
    // Two sources, two distinct entries. Removing the first summary page
    // out-of-band - the state a re-stamped page or a review-rejected staged
    // ingest leaves behind - leaves its entry in the store, cited by
    // nothing, while the second entry keeps its page.
    const first = ingestOne("orphaned bytes\n", "Articles/orphaned.md");
    const second = ingestOne("still cited bytes\n", "Articles/cited.md");
    expect(first.hash).not.toBe(second.hash);
    rmSync(join(vault, first.summaryPath));

    expect((await doctorJson()).archives).toMatchObject({
      entries: 2,
      uncited: 1,
      missing: 0,
      mismatched: 0,
    });

    const human = await runCli(["brain", "doctor", "--vault", vault], { env: env() });
    expect(human.stdout).toContain(", 1 uncited");
  });

  test("an unreadable archive store is an uncertain section, not a failed run", async () => {
    // Platform-neutral refusal: a FILE standing where the store directory
    // belongs. A chmod cannot deny on Windows.
    writeFileSync(join(vault, "Brain", ".archives"), "not a directory", "utf8");

    // A completed run, not a throw - and the human surface names the skip.
    const human = await runCli(["brain", "doctor", "--vault", vault], { env: env() });
    expect(human.returncode).toBe(0);
    expect(human.stdout).toContain("[UNSURE] vault-walk-entry-skipped");
    expect(human.stdout).not.toContain("archives: ");

    // The JSON payload stays parseable, answers the unavailability by name,
    // and carries the skip in the uncertainty stream.
    const out = await runCli(["brain", "doctor", "--vault", vault, "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const payload = JSON.parse(out.stdout) as {
      archives: Record<string, unknown>;
      uncertain?: ReadonlyArray<{ code: string; path?: string }>;
    };
    expect(payload.archives).toEqual({ unavailable: true });
    expect(payload.uncertain?.some((u) => u.code === "vault-walk-entry-skipped")).toBe(true);
  });
});

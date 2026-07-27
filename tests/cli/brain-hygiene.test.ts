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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
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

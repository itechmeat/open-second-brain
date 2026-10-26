/**
 * `o2b brain continuity promote` (issue #277): dry-run-first readback of
 * continuity `host_memory_write` records into unconfirmed preference
 * pages, sealed with an approval digest an apply must carry back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordHostMemoryWrite } from "../../src/core/brain/host-memory-write.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-continuity-promote-cli-"));
  vault = join(tmp, "vault");
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: test-agent\n`);
  bootstrapBrain(vault, { configPath });
  recordHostMemoryWrite(vault, {
    action: "add",
    target: "user",
    content: "User prefers dark mode",
    createdAt: "2026-06-20T10:00:00Z",
  });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const env = () => ({ OPEN_SECOND_BRAIN_CONFIG: configPath });

const PROMOTE = ["brain", "continuity", "promote"];

describe("o2b brain continuity promote", () => {
  test("dry-run default leaves the vault untouched and prints plan plus digest", async () => {
    const out = await runCli([...PROMOTE], { env: env() });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("promote plan: 1 actionable, 0 skipped");
    expect(out.stdout).toContain("CREATE pref-hostmem-");
    expect(out.stdout).toContain("approval-digest: ");
    // The preferences directory exists from bootstrap; no promote page
    // may be inside it, and no sidecar or snapshot may exist either.
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((name) =>
        name.startsWith("pref-hostmem-"),
      ),
    ).toEqual([]);
    expect(existsSync(join(vault, "Brain", ".imports", "host-memory-promotions.json"))).toBe(false);
    expect(
      readdirSync(join(vault, "Brain", ".snapshots")).filter((name) =>
        name.startsWith("promote-host-memory-"),
      ),
    ).toEqual([]);
  });

  test("--apply with the dry run's digest writes the page and prints the snapshot", async () => {
    const dry = await runCli([...PROMOTE, "--json"], { env: env() });
    const digest = (JSON.parse(dry.stdout) as { digest: string }).digest;

    const out = await runCli([...PROMOTE, "--apply", "--approval-digest", digest], {
      env: env(),
    });
    expect(out.returncode).toBe(0);
    expect(out.stdout).toContain("applied: 1");
    expect(out.stdout).toContain("snapshot: promote-host-memory-");
    const prefs = join(vault, "Brain", "preferences");
    expect(readdirSync(prefs).some((name) => name.startsWith("pref-hostmem-"))).toBe(true);
  });

  test("--json prints one stable envelope", async () => {
    const out = await runCli([...PROMOTE, "--json"], { env: env() });
    expect(out.returncode).toBe(0);
    const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).toSorted()).toEqual(
      [
        "applied",
        "counts",
        "digest",
        "mode",
        "month",
        "plans",
        "skipped",
        "snapshot",
        "total",
      ].toSorted(),
    );
    expect(parsed["mode"]).toBe("dry-run");
    expect(parsed["month"]).toBeNull();
    expect(parsed["total"]).toBe(1);
    expect(parsed["snapshot"]).toBeNull();
    expect(Object.keys(parsed["counts"] as Record<string, unknown>).toSorted()).toEqual(
      [
        "applied",
        "conflicts",
        "plans",
        "private_dropped",
        "redacted",
        "skipped",
        "skipped_unchanged",
      ].toSorted(),
    );
    const plans = parsed["plans"] as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(Object.keys(plans[0]!).toSorted()).toEqual(["action", "id", "pref_id"]);
    expect(plans[0]!["action"]).toBe("CREATE");
  });

  test("a bad --month fails with the usage message", async () => {
    const out = await runCli([...PROMOTE, "--month", "June"], { env: env() });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("--month must look like YYYY-MM");
  });

  test("--approval-digest paired with a dry run is refused", async () => {
    const out = await runCli([...PROMOTE, "--approval-digest", "deadbeef"], { env: env() });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("a dry run computes a digest, it does not consume one");
  });

  test("non-interactive --apply without a digest is refused", async () => {
    const out = await runCli([...PROMOTE, "--apply"], { env: env() });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("--apply requires --approval-digest in non-interactive");
  });

  test("an unknown subcommand fails with the USAGE block", async () => {
    const out = await runCli(["brain", "continuity", "replay"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("usage: o2b brain continuity export");
    expect(out.stderr).toContain("o2b brain continuity promote");
  });
});

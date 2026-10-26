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

function writeHostMemory(v: string, content: string, createdAt: string) {
  recordHostMemoryWrite(v, { action: "add", target: "user", content, createdAt });
}

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
        "conflicts",
        "counts",
        "digest",
        "manifest_corrupt",
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
    // A subprocess with a piped stdin, NOT the in-process form: the
    // guard reads process.stdin.isTTY, which in-process is inherited
    // from the runner and turns this test into a pass-on-CI /
    // fail-in-a-terminal flip (review M8).
    const out = await runCli([...PROMOTE, "--apply"], { env: env(), stdin: "" });
    expect(out.returncode).toBe(2);
    expect(out.stderr).toContain("--apply requires --approval-digest in non-interactive");
    // The refusal wrote nothing.
    expect(
      readdirSync(join(vault, "Brain", "preferences")).filter((name) =>
        name.startsWith("pref-hostmem-"),
      ),
    ).toEqual([]);
  });

  test("the exit-2 conflict path spells the same envelope, plans included (review M7)", async () => {
    // Land a page, then drop the sidecar: the next run plans CONFLICT
    // for the orphaned page, and the conflict apply exits 2 after the
    // safe writes land.
    const dry = await runCli([...PROMOTE, "--json"], { env: env() });
    const digest = (JSON.parse(dry.stdout) as { digest: string }).digest;
    await runCli([...PROMOTE, "--apply", "--approval-digest", digest], { env: env() });
    rmSync(join(vault, "Brain", ".imports", "host-memory-promotions.json"));
    writeHostMemory(vault, "A second fact", "2026-06-21T10:00:00Z");

    const dry2 = await runCli([...PROMOTE, "--json"], { env: env() });
    const dry2Parsed = JSON.parse(dry2.stdout) as {
      plans: Array<Record<string, unknown>>;
      conflicts: Array<Record<string, unknown>>;
    };
    expect(dry2Parsed.plans).toHaveLength(2);
    expect(dry2Parsed.conflicts).toHaveLength(1);
    expect(dry2Parsed.plans.some((p) => p["action"] === "CONFLICT")).toBe(true);

    const digest2 = (JSON.parse(dry2.stdout) as { digest: string }).digest;
    // The snapshot run-id embeds the second; two applies inside one
    // second collide on the archive name and the second refuses. The
    // CLI surface cannot pin a clock the way the core tests do, so the
    // run boundary is the test's clock.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const out = await runCli([...PROMOTE, "--apply", "--json", "--approval-digest", digest2], {
      env: env(),
    });
    expect(out.returncode).toBe(2);
    const parsed = JSON.parse(out.stdout) as {
      mode: string;
      plans: Array<Record<string, unknown>>;
      conflicts: Array<Record<string, unknown>>;
      counts: Record<string, unknown>;
    };
    expect(Object.keys(parsed).toSorted()).toEqual(
      [
        "applied",
        "conflicts",
        "counts",
        "digest",
        "manifest_corrupt",
        "mode",
        "month",
        "plans",
        "skipped",
        "snapshot",
        "total",
      ].toSorted(),
    );
    // The consumer keying on `plans` sees the conflict row, not zero.
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.conflicts).toHaveLength(1);
    expect(parsed.counts["applied"]).toBe(1);
  });

  test("an unknown subcommand fails with the USAGE block", async () => {
    const out = await runCli(["brain", "continuity", "replay"], { env: env() });
    expect(out.returncode).not.toBe(0);
    expect(out.stderr).toContain("usage: o2b brain continuity export");
    expect(out.stderr).toContain("o2b brain continuity promote");
  });
});

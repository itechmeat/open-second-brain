/**
 * `o2b brain reject` writes its retirement provenance into the log shard
 * this device actually appends to (issue #271, CLI side).
 *
 * The merge and dream halves live in
 * tests/core/brain/retirement-log-shard.test.ts; this file pins the same
 * contract for the CLI verb: with a configured device id the retired_by
 * link names the sharded day file the reject append creates, and with the
 * documented empty-device-id opt-out the link keeps the exact historical
 * un-sharded shape. The link is resolved from the written page itself, so
 * the assertion never depends on the wall-clock date the verb stamped.
 *
 * Every hook lives INSIDE the describe block, on purpose: bun's hook
 * registry spans the files one worker loads, and a top-level beforeEach
 * here would mint a vault around other files' tests too - the temp guard
 * then names this prefix from a file that finished long ago. The
 * OPEN_SECOND_BRAIN_CONFIG pointer reaches the CLI through runCli's own
 * isolated-env channel instead of a process.env write, so nothing this
 * file sets outlives a test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { brainDirs, retiredPath } from "../../src/core/brain/paths.ts";
import { parseRetired, writePreference } from "../../src/core/brain/preference.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { tempDirs } from "../helpers/temp-dir.ts";
import { runCli } from "../helpers/run-cli.ts";

const DEVICE_ID = "fixturedev";

describe("brain reject retirement log shard", () => {
  const mkTemp = tempDirs();
  const savedDeviceEnv = process.env["O2B_DEVICE_ID"];

  let tmp: string;
  let vault: string;
  let config: string;

  beforeEach(() => {
    tmp = mkTemp("o2b-reject-shard-");
    vault = join(tmp, "vault");
    config = join(tmp, "config.yaml");
    atomicWriteFileSync(config, `vault: ${vault}\n`);
    bootstrapBrain(vault, { configPath: config });
    writePreference(vault, {
      slug: "old",
      topic: "formatting",
      principle: "always run the formatter before every commit in this repository",
      created_at: "2026-06-01T00:00:00Z",
      confirmed_at: "2026-06-02T00:00:00Z",
      unconfirmed_until: "2026-06-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-1]]"],
      applied_count: 1,
      violated_count: 0,
      last_evidence_at: "2026-06-02T00:00:00Z",
      confidence: "low",
    });
  });

  afterEach(() => {
    // Clean here, not only in the tempDirs() safety net: the guard's
    // afterAll must never see a vault this file minted, whatever order
    // the file-level nets run in.
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (savedDeviceEnv === undefined) delete process.env["O2B_DEVICE_ID"];
    else process.env["O2B_DEVICE_ID"] = savedDeviceEnv;
  });

  /**
   * Write the per-test `device_id` line (sharded, or the empty env opt-out
   * that keeps the legacy un-sharded pair). The config path reaches the
   * CLI through runCli's isolated env, never a process.env write.
   */
  function registerConfig(deviceId: string | null): void {
    const deviceLine = deviceId === null ? "" : `device_id: "${deviceId}"\n`;
    atomicWriteFileSync(config, `vault: ${vault}\n${deviceLine}`);
    if (deviceId === null) process.env["O2B_DEVICE_ID"] = "";
    else delete process.env["O2B_DEVICE_ID"];
  }

  /** The retired page's link must have the expected shape and resolve on disk. */
  function assertRetiredByResolves(shardSuffix: string): void {
    const ret = parseRetired(retiredPath(vault, "old"));
    const pattern = `^\\[\\[Brain/log/\\d{4}-\\d{2}-\\d{2}${shardSuffix}\\]\\]$`;
    expect(ret.retired_by).toMatch(new RegExp(pattern));
    const target = String(ret.retired_by).slice("[[Brain/log/".length, -2);
    expect(existsSync(join(brainDirs(vault).log, `${target}.md`))).toBe(true);
  }

  function reject(): Promise<{ stdout: string; stderr: string; returncode: number }> {
    return runCli(
      ["brain", "reject", "--vault", vault, "--id", "pref-old", "--reason", "obsolete"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
  }

  test("with a configured device id, retired_by names the shard the append creates", async () => {
    registerConfig(DEVICE_ID);
    const r = await reject();
    expect(r.returncode).toBe(0);
    assertRetiredByResolves(`\\.${DEVICE_ID}`);
  });

  test("with the empty-device-id opt-out, retired_by keeps the historical shape", async () => {
    registerConfig(null);
    const r = await reject();
    expect(r.returncode).toBe(0);
    assertRetiredByResolves("");
  });
});

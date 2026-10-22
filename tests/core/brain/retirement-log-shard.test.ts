/**
 * Regression tests for issue #271: the `retired_by` provenance a merge
 * or dream retirement stamps must name the log shard this device
 * actually appends to, not the legacy un-sharded day file.
 *
 * The device id is configured the way the issue's repro does it - a
 * temp `config.yaml` with `device_id` reached through
 * `OPEN_SECOND_BRAIN_CONFIG`, with `O2B_DEVICE_ID` cleared so the
 * config file is what resolves. Every test registers its own config and
 * vault and restores the environment in `afterEach`, including on
 * failure.
 *
 * The backward-compatibility half pins the historical shape: with the
 * empty device id (the documented `O2B_DEVICE_ID=""` opt-out) the link
 * stays exactly `[[Brain/log/<date>]]` - no historical record is
 * rewritten by the fix, and un-sharded vaults keep writing the same
 * bytes they always did.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { logShardWikilink } from "../../../src/core/brain/log.ts";
import { resolveAppendShardId } from "../../../src/core/brain/ledger-shards.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { brainDirs, retiredPath } from "../../../src/core/brain/paths.ts";
import { parseRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { normaliseWikilinkTarget } from "../../../src/core/brain/wikilink.ts";

const DEVICE_ID = "fixturedev";

let vault: string;
let configHome: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-retire-shard-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-retire-shard-cfg-"));
  savedEnv["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  savedEnv["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
  // Clear the env override so the device id resolves from the config
  // file, like the issue's repro.
  delete process.env["O2B_DEVICE_ID"];
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "O2B_DEVICE_ID"]) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * Point `OPEN_SECOND_BRAIN_CONFIG` at a temp config.yaml for `vault`,
 * with `device_id` present (sharded) or absent plus the empty env
 * opt-out (legacy un-sharded pair).
 */
function registerConfig(deviceId: string | null): void {
  const configPath = join(configHome, "config.yaml");
  const deviceLine = deviceId === null ? "" : `device_id: "${deviceId}"\n`;
  atomicWriteFileSync(configPath, `vault: ${vault}\n${deviceLine}`);
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  if (deviceId === null) process.env["O2B_DEVICE_ID"] = "";
  bootstrapBrain(vault, { configPath });
}

function confirmedPref(slug: string, topic: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: "high",
    confidence_value: 0.8,
    pinned: false,
  });
}

/**
 * The issue's core assertion: the retired_by link's target must exist
 * as a file, and the doctor must report no broken-wikilink finding for
 * the retired_by field.
 */
function assertProvenanceResolves(retiredBy: string): void {
  const target = normaliseWikilinkTarget(retiredBy);
  expect(existsSync(join(brainDirs(vault).log, `${target}.md`))).toBe(true);

  const doc = runDoctor(vault, { now: new Date("2026-10-22T12:00:00Z") });
  const brokenRetiredBy = doc.warnings.filter(
    (w) => w.code === "broken-wikilink" && w.field === "retired_by",
  );
  expect(brokenRetiredBy).toEqual([]);
}

// ----- Shared helper --------------------------------------------------------

describe("logShardWikilink", () => {
  test("empty shard id keeps the exact historical shape", () => {
    registerConfig(null);
    expect(logShardWikilink("2026-10-22")).toBe("[[Brain/log/2026-10-22]]");
  });

  test("configured device id names the shard file the appender writes", () => {
    registerConfig(DEVICE_ID);
    expect(resolveAppendShardId()).toBe(DEVICE_ID);
    expect(logShardWikilink("2026-10-22")).toBe(`[[Brain/log/2026-10-22.${DEVICE_ID}]]`);
  });

  test("an explicit shard id wins over config resolution", () => {
    registerConfig(DEVICE_ID);
    expect(logShardWikilink("2026-10-22", "otherdev")).toBe("[[Brain/log/2026-10-22.otherdev]]");
  });

  test("rejects a shard id the appender would reject", () => {
    registerConfig(DEVICE_ID);
    expect(() => logShardWikilink("2026-10-22", "Sync-Conflict")).toThrow();
  });
});

// ----- Merge retirement -----------------------------------------------------

describe("mergePreferences retirement provenance under a configured device id", () => {
  test("retired_by names the existing device shard and the doctor reports no broken link", () => {
    registerConfig(DEVICE_ID);
    confirmedPref("alpha", "commits");
    confirmedPref("beta", "commits");

    const now = new Date("2026-10-22T10:00:00Z");
    mergePreferences(vault, "pref-alpha", "pref-beta", { now });

    const ret = parseRetired(retiredPath(vault, "beta"));
    expect(ret.retired_by).toBe(`[[Brain/log/2026-10-22.${DEVICE_ID}]]`);

    const logDir = brainDirs(vault).log;
    expect(existsSync(join(logDir, `2026-10-22.${DEVICE_ID}.md`))).toBe(true);
    expect(existsSync(join(logDir, "2026-10-22.md"))).toBe(false);

    assertProvenanceResolves(ret.retired_by);
  });

  test("empty device id keeps the historical un-sharded shape", () => {
    registerConfig(null);
    confirmedPref("alpha", "commits");
    confirmedPref("beta", "commits");

    const now = new Date("2026-10-22T10:00:00Z");
    mergePreferences(vault, "pref-alpha", "pref-beta", { now });

    const ret = parseRetired(retiredPath(vault, "beta"));
    expect(ret.retired_by).toBe("[[Brain/log/2026-10-22]]");
    expect(existsSync(join(brainDirs(vault).log, "2026-10-22.md"))).toBe(true);

    assertProvenanceResolves(ret.retired_by);
  });
});

// ----- Dream retirement -----------------------------------------------------

describe("dream retirement provenance under a configured device id", () => {
  test("retired_by names the existing device shard and the doctor reports no broken link", () => {
    registerConfig(DEVICE_ID);
    writePreference(vault, {
      slug: "stale-rule",
      topic: "stale-rule",
      principle: "Old rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-01-05T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-01-10T00:00:00Z",
      confidence: "medium",
      pinned: false,
    });

    dream(vault, { now: new Date("2026-08-01T00:00:00Z") });

    const ret = parseRetired(retiredPath(vault, "stale-rule"));
    expect(ret.retired_by).toBe(`[[Brain/log/2026-08-01.${DEVICE_ID}]]`);

    const logDir = brainDirs(vault).log;
    expect(existsSync(join(logDir, `2026-08-01.${DEVICE_ID}.md`))).toBe(true);
    expect(existsSync(join(logDir, "2026-08-01.md"))).toBe(false);

    assertProvenanceResolves(ret.retired_by);
  });

  test("empty device id keeps the historical un-sharded shape", () => {
    registerConfig(null);
    writePreference(vault, {
      slug: "stale-rule",
      topic: "stale-rule",
      principle: "Old rule",
      created_at: "2026-01-01T00:00:00Z",
      unconfirmed_until: "2026-01-15T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      confirmed_at: "2026-01-05T00:00:00Z",
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-01-10T00:00:00Z",
      confidence: "medium",
      pinned: false,
    });

    dream(vault, { now: new Date("2026-08-01T00:00:00Z") });

    const ret = parseRetired(retiredPath(vault, "stale-rule"));
    expect(ret.retired_by).toBe("[[Brain/log/2026-08-01]]");
    expect(existsSync(join(brainDirs(vault).log, "2026-08-01.md"))).toBe(true);

    assertProvenanceResolves(ret.retired_by);
  });
});

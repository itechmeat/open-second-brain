/**
 * The write-approval lane resolver (write-side trust, Task 6).
 *
 * Three lanes sit under one master key. Resolution order per lane:
 * lane key, then master `write_approval.enabled`, then off. The env
 * twin wins over the config value per key, exactly as every other
 * flat-key resolver in this project. The signals lane has no key of
 * its own - the master key IS its lane key, which is what keeps the
 * pre-existing toggle's meaning unchanged.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REVIEW_LANE,
  REVIEW_LANES,
  WRITE_APPROVAL_INGEST_CONFIG_KEY,
  WRITE_APPROVAL_INGEST_ENV_KEY,
  WRITE_APPROVAL_NOTES_CONFIG_KEY,
  WRITE_APPROVAL_NOTES_ENV_KEY,
  isReviewLane,
  resolveWriteApprovalLane,
} from "../../../src/core/brain/write-gate.ts";

const toCleanup: string[] = [];
const envSaved = new Map<string, string | undefined>();

afterEach(() => {
  // Restore ONLY the keys this file actually overrode. Iterating the full
  // ENV_KEYS list deleted entries it never saved - including the
  // `OPEN_SECOND_BRAIN_CONFIG` default tests/setup.ts installs for the
  // whole run - so any later file in the same process that relies on the
  // hermetic default failed with "plugin config not found".
  for (const [key, saved] of envSaved) {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  envSaved.clear();
  for (const p of toCleanup.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Write a device config with the given flat keys and return its path. */
function configWith(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-write-gate-cfg-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, `${lines.join("\n")}\n`);
  toCleanup.push(dir);
  return configPath;
}

function setEnv(key: string, value: string | undefined): void {
  if (!envSaved.has(key)) envSaved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("resolveWriteApprovalLane", () => {
  test("every lane resolves off when no key and no env is set", () => {
    const configPath = configWith(["vault: /tmp/somewhere"]);
    for (const lane of REVIEW_LANES) {
      expect(resolveWriteApprovalLane(lane, configPath)).toBe(false);
    }
  });

  test("the signals lane is decided by the master key", () => {
    const on = configWith(["vault: /tmp/somewhere", "write_approval.enabled: true"]);
    expect(resolveWriteApprovalLane("signals", on)).toBe(true);
    const off = configWith(["vault: /tmp/somewhere", "write_approval.enabled: false"]);
    expect(resolveWriteApprovalLane("signals", off)).toBe(false);
  });

  test("a non-true master value is off, not an error", () => {
    const configPath = configWith(["vault: /tmp/somewhere", "write_approval.enabled: yes"]);
    expect(resolveWriteApprovalLane("signals", configPath)).toBe(false);
  });

  test("the notes lane falls back to the master key when its own key is absent", () => {
    const masterOn = configWith(["vault: /tmp/somewhere", "write_approval.enabled: true"]);
    expect(resolveWriteApprovalLane("notes", masterOn)).toBe(true);
    const masterOff = configWith(["vault: /tmp/somewhere"]);
    expect(resolveWriteApprovalLane("notes", masterOff)).toBe(false);
  });

  test("an explicit notes key wins over the master in both directions", () => {
    const laneOnMasterOff = configWith([
      "vault: /tmp/somewhere",
      "write_approval.enabled: false",
      `${WRITE_APPROVAL_NOTES_CONFIG_KEY}: true`,
    ]);
    expect(resolveWriteApprovalLane("notes", laneOnMasterOff)).toBe(true);
    const laneOffMasterOn = configWith([
      "vault: /tmp/somewhere",
      "write_approval.enabled: true",
      `${WRITE_APPROVAL_NOTES_CONFIG_KEY}: false`,
    ]);
    expect(resolveWriteApprovalLane("notes", laneOffMasterOn)).toBe(false);
  });

  test("the ingest lane resolves under the same table", () => {
    const both = configWith([
      "vault: /tmp/somewhere",
      "write_approval.enabled: true",
      `${WRITE_APPROVAL_INGEST_CONFIG_KEY}: true`,
    ]);
    expect(resolveWriteApprovalLane("ingest", both)).toBe(true);
    const only = configWith(["vault: /tmp/somewhere", `${WRITE_APPROVAL_INGEST_CONFIG_KEY}: true`]);
    expect(resolveWriteApprovalLane("ingest", only)).toBe(true);
    expect(resolveWriteApprovalLane("notes", only)).toBe(false);
  });

  test("the env twin wins per key over the config value", () => {
    const configPath = configWith([
      "vault: /tmp/somewhere",
      `${WRITE_APPROVAL_NOTES_CONFIG_KEY}: false`,
      `${WRITE_APPROVAL_INGEST_CONFIG_KEY}: false`,
    ]);
    setEnv(WRITE_APPROVAL_NOTES_ENV_KEY, "true");
    setEnv(WRITE_APPROVAL_INGEST_ENV_KEY, "true");
    expect(resolveWriteApprovalLane("notes", configPath)).toBe(true);
    expect(resolveWriteApprovalLane("ingest", configPath)).toBe(true);
  });

  test("an empty env value counts as unset and falls through to config", () => {
    const configPath = configWith(["vault: /tmp/somewhere", "write_approval.enabled: true"]);
    setEnv("OPEN_SECOND_BRAIN_WRITE_APPROVAL_ENABLED", "");
    expect(resolveWriteApprovalLane("signals", configPath)).toBe(true);
  });

  test("an absent config file resolves every lane off", () => {
    expect(resolveWriteApprovalLane("signals", "/nonexistent/o2b-gate/config.yaml")).toBe(false);
    expect(resolveWriteApprovalLane("notes", "/nonexistent/o2b-gate/config.yaml")).toBe(false);
  });

  test("the lane vocabulary is a closed trio with a guard", () => {
    expect(REVIEW_LANES).toEqual(["signals", "notes", "ingest"]);
    expect(isReviewLane("notes")).toBe(true);
    expect(isReviewLane("signals")).toBe(true);
    expect(isReviewLane("ingest")).toBe(true);
    expect(isReviewLane("everything")).toBe(false);
    expect(isReviewLane(42)).toBe(false);
    expect(REVIEW_LANE.notes).toBe("notes");
  });
});

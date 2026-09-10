/**
 * Setting and lifting the fleet freeze (who-wrote-what, Task C).
 *
 * The marker's whole content is its existence, so the two log events are
 * the only durable record of who stopped the vault and who started it
 * again. These tests hold both ends to that: one event per real
 * transition, none for a call that changed nothing, and an `unfreeze`
 * that still carries what the marker said before it was removed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freezeVault, unfreezeVault } from "../../../src/core/brain/freeze.ts";
import {
  FREEZE_MARKER_SCHEMA_VERSION,
  FREEZE_MARKER_UNREADABLE_REASON,
  frozenMarkerPath,
  readFreezeMarker,
  resetFreezeMarkerCache,
} from "../../../src/core/brain/freeze-marker.ts";
import { readLogDay } from "../../../src/core/brain/log-jsonl.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";

let vault: string;

const AT = new Date("2026-09-10T08:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-freeze-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
});

/** Every event of `kind` recorded on the day the test's clock names. */
function events(kind: string): ReadonlyArray<Record<string, unknown>> {
  const day = readLogDay(vault, "2026-09-10");
  return day.entries.filter((e) => e.eventType === kind).map((e) => e.body);
}

describe("freezing", () => {
  test("writes the marker and records exactly one freeze event", () => {
    const out = freezeVault(vault, { agent: "@operator", reason: "migrating", now: AT });
    expect(out.changed).toBe(true);
    expect(out.marker.frozen_at).toBe("2026-09-10T08:00:00Z");
    expect(out.marker.by).toBe("@operator");
    expect(out.marker.reason).toBe("migrating");

    const onDisk = JSON.parse(readFileSync(frozenMarkerPath(vault), "utf8")) as Record<
      string,
      unknown
    >;
    expect(onDisk["schema"]).toBe(FREEZE_MARKER_SCHEMA_VERSION);
    expect(onDisk["reason"]).toBe("migrating");

    const recorded = events("freeze");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!["reason"]).toBe("migrating");
    expect(recorded[0]!["agent"]).toBe("@operator");
  });

  test("a reason is optional and its absence is recorded as such, never invented", () => {
    const out = freezeVault(vault, { agent: "@operator", now: AT });
    expect(out.marker.reason).toBe("");
    expect(events("freeze")[0]!["reason"]).toBe("");
  });

  test("freezing an already frozen vault changes nothing and logs nothing", () => {
    freezeVault(vault, { agent: "@operator", reason: "first", now: AT });
    const again = freezeVault(vault, { agent: "@other", reason: "second", now: AT });
    expect(again.changed).toBe(false);
    // The first freeze stands: a second call must not overwrite who
    // stopped the vault or why.
    expect(again.marker.by).toBe("@operator");
    expect(again.marker.reason).toBe("first");
    expect(readFreezeMarker(vault)!.reason).toBe("first");
    expect(events("freeze")).toHaveLength(1);
  });
});

describe("unfreezing", () => {
  test("removes the marker and records what it said before it went", () => {
    freezeVault(vault, { agent: "@operator", reason: "migrating", now: AT });
    const out = unfreezeVault(vault, { agent: "@operator", now: AT });
    expect(out.changed).toBe(true);
    expect(existsSync(frozenMarkerPath(vault))).toBe(false);
    expect(readFreezeMarker(vault)).toBeNull();

    const recorded = events("unfreeze");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!["frozen_at"]).toBe("2026-09-10T08:00:00Z");
    expect(recorded[0]!["by"]).toBe("@operator");
    expect(recorded[0]!["reason"]).toBe("migrating");
  });

  test("unfreezing an unfrozen vault changes nothing and logs nothing", () => {
    const out = unfreezeVault(vault, { agent: "@operator", now: AT });
    expect(out.changed).toBe(false);
    expect(out.marker).toBeNull();
    expect(events("unfreeze")).toHaveLength(0);
  });

  test("lifts a marker nobody could parse, and says so in the event", () => {
    mkdirSync(join(vault, "Brain", ".state"), { recursive: true });
    writeFileSync(frozenMarkerPath(vault), "{ not json", "utf8");
    const out = unfreezeVault(vault, { agent: "@operator", now: AT });
    expect(out.changed).toBe(true);
    expect(existsSync(frozenMarkerPath(vault))).toBe(false);
    expect(events("unfreeze")[0]!["reason"]).toBe(FREEZE_MARKER_UNREADABLE_REASON);
  });
});

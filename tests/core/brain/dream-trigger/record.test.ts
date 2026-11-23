/**
 * The day record of the dream session trigger (design D1): its path from
 * the configured store root, an atomic write, and a missing or corrupt
 * record read as unknown.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  configuredTriggerStoreRoot,
  dreamDayRecordWaits,
  dreamTriggerKey,
  dreamTriggerRecordPath,
  emptyDreamTriggerRecord,
  readDreamTriggerRecord,
  updateDreamTriggerRecord,
  writeDreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-trigger-record-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the record's path", () => {
  test("is keyed by the configured store root, under the state root", () => {
    const configPath = join(tmp, "config.yaml");
    const config = { path: configPath, exists: true, data: { store_root: "brain-store" } };
    const root = configuredTriggerStoreRoot(config, {});
    // A relative root is taken from the config file's folder, as the store takes it.
    expect(root).toBe(join(tmp, "brain-store"));
    const path = dreamTriggerRecordPath(root);
    expect(path).toBe(
      join(
        process.env["XDG_STATE_HOME"]!,
        "open-second-brain",
        "dream-trigger",
        `${dreamTriggerKey(root)}.json`,
      ),
    );
    expect(dreamTriggerKey(root)).toMatch(/^[0-9a-f]{16}$/);
    expect(dreamTriggerKey(join(tmp, "other"))).not.toBe(dreamTriggerKey(root));
  });

  test("the store root variable wins over the config, as it does for the store", () => {
    const config = { path: join(tmp, "config.yaml"), exists: true, data: { store_root: "x" } };
    expect(configuredTriggerStoreRoot(config, { [STORE_ROOT_ENV]: join(tmp, "env-root") })).toBe(
      join(tmp, "env-root"),
    );
  });
});

describe("reading and writing", () => {
  test("a missing record is unknown", () => {
    expect(readDreamTriggerRecord(join(tmp, "none.json"), "/r")).toBeNull();
  });

  test("a corrupt record, or one of another store root, is unknown", () => {
    const path = join(tmp, "r.json");
    writeFileSync(path, "{ not json");
    expect(readDreamTriggerRecord(path, "/r")).toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, store_root: "/r", closed: "yes" }));
    expect(readDreamTriggerRecord(path, "/r")).toBeNull();
    writeDreamTriggerRecord(path, emptyDreamTriggerRecord("/other"));
    expect(readDreamTriggerRecord(path, "/r")).toBeNull();
  });

  test("a day that is not a real UTC calendar day makes the record unknown", () => {
    const path = join(tmp, "r.json");
    for (const day of ["not-a-date", "2026-02-30", "2026-11-20T00:00:00Z", "20261120", 20261120]) {
      writeFileSync(path, JSON.stringify({ ...emptyDreamTriggerRecord("/r"), closed: true, day }));
      expect(readDreamTriggerRecord(path, "/r")).toBeNull();
    }
    // A real day ahead of the clock is kept: it still counts as closed.
    const ahead = { ...emptyDreamTriggerRecord("/r"), closed: true, day: "2099-01-01" };
    writeDreamTriggerRecord(path, ahead);
    expect(readDreamTriggerRecord(path, "/r")).toEqual(ahead);
    expect(dreamDayRecordWaits(ahead, Date.parse("2026-11-20T09:00:00Z"))).toBe(true);
  });

  test("a write is atomic: it leaves the record and no temporary file", () => {
    const path = join(tmp, "deep", "r.json");
    mkdirSync(dirname(path), { recursive: true });
    const record = { ...emptyDreamTriggerRecord("/r"), day: "2026-11-20", closed: true };
    writeDreamTriggerRecord(path, record);
    expect(readDreamTriggerRecord(path, "/r")).toEqual(record);
    expect(readdirSync(dirname(path))).toEqual(["r.json"]);
  });

  test("an update reads the record under its lock and carries what it does not change", () => {
    const path = join(tmp, "r.json");
    writeDreamTriggerRecord(path, { ...emptyDreamTriggerRecord("/r"), failures: 2 });
    const written = updateDreamTriggerRecord(path, "/r", (r) => ({
      ...r,
      failures: r.failures + 1,
    }));
    expect(written?.failures).toBe(3);
    expect(readDreamTriggerRecord(path, "/r")?.failures).toBe(3);
    expect(updateDreamTriggerRecord(path, "/r", () => null)).toBeNull();
    expect(readDreamTriggerRecord(path, "/r")?.failures).toBe(3);
  });

  test("an update of an unknown record starts from an empty one", () => {
    const path = join(tmp, "r.json");
    writeFileSync(path, "garbage");
    const written = updateDreamTriggerRecord(path, "/r", (r) => ({ ...r, day: "2026-11-20" }));
    expect(written).toEqual({ ...emptyDreamTriggerRecord("/r"), day: "2026-11-20" });
  });
});

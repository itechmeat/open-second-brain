import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backlinkCount,
  buildBacklinkIndex,
} from "../../src/core/brain/backlinks.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { writePreference, moveToRetired } from "../../src/core/brain/preference.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { appendApplyEvidence } from "../../src/core/brain/apply-evidence.ts";
import { preferencePath } from "../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-backlinks-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-backlinks-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("buildBacklinkIndex — empty Brain", () => {
  test("returns an empty index", () => {
    const idx = buildBacklinkIndex(vault);
    expect(idx.size).toBe(0);
    expect(backlinkCount(idx, "pref-foo")).toBe(0);
  });
});

describe("buildBacklinkIndex — preference evidenced_by", () => {
  test("indexes signal refs from evidenced_by[]", () => {
    writeSignal(vault, {
      topic: "rule",
      signal: "negative",
      agent: "claude",
      principle: "test",
      created_at: "2026-05-14T10:00:00Z",
      date: "2026-05-14",
      slug: "alpha",
    });
    writePreference(vault, {
      slug: "rule",
      topic: "rule",
      principle: "test",
      created_at: "2026-05-14T11:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-14-alpha]]"],
    });

    const idx = buildBacklinkIndex(vault);
    expect(backlinkCount(idx, "sig-2026-05-14-alpha")).toBe(1);
    const refs = idx.get("sig-2026-05-14-alpha")!;
    expect(refs[0]!.source).toBe("pref-rule");
    expect(refs[0]!.sourceKind).toBe("preference");
    expect(refs[0]!.field).toBe("evidenced_by");
  });
});

describe("buildBacklinkIndex — retired bookkeeping", () => {
  test("indexes superseded_by / retired_by on retired entries", () => {
    writePreference(vault, {
      slug: "old",
      topic: "old",
      principle: "old",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-15T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-02T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
    });
    writePreference(vault, {
      slug: "new",
      topic: "old",
      principle: "new",
      created_at: "2026-05-10T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-05-11T00:00:00Z",
      evidenced_by: [],
      applied_count: 1,
    });
    moveToRetired(vault, preferencePath(vault, "old"), "rebutted", {
      now: new Date("2026-05-12T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-12]]",
      superseded_by: "[[pref-new]]",
    });

    const idx = buildBacklinkIndex(vault);
    // ret-old references pref-new via superseded_by
    expect(backlinkCount(idx, "pref-new")).toBeGreaterThanOrEqual(1);
    const refs = idx.get("pref-new")!;
    const supersededRef = refs.find((r) => r.field === "superseded_by");
    expect(supersededRef).toBeDefined();
    expect(supersededRef!.source).toBe("ret-old");
    expect(supersededRef!.sourceKind).toBe("retired");
  });
});

describe("buildBacklinkIndex — log apply-evidence entries", () => {
  test("indexes preference references from log payloads", () => {
    writePreference(vault, {
      slug: "logged",
      topic: "logged",
      principle: "rule",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    appendApplyEvidence(
      vault,
      { pref_id: "logged", artifact: "[[some-file]]", result: "applied", agent: "claude" },
      { now: new Date("2026-05-05T10:00:00Z") },
    );

    const idx = buildBacklinkIndex(vault);
    expect(backlinkCount(idx, "pref-logged")).toBeGreaterThanOrEqual(1);
    const refs = idx.get("pref-logged")!;
    const logRef = refs.find((r) => r.sourceKind === "log-apply-evidence");
    expect(logRef).toBeDefined();
    expect(logRef!.source).toMatch(/^log-\d{4}-\d{2}-\d{2}$/);
    expect(logRef!.timestamp).toBe("2026-05-05T10:00:00Z");
  });
});

describe("buildBacklinkIndex — self-reference skip", () => {
  test("does not record a pref as a backlink to itself", () => {
    writePreference(vault, {
      slug: "self",
      topic: "self",
      principle: "rule referencing [[pref-self]] in body",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: [],
    });
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("pref-self") ?? [];
    expect(refs.find((r) => r.source === "pref-self")).toBeUndefined();
  });
});

describe("buildBacklinkIndex — frozen result", () => {
  test("returned arrays are frozen", () => {
    writePreference(vault, {
      slug: "frozen",
      topic: "frozen",
      principle: "test",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-30T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-2026-05-01-x]]"],
    });
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("sig-2026-05-01-x");
    expect(refs).toBeDefined();
    expect(() => (refs as Array<unknown>).push({} as never)).toThrow();
  });
});

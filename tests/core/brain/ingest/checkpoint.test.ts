import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkpointPath,
  checkpointingEnabled,
  clearCheckpoint,
  computePlanId,
  readCheckpoint,
  recordCompleted,
} from "../../../../src/core/brain/ingest/checkpoint.ts";

function setupVault(): string {
  return mkdtempSync(join(tmpdir(), "o2b-ckpt-"));
}

const AT = new Date("2026-07-10T08:00:00Z");

afterEach(() => {
  delete process.env["OSB_INGEST_NO_CHECKPOINT"];
});

describe("computePlanId", () => {
  test("is stable regardless of discovered-path order", () => {
    const a = computePlanId("docs", ["docs/b.md", "docs/a.md"]);
    const b = computePlanId("docs", ["docs/a.md", "docs/b.md"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  test("differs when the source dir or the path set differs", () => {
    const base = computePlanId("docs", ["docs/a.md"]);
    expect(computePlanId("notes", ["docs/a.md"])).not.toBe(base);
    expect(computePlanId("docs", ["docs/a.md", "docs/b.md"])).not.toBe(base);
  });
});

describe("recordCompleted / readCheckpoint", () => {
  test("unions items across calls and reports them sorted", () => {
    const vault = setupVault();
    try {
      const planId = computePlanId("docs", ["docs/a.md", "docs/b.md", "docs/c.md"]);
      recordCompleted(vault, planId, "docs", ["docs/b.md"], AT);
      recordCompleted(vault, planId, "docs", ["docs/a.md"], AT);
      const cp = readCheckpoint(vault, planId);
      expect(cp).not.toBeNull();
      expect(cp!.completed).toEqual(["docs/a.md", "docs/b.md"]);
      expect(cp!.plan_id).toBe(planId);
      expect(cp!.source_dir).toBe("docs");
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("re-recording the same set is a byte-identity no-op", () => {
    const vault = setupVault();
    try {
      const planId = computePlanId("docs", ["docs/a.md"]);
      expect(recordCompleted(vault, planId, "docs", ["docs/a.md"], AT)).toBe(true);
      const before = readFileSync(checkpointPath(vault, planId), "utf8");
      const later = new Date("2026-07-10T09:00:00Z");
      expect(recordCompleted(vault, planId, "docs", ["docs/a.md"], later)).toBe(false);
      const after = readFileSync(checkpointPath(vault, planId), "utf8");
      expect(after).toBe(before);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("a corrupt checkpoint throws rather than silently resetting", () => {
    const vault = setupVault();
    try {
      const planId = computePlanId("docs", ["docs/a.md"]);
      const path = checkpointPath(vault, planId);
      recordCompleted(vault, planId, "docs", ["docs/a.md"], AT);
      writeFileSync(path, "{ not json", "utf8");
      expect(() => readCheckpoint(vault, planId)).toThrow(/corrupt/i);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("an unknown schema_version throws", () => {
    const vault = setupVault();
    try {
      const planId = computePlanId("docs", ["docs/a.md"]);
      const path = checkpointPath(vault, planId);
      recordCompleted(vault, planId, "docs", ["docs/a.md"], AT);
      writeFileSync(path, JSON.stringify({ schema_version: 99, completed: [] }), "utf8");
      expect(() => readCheckpoint(vault, planId)).toThrow(/schema_version/);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("rejects a plan id that could escape the checkpoint dir", () => {
    const vault = setupVault();
    try {
      expect(() => readCheckpoint(vault, "../../etc/passwd")).toThrow(/plan id/i);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("clearCheckpoint", () => {
  test("removes the checkpoint file and reports whether it existed", () => {
    const vault = setupVault();
    try {
      const planId = computePlanId("docs", ["docs/a.md"]);
      recordCompleted(vault, planId, "docs", ["docs/a.md"], AT);
      expect(existsSync(checkpointPath(vault, planId))).toBe(true);
      expect(clearCheckpoint(vault, planId)).toBe(true);
      expect(existsSync(checkpointPath(vault, planId))).toBe(false);
      expect(clearCheckpoint(vault, planId)).toBe(false);
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });
});

describe("OSB_INGEST_NO_CHECKPOINT opt-out", () => {
  test("makes record/read inert", () => {
    const vault = setupVault();
    try {
      process.env["OSB_INGEST_NO_CHECKPOINT"] = "1";
      expect(checkpointingEnabled()).toBe(false);
      const planId = computePlanId("docs", ["docs/a.md"]);
      expect(recordCompleted(vault, planId, "docs", ["docs/a.md"], AT)).toBe(false);
      expect(existsSync(checkpointPath(vault, planId))).toBe(false);
      expect(readCheckpoint(vault, planId)).toBeNull();
    } finally {
      rmSync(vault, { recursive: true, force: true });
    }
  });

  test("treats empty/0/false as still-enabled", () => {
    process.env["OSB_INGEST_NO_CHECKPOINT"] = "0";
    expect(checkpointingEnabled()).toBe(true);
    process.env["OSB_INGEST_NO_CHECKPOINT"] = "false";
    expect(checkpointingEnabled()).toBe(true);
    process.env["OSB_INGEST_NO_CHECKPOINT"] = "";
    expect(checkpointingEnabled()).toBe(true);
  });
});

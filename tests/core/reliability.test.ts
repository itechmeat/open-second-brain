import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendAuditRecord } from "../../src/core/reliability/audit.ts";
import { atomicWriteText } from "../../src/core/reliability/atomic.ts";
import { withFileLock } from "../../src/core/reliability/lock.ts";
import { buildProbeReport } from "../../src/core/reliability/probe.ts";

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `o2b-reliability-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("atomicWriteText", () => {
  test("preserves old content when validation rejects the candidate", () => {
    const target = join(tmp, "state.yaml");
    writeFileSync(target, "schema_version: 1\n", "utf8");

    expect(() =>
      atomicWriteText(target, "broken: true\n", {
        validate: () => {
          throw new Error("candidate failed lint");
        },
      }),
    ).toThrow("candidate failed lint");

    expect(readFileSync(target, "utf8")).toBe("schema_version: 1\n");
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  test("writes the candidate atomically after validation passes", () => {
    const target = join(tmp, "Brain", "_brain.yaml");

    atomicWriteText(target, "schema_version: 1\nschema:\n", {
      validate: (candidate) => expect(candidate).toContain("schema_version"),
    });

    expect(readFileSync(target, "utf8")).toBe("schema_version: 1\nschema:\n");
  });
});

describe("withFileLock", () => {
  test("serializes access to a lock target and releases after callback", async () => {
    const target = join(tmp, "Brain", "_brain.yaml");
    mkdirSync(join(tmp, "Brain"), { recursive: true });
    writeFileSync(target, "schema_version: 1\n", "utf8");
    const events: string[] = [];

    await withFileLock(target, { staleMs: 1_000, retries: 0 }, async () => {
      events.push("first");
    });
    await withFileLock(target, { staleMs: 1_000, retries: 0 }, async () => {
      events.push("second");
    });

    expect(events).toEqual(["first", "second"]);
  });
});

describe("appendAuditRecord", () => {
  test("appends redacted ISO-week JSONL audit records", () => {
    const auditRoot = join(tmp, "Brain", "log", "schema-mutations");
    const path = appendAuditRecord(auditRoot, {
      timestamp: "2026-05-30T12:00:00.000Z",
      actor: "tester",
      action: "schema_apply_mutations",
      target: "Brain/_brain.yaml",
      ok: true,
      details: { token: "research", api_key: "secret-value" },
    });

    expect(path.endsWith("2026-W22.jsonl")).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("schema_apply_mutations");
    expect(lines[0]).toContain("***REDACTED***");
    expect(lines[0]).not.toContain("secret-value");
  });
});

describe("buildProbeReport", () => {
  test("summarizes probe checks with stable severity counts", () => {
    const report = buildProbeReport([
      { name: "brain_root", status: "ok", message: "present" },
      {
        name: "search_index",
        status: "warning",
        message: "missing",
        remediation: "run o2b search index",
      },
      {
        name: "snapshot_restore",
        status: "critical",
        message: "drift detected",
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.counts).toEqual({ ok: 1, warning: 1, critical: 1 });
    expect(report.checks.map((check) => check.name)).toEqual([
      "brain_root",
      "search_index",
      "snapshot_restore",
    ]);
  });
});

/**
 * Per-preference mutation audit log (Brain lifecycle suite, Feature 1).
 *
 * An append-only JSONL trail under `Brain/log/pref-audit/<pref-id>.jsonl`
 * captures every mutation to a preference (create / update / promote /
 * retire / merge) with the agent, reason, and revision + content-hash
 * before/after. The trail is authoritative because it is written at the
 * mutation chokepoints, and it stays a true no-op when a write does not
 * actually change the preference content (hash_before === hash_after).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendPrefAudit,
  readPrefAudit,
  renderPrefAuditLine,
} from "../../../src/core/brain/pref-audit.ts";
import { prefAuditPath } from "../../../src/core/brain/paths.ts";
import { PREF_AUDIT_OP } from "../../../src/core/brain/types.ts";

let vault: string;
const now = new Date("2026-05-29T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-audit-"));
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("PREF_AUDIT_OP", () => {
  test("exposes the five canonical op strings", () => {
    expect(PREF_AUDIT_OP.create).toBe("create");
    expect(PREF_AUDIT_OP.update).toBe("update");
    expect(PREF_AUDIT_OP.promote).toBe("promote");
    expect(PREF_AUDIT_OP.retire).toBe("retire");
    expect(PREF_AUDIT_OP.merge).toBe("merge");
  });
});

describe("renderPrefAuditLine", () => {
  test("emits one canonical JSON object with a trailing newline", () => {
    const line = renderPrefAuditLine({
      ts: "2026-05-29T12:00:00Z",
      pref_id: "pref-foo",
      op: PREF_AUDIT_OP.promote,
      agent: "dream",
      reason: "threshold met",
      revision_before: 1,
      revision_after: 2,
      hash_before: "aaa",
      hash_after: "bbb",
    });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["pref_id"]).toBe("pref-foo");
    expect(parsed["op"]).toBe("promote");
    expect(parsed["agent"]).toBe("dream");
    expect(parsed["revision_after"]).toBe(2);
  });
});

describe("appendPrefAudit", () => {
  test("appends a record on a real content change and returns true", () => {
    const wrote = appendPrefAudit(
      vault,
      {
        pref_id: "pref-foo",
        op: PREF_AUDIT_OP.create,
        agent: "dream",
        reason: "promoted from 2 signals",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "abc123",
      },
      { now },
    );
    expect(wrote).toBe(true);
    const path = prefAuditPath(vault, "pref-foo");
    expect(existsSync(path)).toBe(true);
    const { records, warnings } = readPrefAudit(vault, "pref-foo");
    expect(warnings).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.op).toBe("create");
    expect(records[0]!.ts).toBe("2026-05-29T12:00:00Z");
    expect(records[0]!.hash_after).toBe("abc123");
  });

  test("is a no-op when hash_before === hash_after (unchanged content)", () => {
    const wrote = appendPrefAudit(
      vault,
      {
        pref_id: "pref-foo",
        op: PREF_AUDIT_OP.update,
        agent: "dream",
        revision_before: 3,
        revision_after: 4,
        hash_before: "same",
        hash_after: "same",
      },
      { now },
    );
    expect(wrote).toBe(false);
    expect(existsSync(prefAuditPath(vault, "pref-foo"))).toBe(false);
  });

  test("accumulates records across calls in chronological order", () => {
    appendPrefAudit(
      vault,
      {
        pref_id: "pref-bar",
        op: PREF_AUDIT_OP.create,
        agent: "dream",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "h1",
      },
      { now: new Date("2026-05-29T12:00:00Z") },
    );
    appendPrefAudit(
      vault,
      {
        pref_id: "pref-bar",
        op: PREF_AUDIT_OP.retire,
        agent: "operator",
        reason: "rebutted",
        revision_before: 1,
        revision_after: 2,
        hash_before: "h1",
        hash_after: "h2",
      },
      { now: new Date("2026-05-30T09:00:00Z") },
    );
    const { records } = readPrefAudit(vault, "pref-bar");
    expect(records.map((r) => r.op)).toEqual(["create", "retire"]);
    expect(records[1]!.agent).toBe("operator");
  });
});

describe("readPrefAudit", () => {
  test("returns empty records (no warnings) for a preference with no audit file", () => {
    const { records, warnings } = readPrefAudit(vault, "pref-missing");
    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  test("tolerates an unknown op kind, keeping the raw string", () => {
    const path = prefAuditPath(vault, "pref-future");
    mkdirSync(join(vault, "Brain", "log", "pref-audit"), { recursive: true });
    appendFileSync(
      path,
      JSON.stringify({
        ts: "2026-05-29T12:00:00Z",
        pref_id: "pref-future",
        op: "quantum-entangle",
        agent: "dream",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "z",
      }) + "\n",
      "utf8",
    );
    const { records, warnings } = readPrefAudit(vault, "pref-future");
    expect(warnings).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.op).toBe("quantum-entangle");
  });

  test("surfaces a malformed JSONL line as a warning without aborting", () => {
    const path = prefAuditPath(vault, "pref-mixed");
    mkdirSync(join(vault, "Brain", "log", "pref-audit"), { recursive: true });
    appendFileSync(path, "{ not json\n", "utf8");
    appendFileSync(
      path,
      JSON.stringify({
        ts: "2026-05-29T12:00:00Z",
        pref_id: "pref-mixed",
        op: "create",
        agent: "dream",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "ok",
      }) + "\n",
      "utf8",
    );
    const { records, warnings } = readPrefAudit(vault, "pref-mixed");
    expect(records).toHaveLength(1);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});

/**
 * Per-device shards (who-wrote-what, Task B / t_1814b9bf). Two devices
 * promoting or editing the same preference must not append to one file,
 * and the audit trail a reader shows is the union of both.
 */
describe("preference audit per-device shards", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let configHome: string;

  beforeEach(() => {
    configHome = mkdtempSync(join(tmpdir(), "o2b-pref-audit-cfg-"));
    const configPath = join(configHome, "config.yaml");
    savedEnv["OPEN_SECOND_BRAIN_CONFIG"] = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    savedEnv["O2B_DEVICE_ID"] = process.env["O2B_DEVICE_ID"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    delete process.env["O2B_DEVICE_ID"];
    writeFileSync(configPath, `vault: ${vault}\ndevice_id: "testdev1"\n`, "utf8");
  });

  afterEach(() => {
    rmSync(configHome, { recursive: true, force: true });
    for (const key of ["OPEN_SECOND_BRAIN_CONFIG", "O2B_DEVICE_ID"]) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function line(ts: string, agent: string): string {
    return renderPrefAuditLine({
      ts,
      pref_id: "pref-shared",
      op: PREF_AUDIT_OP.update,
      agent,
      revision_before: 1,
      revision_after: 2,
      hash_before: "a",
      hash_after: "b",
    });
  }

  test("a device with an id writes its own shard and never the bare file", () => {
    appendPrefAudit(
      vault,
      {
        pref_id: "pref-shared",
        op: PREF_AUDIT_OP.create,
        agent: "dream",
        revision_before: null,
        revision_after: 1,
        hash_before: null,
        hash_after: "a",
      },
      { now },
    );
    expect(existsSync(prefAuditPath(vault, "pref-shared", "testdev1"))).toBe(true);
    expect(existsSync(prefAuditPath(vault, "pref-shared", ""))).toBe(false);
  });

  test("the reader merges the bare file and every device shard by timestamp", () => {
    const dir = join(vault, "Brain", "log", "pref-audit");
    mkdirSync(dir, { recursive: true });
    appendFileSync(prefAuditPath(vault, "pref-shared", ""), line("2026-05-29T12:00:00Z", "legacy"));
    appendFileSync(
      prefAuditPath(vault, "pref-shared", "devb"),
      line("2026-05-29T12:00:02Z", "otherdev"),
    );
    appendFileSync(
      prefAuditPath(vault, "pref-shared", "testdev1"),
      line("2026-05-29T12:00:01Z", "mine"),
    );
    expect(readPrefAudit(vault, "pref-shared").records.map((r) => r.agent)).toEqual([
      "legacy",
      "mine",
      "otherdev",
    ]);
  });

  test("a sync-conflict copy is not a shard and is never merged", () => {
    const dir = join(vault, "Brain", "log", "pref-audit");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      prefAuditPath(vault, "pref-shared", "testdev1"),
      line("2026-05-29T12:00:01Z", "mine"),
    );
    appendFileSync(
      join(dir, "pref-shared.sync-conflict-20260529-120000-ABCDEFG.jsonl"),
      line("2026-05-29T12:00:00Z", "conflict"),
    );
    expect(readPrefAudit(vault, "pref-shared").records.map((r) => r.agent)).toEqual(["mine"]);
  });

  test("one preference's shards never pick up another preference's file", () => {
    const dir = join(vault, "Brain", "log", "pref-audit");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      prefAuditPath(vault, "pref-shared", "testdev1"),
      line("2026-05-29T12:00:01Z", "mine"),
    );
    appendFileSync(
      prefAuditPath(vault, "pref-shared-extra", "testdev1"),
      line("2026-05-29T12:00:00Z", "other-pref"),
    );
    expect(readPrefAudit(vault, "pref-shared").records.map((r) => r.agent)).toEqual(["mine"]);
  });
});

/**
 * `o2b brain session-summary get` (trust-surface-hardening, t_59d4c919).
 * Claims pinned here:
 *
 *  1. `get --json` carries the digest plus the additive `digest_count`, and
 *     the divergence keys (`divergent`, `records`) only when more than one
 *     content-differing digest exists for the session.
 *  2. The divergence records are an id/created_at/content_hash list, never
 *     a payload echo.
 *  3. The CLI serializer now carries `project`, matching the MCP serializer
 *     (the verified drift).
 *  4. Text mode appends exactly one note line when the session diverges,
 *     and stays byte-identical when it does not.
 *  5. `found: false` is byte-identical to the pre-change envelope.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendSessionSummary } from "../../src/core/brain/session-summary.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let configPath: string;

function run(args: ReadonlyArray<string>) {
  return runCli(["brain", "session-summary", ...args, "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-session-summary-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("get --json carries the digest plus digest_count for a single record", async () => {
  const digest = appendSessionSummary(vault, {
    sessionId: "sess-one",
    request: "Add a structured session summary",
    decisions: ["Reuse the continuity store"],
    createdAt: "2026-06-14T10:00:00.000Z",
  });
  const r = await run(["get", "--session", "sess-one", "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    found: boolean;
    digest: Record<string, unknown>;
    digest_count: number;
  };
  expect(payload.found).toBe(true);
  expect(payload.digest.id).toBe(digest.id);
  expect(payload.digest.session_id).toBe("sess-one");
  expect(payload.digest.request).toBe("Add a structured session summary");
  expect(payload.digest_count).toBe(1);
  expect("divergent" in payload).toBe(false);
  expect("records" in payload).toBe(false);
});

test("get --json after two differing writes carries the divergence keys and the latest digest", async () => {
  appendSessionSummary(vault, {
    sessionId: "sess-div",
    decisions: ["older decision"],
    createdAt: "2026-06-14T09:00:00.000Z",
  });
  const newer = appendSessionSummary(vault, {
    sessionId: "sess-div",
    decisions: ["newer decision"],
    createdAt: "2026-06-14T11:00:00.000Z",
  });
  const r = await run(["get", "--session", "sess-div", "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as {
    found: boolean;
    digest: Record<string, unknown>;
    digest_count: number;
    divergent?: boolean;
    records?: Array<Record<string, unknown>>;
  };
  expect(payload.found).toBe(true);
  expect(payload.digest.id).toBe(newer.id);
  expect(payload.digest_count).toBe(2);
  expect(payload.divergent).toBe(true);
  // The additive key set is frozen: no key may appear or disappear from the
  // divergent envelope silently (the single-record envelope carries exactly
  // found/digest/digest_count; divergence adds exactly these two).
  expect(Object.keys(payload).toSorted()).toEqual([
    "digest",
    "digest_count",
    "divergent",
    "found",
    "records",
  ]);
  expect(payload.records?.length).toBe(2);
  for (const record of payload.records ?? []) {
    expect(typeof record["id"]).toBe("string");
    expect(typeof record["created_at"]).toBe("string");
    expect(typeof record["content_hash"]).toBe("string");
  }
  // id/hash lists, never a payload echo.
  expect(JSON.stringify(payload.records)).not.toContain("newer decision");
});

test("get --json serializes project, matching the MCP serializer", async () => {
  appendSessionSummary(vault, {
    sessionId: "sess-proj",
    project: "alpha",
    decisions: ["scoped"],
    createdAt: "2026-06-14T10:00:00.000Z",
  });
  const r = await run(["get", "--session", "sess-proj", "--json"]);
  expect(r.returncode).toBe(0);
  const payload = JSON.parse(r.stdout) as { digest: Record<string, unknown> };
  expect(payload.digest["project"]).toBe("alpha");
});

test("text mode get appends exactly one note line when the session diverges", async () => {
  appendSessionSummary(vault, {
    sessionId: "sess-text",
    decisions: ["older decision"],
    createdAt: "2026-06-14T09:00:00.000Z",
  });
  appendSessionSummary(vault, {
    sessionId: "sess-text",
    decisions: ["newer decision"],
    createdAt: "2026-06-14T11:00:00.000Z",
  });
  const r = await run(["get", "--session", "sess-text"]);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("session sess-text");
  expect(r.stdout).toContain("newer decision");
  const noteLines = r.stdout.split("\n").filter((line) => line.includes("divergent=true"));
  expect(noteLines.length).toBe(1);
  expect(noteLines[0]).toContain("digest_count=2");
});

test("text mode get for a single record stays free of a divergence note", async () => {
  appendSessionSummary(vault, {
    sessionId: "sess-plain",
    decisions: ["one decision"],
    createdAt: "2026-06-14T10:00:00.000Z",
  });
  const r = await run(["get", "--session", "sess-plain"]);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("one decision");
  expect(r.stdout).not.toContain("divergent");
});

test("get for an unknown session --json prints exactly the found:false envelope", async () => {
  const r = await run(["get", "--session", "missing", "--json"]);
  expect(r.returncode).toBe(0);
  expect(r.stdout).toBe(`${JSON.stringify({ found: false }, null, 2)}\n`);
});

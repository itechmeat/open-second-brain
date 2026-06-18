/**
 * Write-session engine: lifecycle, correction loop, collision guard,
 * review gate, audit (Agent Write Contract Suite, t_bc36a8a2).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WriteSessionRequestError,
  abandonSession,
  approveSession,
  openArtifactSession,
  sessionEnvelope,
  submitToSession,
} from "../../../../src/core/brain/write-session/engine.ts";
import { readWriteSession } from "../../../../src/core/brain/write-session/store.ts";
import { parseLogDay } from "../../../../src/core/brain/log.ts";

let tmp: string;
let vault: string;

const NOW = "2026-06-04T10:00:00.000Z";
const DATE = "2026-06-04";

const GOOD = ["---", "kind: note", "---", "", "# Decision record", "", "We adopt it."].join("\n");

function open(over: Record<string, unknown> = {}) {
  return openArtifactSession(vault, {
    agent: "fixture-agent",
    targetPath: "Brain/notes/adr.md",
    now: NOW,
    ...over,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ws-engine-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("open returns a needs-llm-step envelope with prompt, hints, and ttl", () => {
  const env = open({ schemaType: "note" });
  expect(env.status).toBe("needs-llm-step");
  expect(env.kind).toBe("artifact");
  expect(env.step).toBe("artifact");
  expect(env.session_id).toMatch(/^ws-/);
  expect(env.prompt).toContain("Brain/notes/adr.md");
  expect(env.schema_hints.some((h) => h.includes("type: note"))).toBe(true);
  expect(env.attempts_left).toBe(3);
  expect(Date.parse(env.expires_at) - Date.parse(NOW)).toBe(24 * 3600 * 1000);
  expect(env.existing).toBeNull();
});

test("open rejects an invalid target with structured errors", () => {
  try {
    open({ targetPath: "Brain/preferences/pref-x.md" });
    throw new Error("expected WriteSessionRequestError");
  } catch (exc) {
    expect(exc).toBeInstanceOf(WriteSessionRequestError);
    const errors = (exc as WriteSessionRequestError).errors;
    expect(errors.map((e) => e.code)).toContain("target-reserved");
  }
});

test("open against an occupied target attaches existing metadata", () => {
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "notes", "adr.md"), "---\nkind: note\n---\n\n# Old\n");
  const env = open();
  expect(env.existing).not.toBeNull();
  expect(env.existing!.first_heading).toBe("Old");
});

test("invalid submit returns needs-correction, preserves state, decrements attempts", () => {
  const opened = open();
  const env = submitToSession(vault, {
    sessionId: opened.session_id,
    artifact: "# no frontmatter",
    now: NOW,
  });
  expect(env.status).toBe("needs-correction");
  expect(env.errors.map((e) => e.code)).toContain("frontmatter-missing");
  expect(env.prompt).toContain("resubmit the full corrected artifact");
  expect(env.attempts_left).toBe(2);
  expect(env.target_path).toBe("Brain/notes/adr.md");
});

test("retry cap exhaustion is terminal failed with an audit event", () => {
  const opened = open({ retryCap: 2 });
  submitToSession(vault, { sessionId: opened.session_id, artifact: "bad", now: NOW });
  const env = submitToSession(vault, { sessionId: opened.session_id, artifact: "bad", now: NOW });
  expect(env.status).toBe("failed");
  expect(env.attempts_left).toBe(0);
  const probe = readWriteSession(vault, opened.session_id, NOW);
  expect(probe.session!.failReason).toBe("retry-cap");
  const { entries } = parseLogDay(vault, DATE);
  const audit = entries.filter((e) => e.eventType === "write-session");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["status"]).toBe("failed");
});

test("valid submit commits atomically and is terminal done", () => {
  const opened = open();
  const env = submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW });
  expect(env.status).toBe("done");
  const committed = readFileSync(join(vault, "Brain", "notes", "adr.md"), "utf8");
  expect(committed).toContain("# Decision record");
  expect(committed.endsWith("\n")).toBe(true);
  const { entries } = parseLogDay(vault, DATE);
  const audit = entries.filter((e) => e.eventType === "write-session");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["status"]).toBe("done");
  expect(audit[0]!.body["target"]).toBe("Brain/notes/adr.md");
  // terminal: a second submit is rejected
  expect(() =>
    submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW }),
  ).toThrow(/terminal/);
});

test("create intent never overwrites an existing target", () => {
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "notes", "adr.md"), "PRECIOUS\n");
  const opened = open();
  const env = submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW });
  expect(env.status).toBe("needs-correction");
  expect(env.errors.map((e) => e.code)).toContain("target-exists");
  expect(readFileSync(join(vault, "Brain", "notes", "adr.md"), "utf8")).toBe("PRECIOUS\n");
});

test("overwrite intent replaces; merge intent appends a delimited section", () => {
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
  writeFileSync(join(vault, "Brain", "notes", "adr.md"), "---\nkind: note\n---\n\n# Old\n");

  const over = open({ intent: "overwrite" });
  expect(
    submitToSession(vault, { sessionId: over.session_id, artifact: GOOD, now: NOW }).status,
  ).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "adr.md"), "utf8")).not.toContain("# Old");

  writeFileSync(join(vault, "Brain", "notes", "adr.md"), "---\nkind: note\n---\n\n# Old\n");
  const merge = open({ intent: "merge" });
  expect(
    submitToSession(vault, { sessionId: merge.session_id, artifact: GOOD, now: NOW }).status,
  ).toBe("done");
  const merged = readFileSync(join(vault, "Brain", "notes", "adr.md"), "utf8");
  expect(merged).toContain("# Old");
  expect(merged).toContain("# Decision record");
  expect(merged.indexOf("# Old")).toBeLessThan(merged.indexOf("# Decision record"));
  expect(merged).toContain(merge.session_id);
});

test("require_review stops at needs-review; approve commits", () => {
  const opened = open({ requireReview: true });
  const env = submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW });
  expect(env.status).toBe("needs-review");
  expect(existsSync(join(vault, "Brain", "notes", "adr.md"))).toBe(false);

  const approved = approveSession(vault, { sessionId: opened.session_id, now: NOW });
  expect(approved.status).toBe("done");
  expect(readFileSync(join(vault, "Brain", "notes", "adr.md"), "utf8")).toContain(
    "# Decision record",
  );
  const { entries } = parseLogDay(vault, DATE);
  const audit = entries.filter((e) => e.eventType === "write-session");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["review"]).toBe("required");
});

test("approve outside needs-review is a structured error", () => {
  const opened = open();
  expect(() => approveSession(vault, { sessionId: opened.session_id, now: NOW })).toThrow(
    WriteSessionRequestError,
  );
});

test("abandon is terminal failed/abandoned with audit", () => {
  const opened = open();
  const env = abandonSession(vault, { sessionId: opened.session_id, now: NOW });
  expect(env.status).toBe("failed");
  const probe = readWriteSession(vault, opened.session_id, NOW);
  expect(probe.session!.failReason).toBe("abandoned");
  const { entries } = parseLogDay(vault, DATE);
  expect(entries.filter((e) => e.eventType === "write-session")).toHaveLength(1);
});

test("an expired session is audited exactly once across repeated ops", () => {
  const opened = open({ ttlMs: 1000 });
  const LATER = "2026-06-04T11:00:00Z";
  for (let i = 0; i < 3; i++) {
    expect(() =>
      submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: LATER }),
    ).toThrow(/terminal/);
  }
  const { entries } = parseLogDay(vault, DATE);
  const audit = entries.filter((e) => e.eventType === "write-session");
  expect(audit).toHaveLength(1);
  expect(audit[0]!.body["reason"]).toBe("expired");
});

test("an expired session refuses submits with a terminal error", () => {
  const opened = open({ ttlMs: 1000 });
  expect(() =>
    submitToSession(vault, {
      sessionId: opened.session_id,
      artifact: GOOD,
      now: "2026-06-04T11:00:00Z",
    }),
  ).toThrow(/expired|terminal/);
});

test("sessionEnvelope reflects current state for status queries", () => {
  const opened = open();
  submitToSession(vault, { sessionId: opened.session_id, artifact: "bad", now: NOW });
  const probe = readWriteSession(vault, opened.session_id, NOW);
  const env = sessionEnvelope(probe.session!);
  expect(env.status).toBe("needs-correction");
  expect(env.attempts_left).toBe(2);
  expect(env.session_id).toBe(opened.session_id);
});

test("unknown session id is a structured error", () => {
  expect(() =>
    submitToSession(vault, { sessionId: "ws-20990101-000000", artifact: GOOD, now: NOW }),
  ).toThrow(WriteSessionRequestError);
});

test("commit refuses a target whose Brain ancestor is a symlink out of the vault", () => {
  // `validateTargetPath` runs at open time and is purely lexical: a
  // path like `Brain/escape/adr.md` is clean, so the session opens.
  // Only the write chokepoint can see that `Brain/escape` is a symlink
  // pointing outside the vault. The containment guard must reject the
  // commit before any mkdir/write lands the file on the symlink target.
  const outside = join(tmp, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(vault, "Brain", "escape"), "dir");

  const opened = open({ targetPath: "Brain/escape/adr.md" });
  expect(() =>
    submitToSession(vault, { sessionId: opened.session_id, artifact: GOOD, now: NOW }),
  ).toThrow(/escapes vault/);

  // Fail-closed: nothing was written through the symlink.
  expect(existsSync(join(outside, "adr.md"))).toBe(false);
});

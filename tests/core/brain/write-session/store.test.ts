/**
 * Write-session store (Agent Write Contract Suite, t_bc36a8a2).
 *
 * One JSON file per session under `Brain/.sessions/write/`, snake_case
 * on disk, lazy TTL on read, sweep for terminal/expired files.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocateWriteSessionId,
  createWriteSession,
  deleteWriteSession,
  isWriteSessionId,
  listWriteSessions,
  readWriteSession,
  saveWriteSession,
  sweepWriteSessions,
  writeSessionDir,
  writeSessionPath,
} from "../../../../src/core/brain/write-session/store.ts";
import type { WriteSessionRecord } from "../../../../src/core/brain/write-session/types.ts";

let tmp: string;
let vault: string;

const NOW = "2026-06-04T10:00:00Z";
const LATER = "2026-06-05T11:00:00Z";

function record(id: string, over: Partial<WriteSessionRecord> = {}): WriteSessionRecord {
  return {
    id,
    kind: "artifact",
    status: "needs-llm-step",
    step: "artifact",
    agent: "fixture-agent",
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: "2026-06-05T10:00:00Z",
    attempts: 0,
    retryCap: 3,
    targetPath: "Brain/notes/fixture.md",
    intent: "create",
    requireReview: false,
    prompt: "Write the fixture note.",
    schemaType: null,
    topic: null,
    personas: [],
    responses: {},
    pendingArtifact: null,
    lastErrors: [],
    failReason: null,
    ...over,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-ws-store-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("writeSessionDir nests under Brain/.sessions/write", () => {
  expect(writeSessionDir(vault)).toBe(join(vault, "Brain", ".sessions", "write"));
});

test("session id grammar accepts allocated ids and rejects traversal shapes", () => {
  const id = allocateWriteSessionId(vault, NOW);
  expect(isWriteSessionId(id)).toBe(true);
  expect(id.startsWith("ws-")).toBe(true);
  expect(isWriteSessionId("../../etc/passwd")).toBe(false);
  expect(isWriteSessionId("ws-UPPER")).toBe(false);
  expect(isWriteSessionId("")).toBe(false);
  expect(() => writeSessionPath(vault, "../escape")).toThrow(/session id/);
});

test("createWriteSession claims ids exclusively - same-second creates never collide", () => {
  const a = createWriteSession(vault, NOW, (id) => record(id));
  const b = createWriteSession(vault, NOW, (id) => record(id));
  expect(a.id).not.toBe(b.id);
  expect(readWriteSession(vault, a.id, NOW).session).not.toBeNull();
  expect(readWriteSession(vault, b.id, NOW).session).not.toBeNull();
});

test("a structurally incomplete record reads as an error probe (fail closed)", () => {
  const id = allocateWriteSessionId(vault, NOW);
  mkdirSync(writeSessionDir(vault), { recursive: true });
  writeFileSync(
    writeSessionPath(vault, id),
    JSON.stringify({ id, kind: "artifact", status: "needs-llm-step" }),
  );
  const probe = readWriteSession(vault, id, NOW);
  expect(probe.session).toBeNull();
  expect(probe.error).toMatch(/malformed/);
});

test("sweep removes *.json files whose names violate the id grammar", () => {
  mkdirSync(writeSessionDir(vault), { recursive: true });
  writeFileSync(join(writeSessionDir(vault), "GARBAGE.json"), "{}");
  const swept = sweepWriteSessions(vault, NOW);
  expect(swept.removed).toBe(1);
  expect(existsSync(join(writeSessionDir(vault), "GARBAGE.json"))).toBe(false);
});

test("allocateWriteSessionId never collides with an existing session file", () => {
  const first = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(first));
  const second = allocateWriteSessionId(vault, NOW);
  expect(second).not.toBe(first);
  expect(isWriteSessionId(second)).toBe(true);
});

test("save + read round-trips a record with snake_case on disk", () => {
  const id = allocateWriteSessionId(vault, NOW);
  saveWriteSession(
    vault,
    record(id, {
      kind: "panel",
      step: "persona:technical",
      topic: "adopt bun",
      personas: [{ slug: "technical", lens: "technical feasibility", prompt: "Assess it." }],
      responses: { "persona:technical": "fine" },
      lastErrors: [{ code: "frontmatter-missing", path: "frontmatter", message: "absent" }],
    }),
  );
  const raw = JSON.parse(readFileSync(writeSessionPath(vault, id), "utf8"));
  expect(raw["created_at"]).toBe(NOW);
  expect(raw["retry_cap"]).toBe(3);
  expect(raw["target_path"]).toBe("Brain/notes/fixture.md");
  expect(raw["require_review"]).toBe(false);
  expect(raw["last_errors"][0]["code"]).toBe("frontmatter-missing");

  const probe = readWriteSession(vault, id, NOW);
  expect(probe.error).toBeNull();
  expect(probe.session!.kind).toBe("panel");
  expect(probe.session!.step).toBe("persona:technical");
  expect(probe.session!.personas[0]!.lens).toBe("technical feasibility");
  expect(probe.session!.responses["persona:technical"]).toBe("fine");
});

test("missing session reads as a null probe without error", () => {
  const probe = readWriteSession(vault, "ws-2026-06-04-missing", NOW);
  expect(probe.session).toBeNull();
  expect(probe.error).toBeNull();
});

test("corrupted session file reads as an error probe, never throws", () => {
  const id = allocateWriteSessionId(vault, NOW);
  mkdirSync(writeSessionDir(vault), { recursive: true });
  writeFileSync(writeSessionPath(vault, id), "{broken");
  const probe = readWriteSession(vault, id, NOW);
  expect(probe.session).toBeNull();
  expect(probe.error).toMatch(/not valid JSON/);
});

test("lazy TTL: an expired non-terminal session reads as failed/expired", () => {
  const id = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(id, { status: "needs-correction" }));
  const fresh = readWriteSession(vault, id, NOW);
  expect(fresh.session!.status).toBe("needs-correction");
  const expired = readWriteSession(vault, id, LATER);
  expect(expired.session!.status).toBe("failed");
  expect(expired.session!.failReason).toBe("expired");
});

test("lazy TTL leaves terminal sessions untouched", () => {
  const id = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(id, { status: "done" }));
  const probe = readWriteSession(vault, id, LATER);
  expect(probe.session!.status).toBe("done");
  expect(probe.session!.failReason).toBeNull();
});

test("listWriteSessions returns sessions sorted by created_at then id", () => {
  expect(listWriteSessions(vault, NOW)).toEqual([]);
  const a = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(a, { createdAt: "2026-06-04T09:00:00Z" }));
  const b = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(b, { createdAt: "2026-06-04T08:00:00Z" }));
  const sessions = listWriteSessions(vault, NOW);
  expect(sessions.map((s) => s.id)).toEqual([b, a]);
});

test("delete removes the file; sweep removes terminal and expired sessions", () => {
  const done = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(done, { status: "done" }));
  const expired = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(expired, { status: "needs-llm-step" }));
  const live = allocateWriteSessionId(vault, NOW);
  saveWriteSession(vault, record(live, { expiresAt: "2026-06-06T10:00:00Z" }));

  deleteWriteSession(vault, done);
  expect(existsSync(writeSessionPath(vault, done))).toBe(false);

  const swept = sweepWriteSessions(vault, LATER);
  expect(swept.removed).toBe(1);
  expect(swept.kept).toBe(1);
  expect(existsSync(writeSessionPath(vault, expired))).toBe(false);
  expect(existsSync(writeSessionPath(vault, live))).toBe(true);
});

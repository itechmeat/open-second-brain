import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildHandoffNote, writeHandoffNote } from "../../../src/core/brain/handoff.ts";
import type { SessionTurn } from "../../../src/core/brain/sessions/types.ts";

const NOW = new Date("2026-06-03T12:00:00Z");

function turn(
  role: SessionTurn["role"],
  text: string,
  toolCalls?: SessionTurn["toolCalls"],
): SessionTurn {
  return Object.freeze({
    turnId: `t-${role}-${text.slice(0, 8)}`,
    timestamp: "2026-06-03T11:00:00Z",
    role,
    text,
    ...(toolCalls ? { toolCalls } : {}),
  });
}

const TURNS: SessionTurn[] = [
  turn("user", "Please add a cost gate to the embedding indexer and document it."),
  turn(
    "assistant",
    "I implemented the cost gate and added tests. Note that the gate only fires when positive.\nNext step: wire the docs.",
    [
      { name: "Write", input: { file_path: "src/core/search/indexer.ts" } },
      { name: "Edit", input: { file_path: "docs/cli-reference.md" } },
    ],
  ),
  turn("assistant", "Done: docs updated. TODO: announce in the changelog later."),
];

test("buildHandoffNote extracts the five sections deterministically", () => {
  const note = buildHandoffNote(TURNS, { sessionId: "Sess 42", agent: "test-agent", now: NOW });
  expect(note).toContain("## Request");
  expect(note).toContain("add a cost gate");
  expect(note).toContain("## Completed work");
  expect(note).toContain("Done: docs updated");
  expect(note).toContain("## Files changed");
  expect(note).toContain("src/core/search/indexer.ts");
  expect(note).toContain("docs/cli-reference.md");
  expect(note).toContain("## Learned context");
  expect(note).toContain("gate only fires when positive");
  expect(note).toContain("## Next steps");
  expect(note).toContain("announce in the changelog");
  // Deterministic: same input, same note.
  expect(buildHandoffNote(TURNS, { sessionId: "Sess 42", agent: "test-agent", now: NOW })).toBe(
    note,
  );
});

test("empty sections render an explicit placeholder, never vanish", () => {
  const note = buildHandoffNote([turn("user", "hi")], {
    sessionId: "s",
    agent: "a",
    now: NOW,
  });
  expect(note).toContain("## Completed work");
  expect(note).toContain("(none captured)");
});

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-handoff-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("SessionEnd lifecycle writes a handoff only when session_handoff is on", async () => {
  const { captureSessionLifecycleEvent } =
    await import("../../../src/core/brain/session-lifecycle.ts");
  const fixture = join(process.cwd(), "tests/fixtures/sessions/claude-minimal.jsonl");
  const payload = {
    hook_event_name: "SessionEnd",
    session_id: "end-1",
    transcript_path: fixture,
  };

  // Default off: no handoff note.
  delete process.env["OPEN_SECOND_BRAIN_SESSION_HANDOFF"];
  const off = await captureSessionLifecycleEvent(vault, payload, { agent: "a" });
  expect(off.handoff_path).toBeUndefined();
  expect(existsSync(join(vault, "Brain", "handoffs"))).toBe(false);

  // Gated on: one note per session end.
  process.env["OPEN_SECOND_BRAIN_SESSION_HANDOFF"] = "true";
  try {
    const on = await captureSessionLifecycleEvent(vault, payload, { agent: "a" });
    expect(on.handoff_path).toBeDefined();
    expect(existsSync(on.handoff_path!)).toBe(true);
    expect(readFileSync(on.handoff_path!, "utf8")).toContain("## Request");
  } finally {
    delete process.env["OPEN_SECOND_BRAIN_SESSION_HANDOFF"];
  }
});

test("writeHandoffNote lands Brain/handoffs/<date>-<scope>.md with frontmatter", () => {
  const result = writeHandoffNote(vault, {
    turns: TURNS,
    sessionId: "Sess 42",
    agent: "test-agent",
    now: NOW,
  });
  expect(result.path.endsWith(join("Brain", "handoffs", "2026-06-03-sess-42.md"))).toBe(true);
  expect(existsSync(result.path)).toBe(true);
  const content = readFileSync(result.path, "utf8");
  expect(content).toContain("session_id: Sess 42");
  expect(content).toContain("agent: test-agent");
  expect(content).toContain("## Request");
});

/**
 * opencode spool adapter tests.
 *
 * The spool is written by the bundled opencode plugin
 * (`plugins/opencode/open-second-brain.ts`) and is a format this repo
 * owns: meta line `{type: "session_meta", originator:
 * "open-second-brain-opencode-plugin", format: 1}` followed by
 * `{type: "turn", ...}` lines already shaped like `SessionTurn`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { opencodeAdapter } from "../../src/core/brain/sessions/opencode.ts";

const FIXTURE = resolve("tests/fixtures/sessions/opencode-minimal.jsonl");

async function collect(path: string) {
  const turns = [];
  for await (const t of opencodeAdapter.iterate(path)) turns.push(t);
  return turns;
}

function tmpSpool(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "osb-oc-adapter-"));
  const path = join(dir, "spool.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const META = JSON.stringify({
  type: "session_meta",
  originator: "open-second-brain-opencode-plugin",
  format: 1,
  session_id: "s1",
});

describe("opencode adapter — detect", () => {
  test("matches the spool meta line", () => {
    expect(
      opencodeAdapter.detect(
        '{"type":"session_meta","originator":"open-second-brain-opencode-plugin","format":1}',
      ),
    ).toBe(true);
  });

  test("rejects codex session_meta (different originator)", () => {
    expect(
      opencodeAdapter.detect(
        '{"timestamp":"t","type":"session_meta","payload":{"originator":"codex_exec"}}',
      ),
    ).toBe(false);
  });

  test("rejects garbage and unrelated JSON", () => {
    expect(opencodeAdapter.detect("not json")).toBe(false);
    expect(opencodeAdapter.detect('{"foo":1}')).toBe(false);
  });
});

describe("opencode adapter — iterate", () => {
  test("yields normalized turns from the fixture", async () => {
    const turns = await collect(FIXTURE);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({
      turnId: "msg_user_1",
      timestamp: "2026-06-10T09:00:00.000Z",
      role: "user",
      text:
        "How should I handle DB mocking?\n" +
        '@osb feedback negative topic=mocking principle="don\'t mock DB in integration tests" scope=testing',
    });
    expect(turns[1]!.role).toBe("assistant");
    expect(turns[2]!.toolCalls).toEqual([
      {
        name: "brain_feedback",
        id: "call_oc_1",
        input: {
          topic: "mocking",
          signal: "negative",
          principle: "avoid mocking the database in integration tests",
          scope: "testing",
        },
      },
    ]);
  });

  test("skips malformed lines and unknown roles without failing", async () => {
    const path = tmpSpool([
      META,
      "{ not json",
      '{"type":"turn","turnId":"x1","timestamp":"2026-06-10T09:00:00.000Z","role":"alien","text":"hi"}',
      '{"type":"turn","turnId":"x2","timestamp":"2026-06-10T09:00:01.000Z","role":"user","text":"ok"}',
    ]);
    const turns = await collect(path);
    expect(turns.map((t) => t.turnId)).toEqual(["x2"]);
  });

  test("rejects a spool with a newer format version", async () => {
    const path = tmpSpool([
      JSON.stringify({
        type: "session_meta",
        originator: "open-second-brain-opencode-plugin",
        format: 2,
        session_id: "s2",
      }),
      '{"type":"turn","turnId":"x1","timestamp":"2026-06-10T09:00:00.000Z","role":"user","text":"hi"}',
    ]);
    await expect(collect(path)).rejects.toThrow(/format/);
  });

  test("rejects a file whose first line is not the spool meta", async () => {
    const path = tmpSpool([
      '{"type":"turn","turnId":"x1","timestamp":"2026-06-10T09:00:00.000Z","role":"user","text":"hi"}',
      '{"type":"turn","turnId":"x2","timestamp":"2026-06-10T09:00:01.000Z","role":"user","text":"ok"}',
    ]);
    await expect(collect(path)).rejects.toThrow(/meta line missing or invalid/);
  });

  test("turns without text but with toolCalls survive", async () => {
    const path = tmpSpool([
      META,
      '{"type":"turn","turnId":"t1","timestamp":"2026-06-10T09:00:00.000Z","role":"assistant","toolCalls":[{"name":"brain_note","input":{"text":"x"}}]}',
    ]);
    const turns = await collect(path);
    expect(turns[0]!.text).toBeUndefined();
    expect(turns[0]!.toolCalls![0]!.name).toBe("brain_note");
  });
});

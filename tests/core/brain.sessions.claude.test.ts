/**
 * Claude Code .jsonl adapter tests. Source fixture:
 * `tests/fixtures/sessions/claude-minimal.jsonl`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { claudeAdapter } from "../../src/core/brain/sessions/claude.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";

const FIXTURE = resolve("tests/fixtures/sessions/claude-minimal.jsonl");

function firstLine(path: string): string {
  return readFileSync(path, "utf8").split("\n")[0]!;
}

async function collect(path: string): Promise<SessionTurn[]> {
  const out: SessionTurn[] = [];
  for await (const t of claudeAdapter.iterate(path)) out.push(t);
  return out;
}

describe("claudeAdapter.detect", () => {
  test("matches its own format", () => {
    expect(claudeAdapter.detect(firstLine(FIXTURE))).toBe(true);
  });

  test("matches the parentUuid / sessionId / entrypoint shape directly", () => {
    const line =
      '{"parentUuid":null,"sessionId":"x","entrypoint":"sdk-cli","type":"user","message":{"role":"user","content":"hi"},"uuid":"a","timestamp":"2026-05-16T00:00:00Z"}';
    expect(claudeAdapter.detect(line)).toBe(true);
  });

  test("rejects codex first line", () => {
    const codexFirst =
      '{"timestamp":"2026-05-08T20:59:25.611Z","type":"session_meta","payload":{"originator":"codex_exec"}}';
    expect(claudeAdapter.detect(codexFirst)).toBe(false);
  });

  test("rejects hermes first line", () => {
    const hermesFirst =
      '{"role":"session_meta","tools":[{"type":"function","function":{"name":"a"}}]}';
    expect(claudeAdapter.detect(hermesFirst)).toBe(false);
  });

  test("rejects malformed JSON", () => {
    expect(claudeAdapter.detect("not json")).toBe(false);
  });
});

describe("claudeAdapter.iterate", () => {
  test("emits user + assistant turns and skips queue-operation entries", async () => {
    const turns = await collect(FIXTURE);
    const userTurns = turns.filter((t) => t.role === "user");
    const assistantTurns = turns.filter((t) => t.role === "assistant");
    expect(userTurns.length).toBe(2);
    expect(assistantTurns.length).toBe(1);
    // queue-operation events are not yielded.
    expect(turns.some((t) => t.role === "meta")).toBe(false);
  });

  test("flattens string-content user messages into `text`", async () => {
    const turns = await collect(FIXTURE);
    const userOne = turns.find((t) => t.turnId === "turn-user-1");
    expect(userOne).toBeDefined();
    expect(userOne!.text).toContain("@osb feedback negative topic=mocking");
  });

  test("flattens block-content assistant messages into `text` + extracts toolCalls", async () => {
    const turns = await collect(FIXTURE);
    const assistant = turns.find((t) => t.turnId === "turn-assistant-1");
    expect(assistant).toBeDefined();
    expect(assistant!.text).toContain("I'll record that as a preference");
    expect(assistant!.toolCalls).toBeDefined();
    expect(assistant!.toolCalls!.length).toBe(1);
    expect(assistant!.toolCalls![0]!.name).toBe("brain_feedback");
    expect(assistant!.toolCalls![0]!.input).toMatchObject({
      topic: "mocking",
      signal: "negative",
    });
    expect(assistant!.toolCalls![0]!.id).toBe("tu-1");
  });

  test("preserves ISO timestamp on each turn", async () => {
    const turns = await collect(FIXTURE);
    for (const t of turns) {
      expect(t.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
});

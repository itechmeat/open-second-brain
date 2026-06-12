/**
 * Grok Build session adapter.
 *
 * Grok stores each session under
 * `~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl` as a newline-delimited
 * ACP session-update stream: every line is
 * `{timestamp, method:"session/update", params:{sessionId, update:{sessionUpdate, ...}}}`.
 * The adapter normalizes the relevant update kinds into `SessionTurn`s -
 * `user_message_chunk` / `agent_message_chunk` (coalescing consecutive
 * same-role chunks so a streamed message, and any `@osb` marker in it, stays
 * intact) and `tool_call` (the `title` is the tool name, `rawInput` the input).
 * Noise kinds (`available_commands_update`, `agent_thought_chunk`,
 * `tool_call_update`) are skipped. Shapes captured from live grok 0.2.45.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { grokAdapter } from "../../src/core/brain/sessions/grok.ts";
import { SessionImportError } from "../../src/core/brain/sessions/types.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";

const FIXTURE = join(import.meta.dir, "..", "fixtures", "sessions", "grok-minimal.jsonl");

const AVAILABLE_COMMANDS_LINE = JSON.stringify({
  timestamp: 1781213002,
  method: "session/update",
  params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update" } },
});

async function collect(path: string): Promise<SessionTurn[]> {
  const turns: SessionTurn[] = [];
  for await (const t of grokAdapter.iterate(path)) turns.push(t);
  return turns;
}

describe("grok session adapter - detect", () => {
  test("matches a grok ACP session/update first line", () => {
    expect(grokAdapter.detect(AVAILABLE_COMMANDS_LINE)).toBe(true);
  });

  test("rejects other runtimes and garbage", () => {
    expect(grokAdapter.detect(JSON.stringify({ type: "session_meta", originator: "x" }))).toBe(
      false,
    );
    expect(grokAdapter.detect(JSON.stringify({ method: "session/update" }))).toBe(false);
    expect(grokAdapter.detect("not json")).toBe(false);
    expect(grokAdapter.detect("")).toBe(false);
  });
});

describe("grok session adapter - iterate", () => {
  test("normalizes the ACP stream into ordered turns", async () => {
    const turns = await collect(FIXTURE);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    expect(turns[0]!.text).toBe("Remember to prefer tabs over spaces.");
    // Consecutive agent_message_chunk lines coalesce into one turn.
    expect(turns[1]!.text).toBe("I'll record that.");
    expect(turns[3]!.text).toBe("Done.");
  });

  test("extracts the tool call with the MCP namespace stripped to the bare name", async () => {
    const turns = await collect(FIXTURE);
    const toolTurn = turns.find((t) => t.toolCalls && t.toolCalls.length > 0);
    // grok's `open-second-brain__brain_feedback` normalizes to the bare name
    // so the import's exact-match replay fires, as every other adapter yields.
    expect(toolTurn?.toolCalls?.[0]).toEqual({
      name: "brain_feedback",
      input: {
        topic: "indentation-style",
        signal: "positive",
        principle: "Prefer tabs over spaces.",
      },
      id: "call-abc-0",
    });
  });

  test("skips noise updates (available_commands, thought, tool_call_update)", async () => {
    const turns = await collect(FIXTURE);
    // 1 user + 2 agent message turns + 1 tool turn = 4; nothing from the
    // three noise kinds in the fixture.
    expect(turns.length).toBe(4);
    for (const t of turns) {
      expect(t.text ?? "").not.toContain("durable preference"); // the thought chunk
    }
  });

  test("every turn carries a stable id and an ISO timestamp", async () => {
    const turns = await collect(FIXTURE);
    for (const t of turns) {
      expect(t.turnId.length).toBeGreaterThan(0);
      expect(t.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    // ids are unique within the file
    expect(new Set(turns.map((t) => t.turnId)).size).toBe(turns.length);
  });

  test("throws PARSE when the first line is not a grok session/update", async () => {
    const bad = join(import.meta.dir, "..", "fixtures", "sessions", "opencode-minimal.jsonl");
    await expect(collect(bad)).rejects.toBeInstanceOf(SessionImportError);
  });
});

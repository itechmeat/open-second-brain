/**
 * Codex CLI .jsonl adapter tests.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { codexAdapter } from "../../src/core/brain/sessions/codex.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";

const FIXTURE = resolve("tests/fixtures/sessions/codex-minimal.jsonl");

function firstLine(path: string): string {
  return readFileSync(path, "utf8").split("\n")[0]!;
}

async function collect(path: string): Promise<SessionTurn[]> {
  const out: SessionTurn[] = [];
  for await (const t of codexAdapter.iterate(path)) out.push(t);
  return out;
}

describe("codexAdapter.detect", () => {
  test("matches its own format", () => {
    expect(codexAdapter.detect(firstLine(FIXTURE))).toBe(true);
  });

  test("rejects claude first line", () => {
    expect(codexAdapter.detect('{"type":"queue-operation","operation":"x"}')).toBe(false);
  });

  test("rejects hermes first line", () => {
    expect(codexAdapter.detect('{"role":"session_meta","tools":[]}')).toBe(false);
  });

  test("requires the originator=codex_exec marker", () => {
    expect(
      codexAdapter.detect('{"timestamp":"x","type":"session_meta","payload":{"foo":"bar"}}'),
    ).toBe(false);
  });
});

describe("codexAdapter.iterate", () => {
  test("yields user and assistant message turns, skips event_msg / session_meta", async () => {
    const turns = await collect(FIXTURE);
    expect(turns.filter((t) => t.role === "user").length).toBe(1);
    expect(turns.filter((t) => t.role === "assistant").length).toBeGreaterThan(0);
    // event_msg / session_meta entries are not yielded as turns.
    expect(turns.some((t) => t.role === "meta")).toBe(false);
  });

  test("flattens input_text / output_text blocks into `text`", async () => {
    const turns = await collect(FIXTURE);
    const user = turns.find((t) => t.role === "user");
    expect(user?.text).toContain("@osb feedback negative topic=mocking");
    const assistant = turns.find((t) => t.role === "assistant" && t.text);
    expect(assistant?.text).toContain("I'll record that as a preference");
  });

  test("parses function_call into toolCalls (arguments JSON-decoded)", async () => {
    const turns = await collect(FIXTURE);
    const withTool = turns.find((t) => (t.toolCalls?.length ?? 0) > 0);
    expect(withTool).toBeDefined();
    const call = withTool!.toolCalls![0]!;
    expect(call.name).toBe("brain_feedback");
    expect(call.input).toMatchObject({
      topic: "mocking",
      signal: "negative",
    });
    expect(call.id).toBe("call_codex_1");
  });
});

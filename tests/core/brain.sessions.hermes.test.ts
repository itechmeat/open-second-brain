/**
 * Hermes .jsonl adapter tests.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { hermesAdapter } from "../../src/core/brain/sessions/hermes.ts";
import type { SessionTurn } from "../../src/core/brain/sessions/types.ts";

const FIXTURE = resolve("tests/fixtures/sessions/hermes-minimal.jsonl");

function firstLine(path: string): string {
  return readFileSync(path, "utf8").split("\n")[0]!;
}

async function collect(path: string): Promise<SessionTurn[]> {
  const out: SessionTurn[] = [];
  for await (const t of hermesAdapter.iterate(path)) out.push(t);
  return out;
}

describe("hermesAdapter.detect", () => {
  test("matches its own format", () => {
    expect(hermesAdapter.detect(firstLine(FIXTURE))).toBe(true);
  });

  test("rejects codex first line (different role shape)", () => {
    expect(
      hermesAdapter.detect(
        '{"timestamp":"x","type":"session_meta","payload":{"originator":"codex_exec"}}',
      ),
    ).toBe(false);
  });

  test("rejects claude first line", () => {
    expect(hermesAdapter.detect('{"type":"queue-operation","operation":"x"}')).toBe(false);
  });

  test("requires 'tools' array on the meta line", () => {
    expect(hermesAdapter.detect('{"role":"session_meta"}')).toBe(false);
    expect(
      hermesAdapter.detect('{"role":"session_meta","tools":"not-an-array"}'),
    ).toBe(false);
  });
});

describe("hermesAdapter.iterate", () => {
  test("yields user and assistant turns, skips session_meta and tool roles", async () => {
    const turns = await collect(FIXTURE);
    expect(turns.filter((t) => t.role === "user").length).toBe(1);
    expect(turns.filter((t) => t.role === "assistant").length).toBe(2);
    expect(turns.some((t) => t.role === "meta")).toBe(false);
    expect(turns.some((t) => t.role === "tool")).toBe(false);
  });

  test("user text contains the @osb marker", async () => {
    const turns = await collect(FIXTURE);
    const user = turns.find((t) => t.role === "user");
    expect(user?.text).toContain("@osb feedback negative");
  });

  test("parses tool_calls block, decoding JSON arguments", async () => {
    const turns = await collect(FIXTURE);
    const withTool = turns.find((t) => (t.toolCalls?.length ?? 0) > 0);
    expect(withTool).toBeDefined();
    const call = withTool!.toolCalls![0]!;
    expect(call.name).toBe("brain_feedback");
    expect(call.input).toMatchObject({
      topic: "mocking",
      signal: "negative",
    });
    expect(call.id).toBe("call_hermes_1");
  });
});

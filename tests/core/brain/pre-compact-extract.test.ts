import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import { extractPreCompactRecords } from "../../../src/core/brain/pre-compact-extract.ts";
import { lexSource } from "../../helpers/source-lexer.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pre-compact-extract-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("pre-compact extraction", () => {
  test("emits typed records with sanitized text and source turn refs", () => {
    const result = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      host: "unit-test",
      sessionId: "session-a",
      turnStart: "turn-1",
      turnEnd: "turn-3",
      text: [
        "Decision: Ship the receipt reader.",
        "Commitment: Follow up with docs.",
        "Outcome: Tests passed.",
        "Rule: Keep telemetry opt-in.",
        "Open question: Should presets be configurable?",
        "Decision: Ignore inline image data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
      ].join("\n"),
    });

    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.payload["extract_type"])).toEqual([
      "decision",
      "commitment",
      "outcome",
      "rule",
      "open_question",
      "decision",
    ]);
    expect(result.records[0]!.sourceRefs.map((source) => source.id)).toEqual([
      "session-a",
      "turn-1..turn-3",
    ]);
    expect(JSON.stringify(result.records)).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo");
    expect(result.records[5]!.payload["text"]).toContain("[base64]");
  });

  test("records the interrupted flag only when set, byte-identical otherwise", () => {
    const clean = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      sessionId: "session-clean",
      turnStart: "turn-1",
      turnEnd: "turn-1",
      text: "Decision: Clean close keeps the payload unchanged.",
    });
    expect("interrupted" in clean.records[0]!.payload).toBe(false);

    const interrupted = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      sessionId: "session-interrupted",
      turnStart: "turn-1",
      turnEnd: "turn-1",
      text: "Decision: An interrupted flush is recorded honestly.",
      interrupted: true,
    });
    expect(interrupted.records[0]!.payload["interrupted"]).toBe(true);
  });

  test("is idempotent by session, turn range, type, and content hash", () => {
    const input = {
      createdAt: "2026-05-20T17:00:00.000Z",
      host: "unit-test",
      sessionId: "session-a",
      turnStart: "turn-1",
      turnEnd: "turn-2",
      text: "Decision: Keep extraction deterministic.",
    };

    const first = extractPreCompactRecords(vault, input);
    const second = extractPreCompactRecords(vault, input);

    expect(first.records[0]!.id).toBe(second.records[0]!.id);
    expect(listContinuityRecords(vault, { kind: "pre_compact_extract" })).toHaveLength(1);
  });
});

describe("the label recognizer is structural, not a natural-language word list", () => {
  test("recognises labelled lines in a non-Latin script and keeps the label verbatim", () => {
    const result = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      sessionId: "session-ru",
      turnStart: "turn-1",
      turnEnd: "turn-2",
      text: [
        "Решение: перейти на новый пул соединений.",
        "決定: 明日リリースする。",
        "- قرار: نشر الإصدار غدا.",
      ].join("\n"),
    });

    expect(result.errors).toEqual([]);
    expect(result.records.map((record) => record.payload["extract_type"])).toEqual([
      "решение",
      "決定",
      "قرار",
    ]);
    expect(result.records[0]!.payload["text"]).toBe("перейти на новый пул соединений.");
  });

  test("a multi-word label collapses to one token, matching the English shape", () => {
    const result = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      sessionId: "session-multiword",
      turnStart: "turn-1",
      turnEnd: "turn-1",
      text: [
        "Open question: Should presets be configurable?",
        "Открытый вопрос: кто владелец?",
      ].join("\n"),
    });
    expect(result.records.map((record) => record.payload["extract_type"])).toEqual([
      "open_question",
      "открытый_вопрос",
    ]);
  });

  test("structural non-labels are refused: URLs, paths, clock times and prose", () => {
    const result = extractPreCompactRecords(vault, {
      createdAt: "2026-05-20T17:00:00.000Z",
      sessionId: "session-negative",
      turnStart: "turn-1",
      turnEnd: "turn-1",
      text: [
        "https://example.com/deploy",
        "file:///var/log/deploy.log",
        "C:\\Users\\dev\\notes.md",
        "10:30 standup with the platform team",
        "The one thing I would really like to say about all of this is: nothing",
        "[[wiki link]]: not a label",
      ].join("\n"),
    });
    expect(result.records).toEqual([]);
  });

  test("the module carries no natural-language word list", async () => {
    const source = await Bun.file(
      new URL("../../../src/core/brain/pre-compact-extract.ts", import.meta.url).pathname,
    ).text();
    // The shared census lexer. `withoutComments`, not `code`: a word list
    // would be written as string literals, and the code view would blank
    // exactly what this test is looking for.
    const code = lexSource(source).withoutComments;
    for (const word of ["decision", "commitment", "outcome", "rule", "open question"]) {
      expect(code.toLowerCase()).not.toContain(word);
    }
  });
});

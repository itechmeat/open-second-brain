/**
 * The searchable text of a brain store record (design D5): agent and
 * model text often carries markdown of its own, and none of it may change
 * the structure the chunker sees.
 */
import { describe, expect, test } from "bun:test";

import { renderRecordText } from "../../../src/core/search/brain-store/record-text.ts";
import { chunkMarkdown } from "../../../src/core/search/chunker.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";

function record(body: Record<string, unknown>) {
  return buildRecord({
    hlc: { physical: Date.UTC(2026, 10, 3), counter: 0 },
    device: "dev-b",
    agent: "agent-b",
    kind: "decision",
    body,
  });
}

describe("renderRecordText", () => {
  test("a body with headings and an open fence keeps the record's structure", () => {
    const { title, content } = renderRecordText(
      record({
        title: "Estuary plan",
        text: "Line one\n# Fake heading\n## Another\n```ts\nconst unclosed = true;",
        decision: "north bank",
      }),
      "events",
      false,
    );
    const chunks = chunkMarkdown(content, title, {
      maxTokens: 4000,
      minTokens: 1,
      overlapTokens: 0,
    }).chunks;
    expect(chunks.map((c) => c.headingPath)).toEqual(["Estuary plan"]);
    const text = chunks.map((c) => c.content).join("\n");
    // The fence did not swallow what follows it.
    expect(text).toContain("decision: north bank");
    expect(text).toContain("agent: agent-b");
  });

  test("a huge body is cut at the budget", () => {
    const { content } = renderRecordText(
      record({ text: "word ".repeat(40_000), tail: "never reached" }),
      "events",
      false,
    );
    expect(content.length).toBeLessThan(70 * 1024);
    expect(content).not.toContain("never reached");
    expect(content).toContain("agent: agent-b");
  });
});

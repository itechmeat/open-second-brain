/**
 * The searchable text of a brain store record (design D5): agent and
 * model text often carries markdown of its own, and none of it may change
 * the structure the chunker sees.
 */
import { describe, expect, test } from "bun:test";

import { renderRecordText } from "../../../src/core/search/brain-store/record-text.ts";
import { chunkMarkdown } from "../../../src/core/search/chunker.ts";
import { buildRecord } from "../../../src/core/store/envelope.ts";
import { MIGRATED_FIELD } from "../../../src/core/store-migration/migration-records.ts";
import { PRODUCT_DIGESTS } from "../../../src/core/search/brain-store/record-text.ts";
import { LOG_CHAIN_FIELDS } from "../../../src/core/brain/log-chain.ts";

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

  test("integrity digests and the migration mark are left out of the text", () => {
    const digest = "1fe3e1ea941ebeb00b234ce2a8c442177e255decbd2f306a349e234229b15b04";
    const { content } = renderRecordText(
      record({
        timestamp: "2026-06-26T15:08:00.000Z",
        event_type: "note",
        body: { text: "privacy deadline plugin subject32", h: "0".repeat(64) },
        vault_id: "a0c27fe03d2e7456d535795134a289dc",
        legacy_device: "dev-c",
        [MIGRATED_FIELD]: {
          key: "Brain/log/2026-06-26.dev-c.jsonl#909",
          sum: digest,
          part: 0,
          parts: 1,
          vault: { vault_id: "a0c27fe03d2e7456d535795134a289dc", path_sum: digest },
        },
      }),
      "log",
      false,
    );
    expect(content).toContain("body.text: privacy deadline plugin subject32");
    expect(content).toContain("event_type: note");
    expect(content).toContain("timestamp: 2026-06-26T15:08:00.000Z");
    expect(content).toContain("legacy_device: dev-c");
    expect(content).not.toContain(digest);
    expect(content).not.toContain("a0c27fe03d2e7456d535795134a289dc");
    expect(content).not.toContain("0".repeat(64));
    expect(content).not.toContain(`${MIGRATED_FIELD}.`);
  });

  test("a short hex word stays searchable", () => {
    const { content } = renderRecordText(
      record({ text: "commit 4f2a9c1 fixed it", ref: "deadbeef" }),
      "events",
      false,
    );
    expect(content).toContain("ref: deadbeef");
    expect(content).toContain("commit 4f2a9c1 fixed it");
  });

  test("a git commit id or a quoted checksum stays searchable", () => {
    const sha1 = "4f2a9c1e0b7d3a5f6e8c9b0a1d2e3f4a5b6c7d8e";
    const sha256 = "9".repeat(64);
    const { content } = renderRecordText(
      record({
        decision: "ship the fold",
        commit: sha1,
        body: { checksum: sha256, h: sha1 },
        vault_id: "4f2a9c1e0b7d",
      }),
      "events",
      false,
    );
    expect(content).toContain(`commit: ${sha1}`);
    expect(content).toContain(`body.checksum: ${sha256}`);
    // A chain field holding a value of another length is not the chain's digest.
    expect(content).toContain(`body.h: ${sha1}`);
    expect(content).toContain("vault_id: 4f2a9c1e0b7d");
  });

  test("the product digests are named after the fields that write them", () => {
    expect(PRODUCT_DIGESTS.get(LOG_CHAIN_FIELDS.h)).toBe(64);
    expect(PRODUCT_DIGESTS.get(LOG_CHAIN_FIELDS.prev)).toBe(64);
    expect(PRODUCT_DIGESTS.get("vault_id")).toBe(32);
  });
});

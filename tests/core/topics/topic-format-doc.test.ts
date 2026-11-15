/**
 * The shipped FORMAT.md documents every topic record kind, status and log
 * class the code defines (task 3.1), so a reader of the store in another
 * language can fold topics from the document alone.
 */
import { describe, expect, test } from "bun:test";

import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import {
  TOPIC_LOG_CLASSES,
  TOPIC_RECORD_KINDS,
  TOPIC_STATUSES,
  TOPIC_STREAM,
} from "../../../src/core/topics/constants.ts";

const doc = shippedFormatDoc();

describe("FORMAT.md", () => {
  test.each([...TOPIC_RECORD_KINDS])("documents the topic record kind %s", (kind) => {
    expect(doc).toMatch(new RegExp(`^- \`${kind}\`:`, "m"));
  });

  test("names every status, log class and the topics stream", () => {
    for (const name of [...TOPIC_STATUSES, ...TOPIC_LOG_CLASSES])
      expect(doc).toContain(`"${name}"`);
    expect(doc).toMatch(new RegExp(`^- \`${TOPIC_STREAM}\`:`, "m"));
  });
});

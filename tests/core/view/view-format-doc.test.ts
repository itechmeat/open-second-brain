/**
 * The shipped FORMAT.md documents every record kind the human view writes,
 * so a reader of the store in another language can find each one.
 */
import { describe, expect, test } from "bun:test";

import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import { VIEW_RECORD_KINDS } from "../../../src/core/view/constants.ts";

const doc = shippedFormatDoc();

describe("FORMAT.md", () => {
  test("no setting key names the view writer: the claim, move and release records replace it", () => {
    expect(doc).not.toMatch(/^- `view\.writer`:/m);
  });

  test.each([...VIEW_RECORD_KINDS])("documents the human view record kind %s", (kind) => {
    expect(doc).toMatch(new RegExp(`^- \`${kind}\`:`, "m"));
  });

  test("history-verdict goes to the log stream of shared, and a kept note is stored as kept", () => {
    const line = doc.split("\n").find((l) => l.startsWith("- `history-verdict`:")) ?? "";
    expect(line).toContain("written to `log` in `shared`");
    expect(line).toContain("`keep: true`, so a note with any stored verdict is settled");
  });
});

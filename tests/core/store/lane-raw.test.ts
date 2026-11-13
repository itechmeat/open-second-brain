/**
 * The raw lane text helper cases no boundary test owns (design D8 of
 * change `store-hardening`): the verbatim contracts of a page without a
 * blank line after its closing fence, and of plain text, are proven
 * byte for byte in `tests/core/lanes/lane-pages.test.ts`; these cover the
 * shapes that file does not write.
 */
import { describe, expect, test } from "bun:test";
import { laneTextParts, rawToKeep } from "../../../src/core/store/lane-raw.ts";

describe("lane raw text", () => {
  test("a page with no blank line after the closing fence keeps its raw", () => {
    const raw = "---\nkind: k\n---\nBody.\n";
    const { fields, body } = laneTextParts("x.md", raw);
    expect(rawToKeep("x.md", raw, fields, body)).toBe(raw);
  });

  test("plain text never needs raw", () => {
    const raw = "a\nb";
    const { fields, body } = laneTextParts("x.txt", raw);
    expect(rawToKeep("x.txt", raw, fields, body)).toBeUndefined();
  });
});

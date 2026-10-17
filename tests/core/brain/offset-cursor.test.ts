import { describe, expect, test } from "bun:test";

import {
  OFFSET_CURSOR_MAX_LENGTH,
  OffsetCursorError,
  decodeOffsetCursor,
  encodeOffsetCursor,
  pageSlice,
} from "../../../src/core/brain/offset-cursor.ts";

describe("encodeOffsetCursor/decodeOffsetCursor", () => {
  test("encode/decode round-trip", () => {
    for (const offset of [0, 1, 7, 49, 500, 123456]) {
      expect(decodeOffsetCursor(encodeOffsetCursor(offset))).toBe(offset);
    }
  });

  test("encoding is the opaque base64url `o:<offset>` form", () => {
    // base64url("o:5") - pinned so the canonical form is explicit.
    expect(encodeOffsetCursor(5)).toBe(Buffer.from("o:5", "utf8").toString("base64url"));
    expect(OFFSET_CURSOR_MAX_LENGTH).toBeGreaterThanOrEqual(encodeOffsetCursor(999999999).length);
  });

  test("a malformed cursor is rejected", () => {
    for (const bad of ["!!!not-base64!!!", "", "5", "o:x", "offset:5", "o:-1"]) {
      expect(() => decodeOffsetCursor(bad)).toThrow(OffsetCursorError);
    }
  });
});

describe("pageSlice", () => {
  const items = ["a", "b", "c", "d", "e"];

  test("an exhausted page returns next_cursor: null", () => {
    const last = pageSlice(items, 4, 2);
    expect(last.items).toEqual(["e"]);
    expect(last.total).toBe(5);
    expect(last.next_cursor).toBeNull();
  });

  test("each page's cursor leads to the next and the pages reassemble the set", () => {
    const limit = 2;
    // Bound the walk by the page arithmetic: ceil(total/limit) pages plus one
    // slack step, so a next_cursor that never turns null exhausts the budget
    // and fails here instead of hanging the loop at 100% CPU.
    const maxSteps = Math.ceil(items.length / limit) + 1;
    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let step = 0; step < maxSteps; step += 1) {
      const offset: number = cursor === null ? 0 : decodeOffsetCursor(cursor);
      const page: ReturnType<typeof pageSlice<string>> = pageSlice(items, offset, limit);
      pages.push([...page.items]);
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull();
    expect(pages).toHaveLength(Math.ceil(items.length / limit));
    expect(pages.flat()).toEqual(items);
  });

  test("an empty set yields one exhausted page", () => {
    const page = pageSlice([], 0, 2);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.next_cursor).toBeNull();
  });

  test("an explicit total overrides items.length for the exhaustion check", () => {
    // Caller already computed a total that is not items.length.
    const page = pageSlice(items.slice(0, 2), 0, 2, 5);
    expect(page.total).toBe(5);
    expect(page.next_cursor).toBe(encodeOffsetCursor(2));
  });

  test("a non-positive or non-integer limit is rejected", () => {
    expect(() => pageSlice(items, 0, 0)).toThrow(OffsetCursorError);
    expect(() => pageSlice(items, 0, -3)).toThrow(OffsetCursorError);
    expect(() => pageSlice(items, 0, 1.5)).toThrow(OffsetCursorError);
  });
});

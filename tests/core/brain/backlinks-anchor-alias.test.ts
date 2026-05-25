/**
 * v0.10.17 atom coverage for the anchor / block / alias-source slots
 * on `BacklinkRef`.
 *
 * This file locks the additive shape so legacy consumers reading only
 * the four pre-v0.10.17 fields keep compiling. The populated-behaviour
 * suite for `buildBacklinkIndex` lives in a sibling test file added
 * in Unit 3.
 */

import { describe, expect, test } from "bun:test";

import type { BacklinkRef } from "../../../src/core/brain/backlinks.ts";

describe("BacklinkRef atom shape (additive)", () => {
  test("accepts ref with only legacy fields populated", () => {
    const legacy: BacklinkRef = {
      source: "pref-foo",
      sourceKind: "preference",
      field: "evidenced_by",
    };
    expect(legacy.source).toBe("pref-foo");
    expect(legacy.targetAnchor).toBeUndefined();
    expect(legacy.targetBlock).toBeUndefined();
    expect(legacy.aliasSource).toBeUndefined();
  });

  test("accepts ref with anchor populated", () => {
    const ref: BacklinkRef = {
      source: "pref-foo",
      sourceKind: "preference",
      field: "body",
      targetAnchor: "Section 1",
    };
    expect(ref.targetAnchor).toBe("Section 1");
  });

  test("accepts ref with block populated", () => {
    const ref: BacklinkRef = {
      source: "pref-foo",
      sourceKind: "preference",
      field: "body",
      targetBlock: "abc123",
    };
    expect(ref.targetBlock).toBe("abc123");
  });

  test("accepts ref with alias-source populated", () => {
    const ref: BacklinkRef = {
      source: "pref-foo",
      sourceKind: "preference",
      field: "body",
      aliasSource: "downstream effects",
    };
    expect(ref.aliasSource).toBe("downstream effects");
  });
});

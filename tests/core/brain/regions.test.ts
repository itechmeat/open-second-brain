/**
 * Sentinel-region merge engine (Project History Suite, t_929da8a2).
 * Generated regions refresh; everything else is operator-owned and
 * survives regeneration byte-for-byte.
 */

import { expect, test } from "bun:test";

import {
  buildRegionDocument,
  mergeRegions,
  parseRegions,
  RegionError,
} from "../../../src/core/brain/regions.ts";

const DOC = [
  "---",
  "kind: arch-overview",
  "---",
  "",
  "<!-- o2b:begin summary -->",
  "Generated summary v1.",
  "<!-- o2b:end summary -->",
  "",
  "Operator prose between regions stays untouched.",
  "",
  "<!-- o2b:begin modules -->",
  "- module a",
  "<!-- o2b:end modules -->",
  "",
  "Trailing operator notes.",
].join("\n");

test("parseRegions extracts region ids and bodies", () => {
  const regions = parseRegions(DOC);
  expect([...regions.keys()]).toEqual(["summary", "modules"]);
  expect(regions.get("summary")).toBe("Generated summary v1.");
  expect(regions.get("modules")).toBe("- module a");
});

test("mergeRegions replaces only generated bodies, preserving everything else byte-for-byte", () => {
  const merged = mergeRegions(DOC, [
    { id: "summary", body: "Generated summary v2." },
    { id: "modules", body: "- module a\n- module b" },
  ]);
  expect(merged).toContain("Generated summary v2.");
  expect(merged).toContain("- module b");
  expect(merged).toContain("Operator prose between regions stays untouched.");
  expect(merged).toContain("Trailing operator notes.");
  expect(merged).toContain("kind: arch-overview");
  // Idempotency: merging the same regions again changes nothing.
  expect(
    mergeRegions(merged, [
      { id: "summary", body: "Generated summary v2." },
      { id: "modules", body: "- module a\n- module b" },
    ]),
  ).toBe(merged);
});

test("regions missing from the document are appended at the end", () => {
  const merged = mergeRegions(DOC, [
    { id: "summary", body: "Generated summary v1." },
    { id: "decisions", body: "- new decisions section" },
  ]);
  expect(merged).toContain("<!-- o2b:begin decisions -->");
  expect(merged).toContain("- new decisions section");
  // Appended AFTER the operator's trailing notes.
  expect(merged.indexOf("Trailing operator notes.")).toBeLessThan(
    merged.indexOf("o2b:begin decisions"),
  );
});

test("regions present in the document but absent from the update stay untouched", () => {
  const merged = mergeRegions(DOC, [{ id: "summary", body: "v3" }]);
  expect(merged).toContain("- module a");
  expect(parseRegions(merged).get("modules")).toBe("- module a");
});

test("fail-closed: unbalanced, duplicate, and nested sentinels raise RegionError", () => {
  expect(() => parseRegions("<!-- o2b:begin a -->\nno end")).toThrow(RegionError);
  expect(() => parseRegions("<!-- o2b:end a -->")).toThrow(RegionError);
  expect(() =>
    parseRegions(
      "<!-- o2b:begin a -->\nx\n<!-- o2b:end a -->\n<!-- o2b:begin a -->\ny\n<!-- o2b:end a -->",
    ),
  ).toThrow(/duplicate/i);
  expect(() =>
    parseRegions(
      "<!-- o2b:begin a -->\n<!-- o2b:begin b -->\n<!-- o2b:end b -->\n<!-- o2b:end a -->",
    ),
  ).toThrow(/nested/i);
  // Mismatched end id.
  expect(() => parseRegions("<!-- o2b:begin a -->\nx\n<!-- o2b:end b -->")).toThrow(RegionError);
  // mergeRegions refuses to touch a corrupted document.
  expect(() => mergeRegions("<!-- o2b:begin a -->\nbroken", [{ id: "a", body: "x" }])).toThrow(
    RegionError,
  );
});

test("CRLF documents keep their regions visible (no duplicate appends)", () => {
  const crlf = ["<!-- o2b:begin a -->", "old body", "<!-- o2b:end a -->", ""].join("\r\n");
  expect(parseRegions(crlf).has("a")).toBe(true);
  const merged = mergeRegions(crlf, [{ id: "a", body: "new body" }]);
  expect(merged).toContain("new body");
  // Updated in place - not appended as a second region block.
  expect(merged.match(/o2b:begin a/g)).toHaveLength(1);
});

test("buildRegionDocument renders regions for a fresh file", () => {
  const doc = buildRegionDocument([
    { id: "summary", body: "First summary." },
    { id: "modules", body: "- m1" },
  ]);
  expect(parseRegions(doc).get("summary")).toBe("First summary.");
  expect(parseRegions(doc).get("modules")).toBe("- m1");
  // Round-trip: merging identical regions into a fresh document is identity.
  expect(
    mergeRegions(doc, [
      { id: "summary", body: "First summary." },
      { id: "modules", body: "- m1" },
    ]),
  ).toBe(doc);
});

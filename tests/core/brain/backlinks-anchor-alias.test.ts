/**
 * v0.10.17 coverage for the anchor / block / alias-source slots on
 * `BacklinkRef`.
 *
 * First block locks the additive shape so legacy consumers reading
 * only the four pre-v0.10.17 fields keep compiling. The remaining
 * blocks exercise `buildBacklinkIndex` after Unit 3 wires the rich
 * parse + alias index into the collectors.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBacklinkIndex, type BacklinkRef } from "../../../src/core/brain/backlinks.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

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

// ---------------------------------------------------------------------
// buildBacklinkIndex populated-behaviour suite (Unit 3 wiring).
// ---------------------------------------------------------------------

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-backlinks-anchor-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildBacklinkIndex - anchor / block populated from body wikilinks", () => {
  test("heading anchor lands on the ref", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-foo.md"),
      [
        "---",
        "kind: preference",
        "topic: foo",
        "_status: confirmed",
        "principle: example",
        "---",
        "",
        "References [[bar#Section A]] in the body.",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("bar") ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0]?.targetAnchor).toBe("Section A");
    expect(refs[0]?.targetBlock).toBeUndefined();
  });

  test("block id lands on the ref", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-foo.md"),
      [
        "---",
        "kind: preference",
        "topic: foo",
        "_status: confirmed",
        "principle: example",
        "---",
        "",
        "Refers to [[bar#^block-id-x]] specifically.",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("bar") ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0]?.targetBlock).toBe("block-id-x");
    expect(refs[0]?.targetAnchor).toBeUndefined();
  });

  test("two refs to different anchors of the same target keep separate entries", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-foo.md"),
      [
        "---",
        "kind: preference",
        "topic: foo",
        "_status: confirmed",
        "principle: example",
        "---",
        "",
        "First [[bar#Alpha]] then [[bar#Beta]].",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("bar") ?? [];
    expect(refs.length).toBe(2);
    const anchors = refs.map((r) => r.targetAnchor).toSorted();
    expect(anchors).toEqual(["Alpha", "Beta"]);
  });
});

describe("buildBacklinkIndex - alias resolution", () => {
  test("link via frontmatter alias resolves to canonical id with aliasSource recorded", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-second-order.md"),
      [
        "---",
        "kind: preference",
        "topic: second-order",
        "_status: confirmed",
        "principle: thinking ahead",
        "aliases: [downstream]",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-linker.md"),
      [
        "---",
        "kind: preference",
        "topic: linker",
        "_status: confirmed",
        "principle: example",
        "---",
        "",
        "I rely on [[downstream]] reasoning.",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("pref-second-order") ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0]?.source).toBe("pref-linker");
    expect(refs[0]?.aliasSource).toBe("downstream");
  });

  test("link by canonical id does not populate aliasSource", () => {
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-canonical.md"),
      [
        "---",
        "kind: preference",
        "topic: c",
        "_status: confirmed",
        "principle: x",
        "aliases: [other-name]",
        "---",
      ].join("\n"),
    );
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-linker.md"),
      [
        "---",
        "kind: preference",
        "topic: l",
        "_status: confirmed",
        "principle: y",
        "---",
        "",
        "Links to [[pref-canonical]].",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("pref-canonical") ?? [];
    expect(refs.length).toBe(1);
    expect(refs[0]?.aliasSource).toBeUndefined();
  });

  test("legacy callers reading only legacy fields are unaffected", () => {
    // Smoke check: existing collectors still produce refs with
    // populated `source`, `sourceKind`, `field`. Used to be the
    // entire BacklinkRef contract; v0.10.17 only added optional
    // fields so this destructure must keep working.
    writeFileSync(
      join(vault, "Brain", "preferences", "pref-a.md"),
      [
        "---",
        "kind: preference",
        "topic: a",
        "_status: confirmed",
        "principle: x",
        "---",
        "",
        "Mentions [[b]] in body.",
      ].join("\n"),
    );
    const idx = buildBacklinkIndex(vault);
    const refs = idx.get("b") ?? [];
    expect(refs.length).toBe(1);
    const { source, sourceKind, field } = refs[0]!;
    expect(source).toBe("pref-a");
    expect(sourceKind).toBe("preference");
    expect(field).toBe("body");
  });
});

/**
 * Unit tests for `buildAliasIndex`. The helper walks Brain
 * preferences + retired artifacts, reads their frontmatter
 * `aliases:` arrays, and returns a frozen Map keyed by NFC-normalised
 * lowercase alias text, valued at the canonical artifact id.
 *
 * Collisions (two artifacts claiming the same alias) resolve
 * first-wins by sorted canonical id - deterministic without an
 * extra timestamp lookup. Empty / non-array aliases are skipped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAliasIndex } from "../../../../src/core/brain/link-graph/alias-index.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";

let vault: string;

function writePref(slug: string, body: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", `${slug}.md`),
    `${body}\n`,
  );
}

function writeRetired(slug: string, body: string): void {
  writeFileSync(
    join(vault, "Brain", "retired", `${slug}.md`),
    `${body}\n`,
  );
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-alias-index-"));
  bootstrapBrain(vault);
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("buildAliasIndex - happy path", () => {
  test("registers single alias", () => {
    writePref(
      "pref-second-order",
      [
        "---",
        "kind: preference",
        "topic: second-order",
        "status: confirmed",
        "principle: thinking ahead",
        "aliases: [downstream]",
        "---",
        "",
        "Body.",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("downstream")).toBe("pref-second-order");
  });

  test("registers multiple aliases per artifact", () => {
    writePref(
      "pref-second-order",
      [
        "---",
        "kind: preference",
        "topic: second-order",
        "status: confirmed",
        "principle: thinking ahead",
        "aliases: [downstream, knock-on, second-order-effects]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("downstream")).toBe("pref-second-order");
    expect(idx.get("knock-on")).toBe("pref-second-order");
    expect(idx.get("second-order-effects")).toBe("pref-second-order");
  });

  test("collects aliases from retired artifacts", () => {
    writeRetired(
      "ret-old",
      [
        "---",
        "kind: retired",
        "topic: old",
        "principle: superseded",
        "aliases: [legacy-rule]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("legacy-rule")).toBe("ret-old");
  });
});

describe("buildAliasIndex - normalisation", () => {
  test("case-insensitive lookup", () => {
    writePref(
      "pref-foo",
      [
        "---",
        "kind: preference",
        "topic: foo",
        "status: confirmed",
        "principle: bar",
        "aliases: [Downstream]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("downstream")).toBe("pref-foo");
    // Original casing also accessible via the lower-case key only;
    // callers normalise the lookup key themselves.
    expect(idx.get("Downstream")).toBeUndefined();
  });

  test("NFC normalisation collapses pre-composed and decomposed forms", () => {
    // "café" composed (U+00E9) vs decomposed (U+0065 U+0301).
    const composed = "café";
    const decomposed = "café";
    writePref(
      "pref-cafe",
      [
        "---",
        "kind: preference",
        "topic: cafe",
        "status: confirmed",
        "principle: x",
        `aliases: [${decomposed}]`,
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    // Lookup with composed form should hit (NFC normalises both
    // sides).
    expect(idx.get(composed.normalize("NFC").toLowerCase())).toBe(
      "pref-cafe",
    );
  });

  test("trims whitespace from alias entries", () => {
    writePref(
      "pref-trim",
      [
        "---",
        "kind: preference",
        "topic: trim",
        "status: confirmed",
        "principle: x",
        "aliases: [ spaced , another  ]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("spaced")).toBe("pref-trim");
    expect(idx.get("another")).toBe("pref-trim");
  });

  test("skips empty alias strings", () => {
    writePref(
      "pref-empty",
      [
        "---",
        "kind: preference",
        "topic: empty",
        "status: confirmed",
        "principle: x",
        "aliases: [valid, '', ok]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("valid")).toBe("pref-empty");
    expect(idx.get("ok")).toBe("pref-empty");
    expect(idx.get("")).toBeUndefined();
  });
});

describe("buildAliasIndex - collision handling", () => {
  test("first-wins by sorted canonical id", () => {
    writePref(
      "pref-aaa",
      [
        "---",
        "kind: preference",
        "topic: a",
        "status: confirmed",
        "principle: x",
        "aliases: [shared]",
        "---",
      ].join("\n"),
    );
    writePref(
      "pref-bbb",
      [
        "---",
        "kind: preference",
        "topic: b",
        "status: confirmed",
        "principle: x",
        "aliases: [shared]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("shared")).toBe("pref-aaa");
  });

  test("alias does not collide with another note's canonical id (declared first wins)", () => {
    // pref-foo has alias "bar"; pref-bar has no alias.
    // Lookup of "bar" must return whichever the alias claims, which
    // resolves first by sorted canonical id. With sorted order
    // pref-bar comes before pref-foo, but pref-bar does NOT claim
    // "bar" as an alias - aliases are declarations, not implicit
    // self-references. So lookup of "bar" returns pref-foo.
    writePref(
      "pref-foo",
      [
        "---",
        "kind: preference",
        "topic: foo",
        "status: confirmed",
        "principle: x",
        "aliases: [bar]",
        "---",
      ].join("\n"),
    );
    writePref(
      "pref-bar",
      [
        "---",
        "kind: preference",
        "topic: bar",
        "status: confirmed",
        "principle: y",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("bar")).toBe("pref-foo");
  });
});

describe("buildAliasIndex - degenerate inputs", () => {
  test("empty vault returns empty frozen map", () => {
    const idx = buildAliasIndex(vault);
    expect(idx.size).toBe(0);
    expect(Object.isFrozen(idx)).toBe(true);
  });

  test("artifact without aliases is skipped", () => {
    writePref(
      "pref-noalias",
      [
        "---",
        "kind: preference",
        "topic: x",
        "status: confirmed",
        "principle: y",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.size).toBe(0);
  });

  test("non-array aliases value is skipped without throwing", () => {
    writePref(
      "pref-scalar",
      [
        "---",
        "kind: preference",
        "topic: x",
        "status: confirmed",
        "principle: y",
        "aliases: not-an-array",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.size).toBe(0);
  });

  test("malformed frontmatter row is silently skipped", () => {
    writePref(
      "pref-bad",
      [
        "no frontmatter here",
        "just body content",
      ].join("\n"),
    );
    writePref(
      "pref-good",
      [
        "---",
        "kind: preference",
        "topic: g",
        "status: confirmed",
        "principle: y",
        "aliases: [ok]",
        "---",
      ].join("\n"),
    );
    const idx = buildAliasIndex(vault);
    expect(idx.get("ok")).toBe("pref-good");
  });
});

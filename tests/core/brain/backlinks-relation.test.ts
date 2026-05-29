/**
 * Typed graph semantics (unit 2) - the Brain-layer backlink index
 * records a `relation` per ref when the carrying frontmatter field is a
 * known relation, generalising the prior `superseded_by` handling to the
 * full vocabulary via the single relation-vocab boundary.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBacklinkIndex } from "../../../src/core/brain/backlinks.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-backlinks-relation-"));
  bootstrapBrain(vault);
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("a contradicts frontmatter field tags its ref with relation 'contradicts'", () => {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-foo.md"),
    [
      "---",
      "kind: preference",
      "topic: foo",
      "_status: confirmed",
      "principle: example",
      "contradicts: [[pref-bar]]",
      "---",
      "",
      "body",
    ].join("\n"),
  );
  const idx = buildBacklinkIndex(vault);
  const refs = idx.get("pref-bar") ?? [];
  expect(refs.length).toBe(1);
  expect(refs[0]?.relation).toBe("contradicts");
  expect(refs[0]?.field).toBe("contradicts");
});

test("a retired pref's superseded_by ref carries relation 'superseded_by'", () => {
  writeFileSync(
    join(vault, "Brain", "retired", "ret-old.md"),
    [
      "---",
      "kind: retired",
      "topic: old",
      "_status: retired",
      "principle: stale rule",
      "superseded_by: [[pref-new]]",
      "---",
      "",
      "body",
    ].join("\n"),
  );
  const idx = buildBacklinkIndex(vault);
  const refs = idx.get("pref-new") ?? [];
  const superseded = refs.find((r) => r.field === "superseded_by");
  expect(superseded).toBeDefined();
  expect(superseded?.relation).toBe("superseded_by");
});

test("a non-vocabulary field (supersedes) carries no relation", () => {
  // `supersedes` is the inverse of `superseded_by` and is deliberately
  // NOT part of the relation vocabulary, so its ref must stay untyped.
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-foo.md"),
    [
      "---",
      "kind: preference",
      "topic: foo",
      "_status: confirmed",
      "principle: example",
      "supersedes: pref-old",
      "---",
      "",
      "body",
    ].join("\n"),
  );
  const idx = buildBacklinkIndex(vault);
  const refs = idx.get("pref-old") ?? [];
  expect(refs.length).toBe(1);
  expect(refs[0]?.field).toBe("supersedes");
  expect(refs[0]?.relation).toBeUndefined();
});

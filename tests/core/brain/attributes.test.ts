/**
 * Per-type attribute fields (t_f5633190): the schema pack's
 * `attributes` field declares, per page type, a small set of fields
 * with natural-language descriptions. The descriptions are agent
 * guidance - they render in schema explain output - and validation is
 * fail-closed: assigning an undeclared field lists the declared
 * fields with their descriptions so the caller can self-correct.
 * Values persist as a sorted `attributes: [field=value]` frontmatter
 * array, filterable through the existing `--property` filter.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assignNoteAttribute,
  AttributeVocabularyError,
  readAttributes,
  removeNoteAttribute,
  validateAttributeAssignment,
} from "../../../src/core/brain/attributes.ts";
import { explainSchemaToken } from "../../../src/core/brain/schema-admin.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";

const PACK = parseSchemaPack(
  [
    "schema_version: 1",
    "schema:",
    "  page_types: [paper]",
    "  attributes:",
    "    - paper.status=reading status, e.g. queued or finished",
    "    - paper.year=publication year as a 4-digit number",
  ].join("\n") + "\n",
);

describe("validateAttributeAssignment", () => {
  test("accepts a declared field and trims the value", () => {
    expect(validateAttributeAssignment(PACK, "paper", "status", " queued ")).toEqual({
      type: "paper",
      field: "status",
      value: "queued",
    });
  });

  test("a type without declared attributes fails listing the declared types", () => {
    expect(() => validateAttributeAssignment(PACK, "person", "status", "x")).toThrow(
      AttributeVocabularyError,
    );
    expect(() => validateAttributeAssignment(PACK, "person", "status", "x")).toThrow(
      /person.*declared attribute types: paper/,
    );
  });

  test("an undeclared field fails listing fields with their descriptions", () => {
    expect(() => validateAttributeAssignment(PACK, "paper", "rating", "5")).toThrow(
      /rating.*declared fields: status \(reading status, e\.g\. queued or finished\), year \(publication year as a 4-digit number\)/,
    );
  });

  test("values must be single-line and comma-free", () => {
    expect(() => validateAttributeAssignment(PACK, "paper", "status", "a\nb")).toThrow(
      /single line/,
    );
    expect(() => validateAttributeAssignment(PACK, "paper", "status", "a,b")).toThrow(/comma/);
    expect(() => validateAttributeAssignment(PACK, "paper", "status", "  ")).toThrow(/empty/);
  });
});

describe("assignNoteAttribute / removeNoteAttribute", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-attrs-"));
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(
      join(vault, "notes", "paper.md"),
      "---\ntype: paper\ntitle: A Paper\n---\n\n# A Paper\n\nbody\n",
    );
    writeFileSync(join(vault, "notes", "untyped.md"), "# Untyped\n\nbody\n");
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("assignment reads the note's type, persists sorted field=value entries", () => {
    assignNoteAttribute(vault, "notes/paper.md", { field: "year", value: "2026", pack: PACK });
    const result = assignNoteAttribute(vault, "notes/paper.md", {
      field: "status",
      value: "queued",
      pack: PACK,
    });
    expect(result.attributes).toEqual(["status=queued", "year=2026"]);
    const [fm, body] = parseFrontmatter(join(vault, "notes", "paper.md"));
    expect(fm["attributes"]).toEqual(["status=queued", "year=2026"]);
    expect(fm["title"]).toBe("A Paper");
    expect(body).toContain("body");
  });

  test("reassigning a field replaces its value", () => {
    assignNoteAttribute(vault, "notes/paper.md", { field: "status", value: "queued", pack: PACK });
    const result = assignNoteAttribute(vault, "notes/paper.md", {
      field: "status",
      value: "finished",
      pack: PACK,
    });
    expect(result.attributes).toEqual(["status=finished"]);
  });

  test("a note without a type cannot take attributes", () => {
    expect(() =>
      assignNoteAttribute(vault, "notes/untyped.md", {
        field: "status",
        value: "queued",
        pack: PACK,
      }),
    ).toThrow(/declares no type/);
  });

  test("removal drops one field and reports presence", () => {
    assignNoteAttribute(vault, "notes/paper.md", { field: "status", value: "queued", pack: PACK });
    const removed = removeNoteAttribute(vault, "notes/paper.md", { field: "status" });
    expect(removed.removed).toBe(true);
    expect(removed.attributes).toEqual([]);
    const [fm] = parseFrontmatter(join(vault, "notes", "paper.md"));
    expect(fm["attributes"]).toBeUndefined();
    const again = removeNoteAttribute(vault, "notes/paper.md", { field: "status" });
    expect(again.removed).toBe(false);
  });

  test("readAttributes parses field=value entries", () => {
    assignNoteAttribute(vault, "notes/paper.md", { field: "year", value: "2026", pack: PACK });
    const [fm] = parseFrontmatter(join(vault, "notes", "paper.md"));
    expect(readAttributes(fm)).toEqual({ year: "2026" });
  });
});

describe("schema explain surface", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-attrs-explain-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "schema:",
        "  page_types: [paper]",
        "  attributes:",
        "    - paper.status=reading status, e.g. queued or finished",
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("explainSchemaToken renders declared attribute descriptors", () => {
    const explanation = explainSchemaToken(vault, "paper");
    expect(explanation.attributes).toEqual({
      status: "reading status, e.g. queued or finished",
    });
  });

  test("a token without attributes explains with an empty descriptor map", () => {
    const explanation = explainSchemaToken(vault, "note");
    expect(explanation.attributes).toEqual({});
  });
});

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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("the write binding's own config is not writable through attributes (t_sec_labels_governance)", () => {
    // Marker write-back resolves targets from note wikilinks, so a marker
    // line naming the config must not become a governance rewrite either.
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const configPath = join(vault, "Brain", "_brain.yaml");
    writeFileSync(configPath, "schema_version: 1\n", "utf8");
    expect(() =>
      assignNoteAttribute(vault, "Brain/_brain.yaml", { field: "status", value: "x", pack: PACK }),
    ).toThrow(/config/);
    expect(() => removeNoteAttribute(vault, "Brain/_brain.yaml", { field: "status" })).toThrow(
      /config/,
    );
    expect(readFileSync(configPath, "utf8")).toBe("schema_version: 1\n");
  });

  test("the standing rules are not writable through attributes", () => {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const rulesPath = join(vault, "Brain", "standing-rules.md");
    writeFileSync(rulesPath, "# Rules\n\nhands off\n", "utf8");
    expect(() =>
      assignNoteAttribute(vault, "Brain/standing-rules.md", {
        field: "status",
        value: "x",
        pack: PACK,
      }),
    ).toThrow(/standing-rules/);
    expect(readFileSync(rulesPath, "utf8")).toContain("hands off");
  });

  test("Brain machinery and non-note files are refused with no binding declared", () => {
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const idPath = join(vault, "Brain", "vault-id.json");
    writeFileSync(idPath, '{"id":"v"}\n', "utf8");
    expect(() =>
      assignNoteAttribute(vault, "Brain/vault-id.json", {
        field: "status",
        value: "x",
        pack: PACK,
      }),
    ).toThrow(/Brain machinery|not a Markdown note/);
    expect(() => removeNoteAttribute(vault, "BRAIN/vault-id.json", { field: "status" })).toThrow(
      /Brain machinery|not a Markdown note/,
    );
    expect(readFileSync(idPath, "utf8")).toBe('{"id":"v"}\n');
    writeFileSync(join(vault, "_vault-map.yaml"), "roles: {}\n", "utf8");
    expect(() =>
      assignNoteAttribute(vault, "_vault-map.yaml", { field: "status", value: "x", pack: PACK }),
    ).toThrow(/not a Markdown note/);
    expect(readFileSync(join(vault, "_vault-map.yaml"), "utf8")).toBe("roles: {}\n");
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

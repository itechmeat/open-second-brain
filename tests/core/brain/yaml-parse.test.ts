/**
 * Unit tests for the YAML subset parser extracted from policy.ts.
 *
 * The parser grammar itself is unchanged by the extraction; the broad
 * grammar/error coverage stays in tests/core/brain.policy.test.ts
 * (loadBrainConfig round-trips). These cases pin the module contract
 * in isolation.
 */

import { describe, expect, test } from "bun:test";

import { parseBrainYaml } from "../../../src/core/brain/yaml-parse.ts";

describe("parseBrainYaml", () => {
  test("parses top-level scalars with type coercion", () => {
    const parsed = parseBrainYaml("schema_version: 1\nname: 'quoted'\nflag: true\nempty: null\n");
    expect(parsed).toEqual({ schema_version: 1, name: "quoted", flag: true, empty: null });
  });

  test("parses one-level blocks and inline arrays", () => {
    const parsed = parseBrainYaml("retire:\n  stale_evidence_days: 90\n  tags: [a, 'b c']\n");
    expect(parsed).toEqual({ retire: { stale_evidence_days: 90, tags: ["a", "b c"] } });
  });

  test("parses block-level dash lists", () => {
    const parsed = parseBrainYaml("notes:\n  read_paths:\n    - Notes\n    - Projects\n");
    expect(parsed).toEqual({ notes: { read_paths: ["Notes", "Projects"] } });
  });

  test("skips comments and blank lines", () => {
    const parsed = parseBrainYaml("# header\n\nschema_version: 1 # trailing\n");
    expect(parsed).toEqual({ schema_version: 1 });
  });

  test("rejects nested blocks deeper than one level", () => {
    expect(() => parseBrainYaml("a:\n  b:\n    c: 1\n")).toThrow(
      "nested blocks deeper than one level are not supported",
    );
  });

  test("rejects duplicate keys with line context", () => {
    expect(() => parseBrainYaml("a: 1\na: 2\n")).toThrow("duplicate top-level key 'a'");
    expect(() => parseBrainYaml("b:\n  x: 1\n  x: 2\n")).toThrow("duplicate key 'x' in block 'b'");
  });

  test("rejects unterminated quoted strings in inline arrays", () => {
    expect(() => parseBrainYaml("tags: ['open]\n")).toThrow(
      "unterminated quoted string in inline array",
    );
  });
});

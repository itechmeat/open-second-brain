/**
 * Schema-pack ontology fields (write-time-integrity-governance Task 1):
 * `labels` (controlled-vocabulary dimensions), `link_constraints`
 * (allowed source->target pairs per link type), `attributes`
 * (per-type field descriptors), and `frontmatter_tiers` (per-kind
 * field tier map). All additive: a config without them parses to
 * empty frozen structures and renders nothing - the neutral default
 * is pinned byte-for-byte.
 */

import { describe, expect, test } from "bun:test";

import {
  applyMutationsToPack,
  type SchemaMutation,
} from "../../../src/core/brain/schema-mutate.ts";
import {
  FRONTMATTER_TIERS,
  parseSchemaPack,
  renderSchemaBlock,
} from "../../../src/core/brain/schema-pack.ts";

const BASE = [
  "schema_version: 1",
  "schema:",
  "  page_types: [paper, person]",
  "  link_types:",
  "    - depends_on",
].join("\n");

describe("parseSchemaPack ontology fields", () => {
  test("config without ontology fields parses to empty frozen structures", () => {
    const pack = parseSchemaPack(BASE + "\n");
    expect(pack.labels).toEqual({});
    expect(pack.link_constraints).toEqual({});
    expect(pack.attributes).toEqual({});
    expect(pack.frontmatter_tiers).toEqual({});
    expect(Object.isFrozen(pack.labels)).toBe(true);
    expect(Object.isFrozen(pack.frontmatter_tiers)).toBe(true);
  });

  test("neutral default renders nothing - render is byte-identical to today", () => {
    const pack = parseSchemaPack(BASE + "\n");
    const block = renderSchemaBlock(pack);
    expect(block).not.toContain("labels");
    expect(block).not.toContain("link_constraints");
    expect(block).not.toContain("attributes");
    expect(block).not.toContain("frontmatter_tiers");
  });

  test("labels parse as dimension to enum values", () => {
    const pack = parseSchemaPack(
      [
        BASE,
        "  labels:",
        "    - priority=low",
        "    - priority=high",
        "    - sensitivity=public",
      ].join("\n") + "\n",
    );
    expect(pack.labels).toEqual({
      priority: ["low", "high"],
      sensitivity: ["public"],
    });
  });

  test("label values are normalized and token-validated", () => {
    const pack = parseSchemaPack([BASE, "  labels:", "    - Priority=HIGH"].join("\n") + "\n");
    expect(pack.labels["priority"]).toEqual(["high"]);
    expect(() =>
      parseSchemaPack([BASE, "  labels:", "    - priority=not a token!"].join("\n") + "\n"),
    ).toThrow(/schema\.labels\.priority/);
  });

  test("link_constraints parse as link_type to source->target pairs", () => {
    const pack = parseSchemaPack(
      [
        BASE,
        "  link_constraints:",
        "    - depends_on=paper->paper",
        "    - depends_on=paper->person",
      ].join("\n") + "\n",
    );
    expect(pack.link_constraints).toEqual({
      depends_on: ["paper->paper", "paper->person"],
    });
  });

  test("malformed endpoint pairs fail closed with a path-qualified error", () => {
    expect(() =>
      parseSchemaPack([BASE, "  link_constraints:", "    - depends_on=paper"].join("\n") + "\n"),
    ).toThrow(/schema\.link_constraints\.depends_on.*source->target/);
    expect(() =>
      parseSchemaPack(
        [BASE, "  link_constraints:", "    - depends_on=pa per->note"].join("\n") + "\n",
      ),
    ).toThrow(/schema\.link_constraints\.depends_on/);
  });

  test("attributes parse as type.field to description", () => {
    const pack = parseSchemaPack(
      [
        BASE,
        "  attributes:",
        "    - paper.status=reading status, e.g. queued or finished",
        "    - paper.year=publication year as a 4-digit number",
      ].join("\n") + "\n",
    );
    expect(pack.attributes).toEqual({
      paper: {
        status: "reading status, e.g. queued or finished",
        year: "publication year as a 4-digit number",
      },
    });
  });

  test("attribute descriptions keep free text including = characters", () => {
    const pack = parseSchemaPack(
      [BASE, "  attributes:", "    - paper.rating=scale 1=worst to 5=best"].join("\n") + "\n",
    );
    expect(pack.attributes["paper"]!["rating"]).toBe("scale 1=worst to 5=best");
  });

  test("attribute keys without a type.field shape fail closed", () => {
    expect(() =>
      parseSchemaPack([BASE, "  attributes:", "    - status=loose description"].join("\n") + "\n"),
    ).toThrow(/schema\.attributes.*type\.field/);
  });

  test("frontmatter_tiers parse as kind.field to tier", () => {
    const pack = parseSchemaPack(
      [
        BASE,
        "  frontmatter_tiers:",
        "    - brain-preference.id=identity",
        "    - brain-preference.applied_count=system",
        "    - brain-preference.topic=business",
      ].join("\n") + "\n",
    );
    expect(pack.frontmatter_tiers).toEqual({
      "brain-preference": {
        id: "identity",
        applied_count: "system",
        topic: "business",
      },
    });
  });

  test("unknown tier names fail closed listing the allowed tiers", () => {
    expect(() =>
      parseSchemaPack(
        [BASE, "  frontmatter_tiers:", "    - brain-preference.id=readonly"].join("\n") + "\n",
      ),
    ).toThrow(/schema\.frontmatter_tiers.*identity/);
  });

  test("FRONTMATTER_TIERS exposes the four-level model", () => {
    expect([...FRONTMATTER_TIERS]).toEqual(["identity", "system", "business", "user"]);
  });
});

describe("renderSchemaBlock round-trip", () => {
  test("parse(render(pack)) preserves all ontology fields", () => {
    const text =
      [
        BASE,
        "  labels:",
        "    - priority=low",
        "    - priority=high",
        "  link_constraints:",
        "    - depends_on=paper->person",
        "  attributes:",
        "    - paper.status=reading status",
        "  frontmatter_tiers:",
        "    - brain-preference.id=identity",
      ].join("\n") + "\n";
    const pack = parseSchemaPack(text);
    const reparsed = parseSchemaPack("schema_version: 1\n" + renderSchemaBlock(pack));
    expect(reparsed.labels).toEqual(pack.labels);
    expect(reparsed.link_constraints).toEqual(pack.link_constraints);
    expect(reparsed.attributes).toEqual(pack.attributes);
    expect(reparsed.frontmatter_tiers).toEqual(pack.frontmatter_tiers);
  });
});

describe("ontology mutations", () => {
  const base = parseSchemaPack(BASE + "\n");

  test("add_label_dimension merges values; remove_label_dimension drops it", () => {
    const added = applyMutationsToPack(base, [
      { op: "add_label_dimension", dimension: "priority", values: ["low", "high"] },
      { op: "add_label_dimension", dimension: "priority", values: ["urgent"] },
    ]);
    expect(added.labels["priority"]).toEqual(["low", "high", "urgent"]);
    const removed = applyMutationsToPack(added, [
      { op: "remove_label_dimension", dimension: "priority" },
    ]);
    expect(removed.labels).toEqual({});
  });

  test("add_link_constraint requires a declared link type", () => {
    const ok = applyMutationsToPack(base, [
      { op: "add_link_constraint", link_type: "depends_on", source: "paper", target: "person" },
    ]);
    expect(ok.link_constraints["depends_on"]).toEqual(["paper->person"]);
    expect(() =>
      applyMutationsToPack(base, [
        { op: "add_link_constraint", link_type: "mystery", source: "paper", target: "person" },
      ]),
    ).toThrow(/link_constraints\.mystery.*not declared/);
  });

  test("remove_link_constraint drops one pair and prunes empty entries", () => {
    const added = applyMutationsToPack(base, [
      { op: "add_link_constraint", link_type: "depends_on", source: "paper", target: "person" },
    ]);
    const removed = applyMutationsToPack(added, [
      { op: "remove_link_constraint", link_type: "depends_on", source: "paper", target: "person" },
    ]);
    expect(removed.link_constraints).toEqual({});
  });

  test("set_attribute_field requires a declared type and single-line description", () => {
    const ok = applyMutationsToPack(base, [
      { op: "set_attribute_field", type: "paper", field: "status", description: "reading status" },
    ]);
    expect(ok.attributes["paper"]!["status"]).toBe("reading status");
    expect(() =>
      applyMutationsToPack(base, [
        { op: "set_attribute_field", type: "ghost", field: "status", description: "x" },
      ]),
    ).toThrow(/attributes\.ghost.*not declared/);
    expect(() =>
      applyMutationsToPack(base, [
        { op: "set_attribute_field", type: "paper", field: "status", description: "a\nb" },
      ]),
    ).toThrow(/single line/);
  });

  test("remove_attribute_field prunes empty type maps", () => {
    const added = applyMutationsToPack(base, [
      { op: "set_attribute_field", type: "paper", field: "status", description: "reading status" },
    ]);
    const removed = applyMutationsToPack(added, [
      { op: "remove_attribute_field", type: "paper", field: "status" },
    ]);
    expect(removed.attributes).toEqual({});
  });

  test("set_frontmatter_tier validates the tier; remove prunes empty kinds", () => {
    const added = applyMutationsToPack(base, [
      { op: "set_frontmatter_tier", kind: "brain-preference", field: "id", tier: "identity" },
    ]);
    expect(added.frontmatter_tiers["brain-preference"]!["id"]).toBe("identity");
    expect(() =>
      applyMutationsToPack(base, [
        {
          op: "set_frontmatter_tier",
          kind: "brain-preference",
          field: "id",
          tier: "readonly",
        } as unknown as SchemaMutation,
      ]),
    ).toThrow(/frontmatter_tiers.*identity/);
    const removed = applyMutationsToPack(added, [
      { op: "remove_frontmatter_tier", kind: "brain-preference", field: "id" },
    ]);
    expect(removed.frontmatter_tiers).toEqual({});
  });

  test("remove_link_type also drops its constraints", () => {
    const added = applyMutationsToPack(base, [
      { op: "add_link_constraint", link_type: "depends_on", source: "paper", target: "person" },
    ]);
    const removed = applyMutationsToPack(added, [{ op: "remove_link_type", token: "depends_on" }]);
    expect(removed.link_constraints).toEqual({});
  });

  test("remove_type drops the type's attributes alongside extractable/aliases", () => {
    const added = applyMutationsToPack(base, [
      { op: "add_type", category: "page_types", token: "book" },
      { op: "set_attribute_field", type: "book", field: "author", description: "who wrote it" },
    ]);
    const removed = applyMutationsToPack(added, [
      { op: "remove_type", category: "page_types", token: "book" },
    ]);
    expect(removed.attributes).toEqual({});
  });
});

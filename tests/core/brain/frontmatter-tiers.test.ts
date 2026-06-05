/**
 * Tiered frontmatter field protection (t_3f92d3f1), part 1: the tier
 * model and the tier-respecting merge. Four tiers - identity (join
 * keys; hand-edit = corruption), system (framework bookkeeping),
 * business (agent-written domain fields), user (freely editable).
 * Resolution: schema-pack override > built-in framework defaults >
 * user. The merge preserves user fields a framework write does not
 * own and refuses to change an identity value unless explicitly told
 * to. Unknown kinds resolve everything to user - a human's own vault
 * is never constrained.
 */

import { describe, expect, test } from "bun:test";

import {
  FrontmatterTierConflictError,
  mergeFrontmatterTiered,
  resolveFieldTier,
  tieredFieldsForKind,
} from "../../../src/core/brain/frontmatter-tiers.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";

const EMPTY_PACK = parseSchemaPack("schema_version: 1\n");

const OVERRIDE_PACK = parseSchemaPack(
  [
    "schema_version: 1",
    "schema:",
    "  frontmatter_tiers:",
    "    - brain-preference.topic=user",
    "    - recipe.id=identity",
  ].join("\n") + "\n",
);

describe("resolveFieldTier", () => {
  test("identity join keys of framework kinds are built-in", () => {
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "kind")).toBe("identity");
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "id")).toBe("identity");
    expect(resolveFieldTier(EMPTY_PACK, "brain-entity", "entity_id")).toBe("identity");
    expect(resolveFieldTier(EMPTY_PACK, "brain-entity", "category")).toBe("identity");
  });

  test("underscore-prefixed fields of framework kinds are system", () => {
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "_status")).toBe("system");
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "_confidence_value")).toBe("system");
  });

  test("known bookkeeping fields are system, domain fields business", () => {
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "created_at")).toBe("system");
    expect(resolveFieldTier(EMPTY_PACK, "brain-entity", "updated_at")).toBe("system");
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "topic")).toBe("business");
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "principle")).toBe("business");
  });

  test("undeclared fields and unknown kinds default to user", () => {
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "pinned")).toBe("user");
    expect(resolveFieldTier(EMPTY_PACK, "brain-preference", "my-custom-note")).toBe("user");
    expect(resolveFieldTier(EMPTY_PACK, "shopping-list", "id")).toBe("user");
  });

  test("schema-pack overrides win over built-ins and add new kinds", () => {
    expect(resolveFieldTier(OVERRIDE_PACK, "brain-preference", "topic")).toBe("user");
    expect(resolveFieldTier(OVERRIDE_PACK, "recipe", "id")).toBe("identity");
  });

  test("tieredFieldsForKind lists protected fields for the drift check", () => {
    const fields = tieredFieldsForKind(EMPTY_PACK, "brain-preference");
    expect(fields["kind"]).toBe("identity");
    expect(fields["created_at"]).toBe("system");
    expect(fields["topic"]).toBe("business");
    expect(fields["pinned"]).toBeUndefined();
    expect(tieredFieldsForKind(EMPTY_PACK, "shopping-list")).toEqual({});
  });
});

describe("mergeFrontmatterTiered", () => {
  const existing = {
    kind: "brain-preference",
    id: "pref-spaces",
    created_at: "2026-05-01T00:00:00Z",
    topic: "style",
    principle: "Use spaces",
    favorite_quote: "tabs are history",
  };

  test("a user field the framework write does not own survives", () => {
    const merged = mergeFrontmatterTiered(
      existing,
      {
        kind: "brain-preference",
        id: "pref-spaces",
        created_at: "2026-05-01T00:00:00Z",
        topic: "style",
        principle: "Use spaces, always",
      },
      { kind: "brain-preference", pack: EMPTY_PACK },
    );
    expect(merged["favorite_quote"]).toBe("tabs are history");
    expect(merged["principle"]).toBe("Use spaces, always");
  });

  test("changing an identity value is refused with both values named", () => {
    expect(() =>
      mergeFrontmatterTiered(
        existing,
        { kind: "brain-preference", id: "pref-other", topic: "style" },
        { kind: "brain-preference", pack: EMPTY_PACK },
      ),
    ).toThrow(FrontmatterTierConflictError);
    expect(() =>
      mergeFrontmatterTiered(
        existing,
        { kind: "brain-preference", id: "pref-other", topic: "style" },
        { kind: "brain-preference", pack: EMPTY_PACK },
      ),
    ).toThrow(/id.*pref-spaces.*pref-other/);
  });

  test("acceptIdentity lets an explicit migration change the join key", () => {
    const merged = mergeFrontmatterTiered(
      existing,
      { kind: "brain-preference", id: "pref-other" },
      { kind: "brain-preference", pack: EMPTY_PACK, acceptIdentity: true },
    );
    expect(merged["id"]).toBe("pref-other");
  });

  test("unknown kinds merge exactly like a plain spread", () => {
    const merged = mergeFrontmatterTiered(
      { id: "anything", note: "mine" },
      { id: "changed" },
      { kind: "shopping-list", pack: EMPTY_PACK },
    );
    expect(merged).toEqual({ id: "changed", note: "mine" });
  });

  test("equal identity values pass without conflict", () => {
    const merged = mergeFrontmatterTiered(
      existing,
      { kind: "brain-preference", id: "pref-spaces", topic: "style-v2" },
      { kind: "brain-preference", pack: EMPTY_PACK },
    );
    expect(merged["topic"]).toBe("style-v2");
  });
});

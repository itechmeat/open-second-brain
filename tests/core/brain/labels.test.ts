/**
 * Controlled-vocabulary labels (t_7a41f42d): the schema pack declares
 * label dimensions with allowed values; assignment is fail-closed
 * (unknown dimension or value rejected with the vocabulary in the
 * error), one value per dimension per note, stored as a sorted
 * `labels: [dim/value]` frontmatter array plus a canonical
 * `label` entity in the registry for clustering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { listEntities } from "../../../src/core/brain/entities/registry.ts";
import {
  assignNoteLabel,
  LabelVocabularyError,
  labelToken,
  removeNoteLabel,
  validateLabelAssignment,
} from "../../../src/core/brain/labels.ts";
import { parseSchemaPack } from "../../../src/core/brain/schema-pack.ts";
import { parseFrontmatter } from "../../../src/core/vault.ts";

const PACK = parseSchemaPack(
  [
    "schema_version: 1",
    "schema:",
    "  labels:",
    "    - priority=low",
    "    - priority=high",
    "    - sensitivity=public",
    "    - sensitivity=private",
  ].join("\n") + "\n",
);

const EMPTY_PACK = parseSchemaPack("schema_version: 1\n");

const NOW = new Date("2026-06-04T10:00:00Z");

describe("validateLabelAssignment", () => {
  test("normalizes and accepts declared dimension/value pairs", () => {
    expect(validateLabelAssignment(PACK, " Priority ", "HIGH")).toEqual({
      dimension: "priority",
      value: "high",
      token: "priority/high",
    });
  });

  test("unknown dimension fails closed listing declared dimensions", () => {
    expect(() => validateLabelAssignment(PACK, "mood", "high")).toThrow(LabelVocabularyError);
    expect(() => validateLabelAssignment(PACK, "mood", "high")).toThrow(
      /mood.*declared dimensions: priority, sensitivity/,
    );
  });

  test("unknown value fails closed listing the allowed vocabulary", () => {
    expect(() => validateLabelAssignment(PACK, "priority", "urgent")).toThrow(
      /priority.*allowed values: low, high/,
    );
  });

  test("a pack without labels rejects every assignment", () => {
    expect(() => validateLabelAssignment(EMPTY_PACK, "priority", "high")).toThrow(
      /no label dimensions are declared/,
    );
  });

  test("labelToken renders the canonical dim/value form", () => {
    expect(labelToken("priority", "high")).toBe("priority/high");
  });
});

describe("assignNoteLabel / removeNoteLabel", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "o2b-labels-"));
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "notes", "rollout.md"),
      "---\ntitle: Rollout\n---\n\n# Rollout\n\nCanary first.\n",
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("assignment writes a sorted labels array and preserves body and keys", () => {
    const result = assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "sensitivity",
      value: "private",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(result.labels).toEqual(["sensitivity/private"]);
    const [fm, body] = parseFrontmatter(join(vault, "Brain", "notes", "rollout.md"));
    expect(fm["labels"]).toEqual(["priority/high", "sensitivity/private"]);
    expect(fm["title"]).toBe("Rollout");
    expect(body).toContain("Canary first.");
  });

  test("one value per dimension - reassignment replaces, idempotent repeat", () => {
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "low",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    const replaced = assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(replaced.labels).toEqual(["priority/high"]);
    const again = assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(again.labels).toEqual(["priority/high"]);
    expect(again.changed).toBe(false);
  });

  test("assignment registers a canonical label entity for clustering", () => {
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    const entities = listEntities(vault, { category: "label" });
    expect(entities).toHaveLength(1);
    expect(entities[0]!.name).toBe("priority/high");
  });

  test("invalid assignment never touches the file", () => {
    expect(() =>
      assignNoteLabel(vault, "Brain/notes/rollout.md", {
        dimension: "priority",
        value: "urgent",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(LabelVocabularyError);
    const [fm] = parseFrontmatter(join(vault, "Brain", "notes", "rollout.md"));
    expect(fm["labels"]).toBeUndefined();
  });

  test("a missing note fails with a clear error", () => {
    expect(() =>
      assignNoteLabel(vault, "Brain/notes/ghost.md", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(/does not exist/);
  });

  test("removal drops one dimension and reports whether it was present", () => {
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "sensitivity",
      value: "public",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    const removed = removeNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      pack: PACK,
    });
    expect(removed.removed).toBe(true);
    expect(removed.labels).toEqual(["sensitivity/public"]);
    const again = removeNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      pack: PACK,
    });
    expect(again.removed).toBe(false);
    const [fm] = parseFrontmatter(join(vault, "Brain", "notes", "rollout.md"));
    expect(fm["labels"]).toEqual(["sensitivity/public"]);
  });

  test("removing the last label drops the labels key entirely", () => {
    assignNoteLabel(vault, "Brain/notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    removeNoteLabel(vault, "Brain/notes/rollout.md", { dimension: "priority", pack: PACK });
    const [fm] = parseFrontmatter(join(vault, "Brain", "notes", "rollout.md"));
    expect(fm["labels"]).toBeUndefined();
  });

  test("path traversal outside the vault is refused", () => {
    expect(() =>
      assignNoteLabel(vault, "../outside.md", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(/outside the vault/);
  });
});

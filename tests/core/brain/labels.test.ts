/**
 * Controlled-vocabulary labels (t_7a41f42d): the schema pack declares
 * label dimensions with allowed values; assignment is fail-closed
 * (unknown dimension or value rejected with the vocabulary in the
 * error), one value per dimension per note, stored as a sorted
 * `labels: [dim/value]` frontmatter array plus a canonical
 * `label` entity in the registry for clustering.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "rollout.md"),
      "---\ntitle: Rollout\n---\n\n# Rollout\n\nCanary first.\n",
    );
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  test("assignment writes a sorted labels array and preserves body and keys", () => {
    const result = assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "sensitivity",
      value: "private",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(result.labels).toEqual(["sensitivity/private"]);
    const [fm, body] = parseFrontmatter(join(vault, "Notes", "rollout.md"));
    expect(fm["labels"]).toEqual(["priority/high", "sensitivity/private"]);
    expect(fm["title"]).toBe("Rollout");
    expect(body).toContain("Canary first.");
  });

  test("one value per dimension - reassignment replaces, idempotent repeat", () => {
    assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      value: "low",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    const replaced = assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(replaced.labels).toEqual(["priority/high"]);
    const again = assignNoteLabel(vault, "Notes/rollout.md", {
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
    assignNoteLabel(vault, "Notes/rollout.md", {
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
      assignNoteLabel(vault, "Notes/rollout.md", {
        dimension: "priority",
        value: "urgent",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(LabelVocabularyError);
    const [fm] = parseFrontmatter(join(vault, "Notes", "rollout.md"));
    expect(fm["labels"]).toBeUndefined();
  });

  test("a missing note fails with a clear error", () => {
    expect(() =>
      assignNoteLabel(vault, "Notes/ghost.md", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(/does not exist/);
  });

  test("removal drops one dimension and reports whether it was present", () => {
    assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "sensitivity",
      value: "public",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    const removed = removeNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      pack: PACK,
    });
    expect(removed.removed).toBe(true);
    expect(removed.labels).toEqual(["sensitivity/public"]);
    const again = removeNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      pack: PACK,
    });
    expect(again.removed).toBe(false);
    const [fm] = parseFrontmatter(join(vault, "Notes", "rollout.md"));
    expect(fm["labels"]).toEqual(["sensitivity/public"]);
  });

  test("removing the last label drops the labels key entirely", () => {
    assignNoteLabel(vault, "Notes/rollout.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    removeNoteLabel(vault, "Notes/rollout.md", { dimension: "priority", pack: PACK });
    const [fm] = parseFrontmatter(join(vault, "Notes", "rollout.md"));
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

  test("the write binding's own config is not writable through labels (t_sec_labels_governance)", () => {
    // A governance surface that could rewrite `Brain/_brain.yaml` would
    // not be governed: a label write over it would fail-closed the whole
    // caller-named write boundary until an operator repairs the file.
    mkdirSync(join(vault, "Brain"), { recursive: true });
    const configPath = join(vault, "Brain", "_brain.yaml");
    writeFileSync(configPath, "schema_version: 1\n", "utf8");
    expect(() =>
      assignNoteLabel(vault, "Brain/_brain.yaml", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(/config/);
    expect(() =>
      removeNoteLabel(vault, "Brain/_brain.yaml", { dimension: "priority", pack: PACK }),
    ).toThrow(/config/);
    expect(readFileSync(configPath, "utf8")).toBe("schema_version: 1\n");
  });

  test("Brain machinery and non-note files are refused with no binding declared", () => {
    // Without a declared binding the only wall used to be the config's
    // name: a label write could rewrite the vault identity marker (and so
    // disable the identity guard) or the search provider registry.
    mkdirSync(join(vault, "Brain", "search"), { recursive: true });
    mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
    const targets: Record<string, string> = {
      "Brain/vault-id.json": '{"id":"v"}\n',
      "Brain/search/embedding-providers.json": "{}\n",
      "Brain/preferences/pref-x.md": "---\nid: pref-x\n---\nbody\n",
      "brain/preferences/pref-x.md": "",
      "_vault-map.yaml": "roles: {}\n",
    };
    for (const [rel, content] of Object.entries(targets)) {
      if (content !== "") writeFileSync(join(vault, rel), content, "utf8");
    }
    for (const rel of Object.keys(targets)) {
      const opts = { dimension: "priority", value: "high", pack: PACK, agent: "t", now: NOW };
      expect(() => assignNoteLabel(vault, rel, opts)).toThrow(
        /Brain machinery|not a Markdown note/,
      );
      expect(() => removeNoteLabel(vault, rel, { dimension: "priority", pack: PACK })).toThrow(
        /Brain machinery|not a Markdown note/,
      );
    }
    for (const [rel, content] of Object.entries(targets)) {
      if (content !== "") expect(readFileSync(join(vault, rel), "utf8")).toBe(content);
    }
    // The Brain page lanes hold notes, and stay labelable.
    mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
    writeFileSync(join(vault, "Brain", "sources", "src-paper.md"), "---\ntitle: P\n---\nb\n");
    const ok = assignNoteLabel(vault, "Brain/sources/src-paper.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "t",
      now: NOW,
    });
    expect(ok.labels).toEqual(["priority/high"]);
  });

  // The binding matcher splits on `/`; the native `relative()` form on
  // Windows is backslash-separated, which refused every write there once
  // a binding was declared. Only Windows produces that form, so only
  // Windows can exercise it; the prefix test below covers it too there.
  test.skipIf(process.platform !== "win32")(
    "a backslash-spelled target inside a declared binding is admitted on Windows",
    () => {
      mkdirSync(join(vault, "Brain"), { recursive: true });
      writeFileSync(
        join(vault, "Brain", "_brain.yaml"),
        "schema_version: 1\nwrite_binding:\n  path_prefixes:\n    - Projects/Active\n",
        "utf8",
      );
      mkdirSync(join(vault, "Projects", "Active"), { recursive: true });
      writeFileSync(join(vault, "Projects", "Active", "plan.md"), "---\ntitle: P\n---\nb\n");
      const ok = assignNoteLabel(vault, "Projects\\Active\\plan.md", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "t",
        now: NOW,
      });
      expect(ok.labels).toEqual(["priority/high"]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a vault note that is a symlink into Brain machinery is refused",
    () => {
      mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
      const pref = join(vault, "Brain", "preferences", "pref-x.md");
      writeFileSync(pref, "---\nid: pref-x\n---\nbody\n", "utf8");
      mkdirSync(join(vault, "Notes"), { recursive: true });
      symlinkSync(pref, join(vault, "Notes", "alias.md"));
      expect(() =>
        assignNoteLabel(vault, "Notes/alias.md", {
          dimension: "priority",
          value: "high",
          pack: PACK,
          agent: "t",
          now: NOW,
        }),
      ).toThrow(/resolves to Brain\/preferences\/pref-x\.md/);
      expect(readFileSync(pref, "utf8")).toBe("---\nid: pref-x\n---\nbody\n");
    },
  );

  test("a declared write binding refuses targets outside its prefixes", () => {
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(
      join(vault, "Notes", "rollout.md"),
      "---\ntitle: Rollout\n---\n\nCanary first.\n",
      "utf8",
    );
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nwrite_binding:\n  path_prefixes:\n    - Projects\n",
      "utf8",
    );
    expect(() =>
      assignNoteLabel(vault, "Notes/rollout.md", {
        dimension: "priority",
        value: "high",
        pack: PACK,
        agent: "tester",
        now: NOW,
      }),
    ).toThrow(/write binding/i);
    const [fm] = parseFrontmatter(join(vault, "Notes", "rollout.md"));
    expect(fm["labels"]).toBeUndefined();
    // Inside the declared prefix the same write succeeds.
    mkdirSync(join(vault, "Projects"), { recursive: true });
    writeFileSync(join(vault, "Projects", "plan.md"), "---\ntitle: Plan\n---\nbody\n", "utf8");
    const ok = assignNoteLabel(vault, "Projects/plan.md", {
      dimension: "priority",
      value: "high",
      pack: PACK,
      agent: "tester",
      now: NOW,
    });
    expect(ok.changed).toBe(true);
  });
});

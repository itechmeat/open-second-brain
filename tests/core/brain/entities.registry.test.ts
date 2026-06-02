import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { buildEntityIndex } from "../../../src/core/brain/entities/index-builder.ts";
import {
  archiveEntity,
  getEntity,
  listEntities,
  relateEntities,
  upsertEntity,
} from "../../../src/core/brain/entities/registry.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-02T12:00:00Z");
const LATER = new Date("2026-06-02T13:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-entities-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-entities-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedSergey() {
  return upsertEntity(vault, {
    category: "people",
    name: "Sergey",
    aliases: ["Серёжа", "S.E."],
    agent: "claude-dev-agent",
    now: NOW,
  });
}

describe("upsertEntity", () => {
  test("creates a Markdown entity file under Brain/entities/<category>/", () => {
    const { entity, created } = seedSergey();
    expect(created).toBe(true);
    expect(entity.id).toBe("ent-people-sergey");
    expect(entity.path).toContain(join("Brain", "entities", "people", "ent-people-sergey.md"));
    expect(existsSync(entity.path)).toBe(true);
    const raw = readFileSync(entity.path, "utf8");
    expect(raw).toContain("kind: brain-entity");
    expect(raw).toContain("name: Sergey");
    expect(raw.startsWith("---\n")).toBe(true);
  });

  test("is idempotent: same input updates in place, never duplicates", () => {
    seedSergey();
    const second = upsertEntity(vault, {
      category: "people",
      name: "sergey", // case variant resolves to the same identity
      agent: "claude-dev-agent",
      now: LATER,
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe("ent-people-sergey");
    expect(listEntities(vault)).toHaveLength(1);
  });

  test("upsert via an alias updates the canonical entity", () => {
    seedSergey();
    const viaAlias = upsertEntity(vault, {
      category: "people",
      name: "Серёжа",
      agent: "claude-dev-agent",
      now: LATER,
      body: "## Current state\nOperator of the vault.",
    });
    expect(viaAlias.created).toBe(false);
    expect(viaAlias.entity.id).toBe("ent-people-sergey");
    expect(viaAlias.entity.name).toBe("Sergey");
    expect(readFileSync(viaAlias.entity.path, "utf8")).toContain("Operator of the vault.");
  });

  test("merges new aliases into the existing set", () => {
    seedSergey();
    const updated = upsertEntity(vault, {
      category: "people",
      name: "Sergey",
      aliases: ["the operator"],
      agent: "claude-dev-agent",
      now: LATER,
    });
    expect(updated.entity.aliases).toContain("Серёжа");
    expect(updated.entity.aliases).toContain("the operator");
  });

  test("refuses an alias already claimed by another active entity in the category", () => {
    seedSergey();
    expect(() =>
      upsertEntity(vault, {
        category: "people",
        name: "Sergei Petrov",
        aliases: ["Серёжа"],
        agent: "claude-dev-agent",
        now: LATER,
      }),
    ).toThrow(/alias/i);
  });

  test("same name in a different category is a distinct entity", () => {
    seedSergey();
    const sys = upsertEntity(vault, {
      category: "systems",
      name: "Sergey",
      agent: "claude-dev-agent",
      now: NOW,
    });
    expect(sys.created).toBe(true);
    expect(sys.entity.id).toBe("ent-systems-sergey");
    expect(listEntities(vault)).toHaveLength(2);
  });

  test("distinct names mapping to one file slug get a suffixed filename", () => {
    const a = upsertEntity(vault, {
      category: "projects",
      name: "Foo Bar",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const b = upsertEntity(vault, {
      category: "projects",
      name: "Foo/Bar", // different identity, same slugified stem
      agent: "claude-dev-agent",
      now: NOW,
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.entity.id).not.toBe(b.entity.id);
    expect(listEntities(vault)).toHaveLength(2);
  });

  test("rejects empty names", () => {
    expect(() =>
      upsertEntity(vault, {
        category: "people",
        name: "   ",
        agent: "claude-dev-agent",
        now: NOW,
      }),
    ).toThrow(/name/i);
  });
});

describe("getEntity", () => {
  test("resolves by canonical name, case-insensitively", () => {
    seedSergey();
    const hit = getEntity(vault, { category: "people", query: "SERGEY" });
    expect(hit?.id).toBe("ent-people-sergey");
  });

  test("resolves by alias", () => {
    seedSergey();
    const hit = getEntity(vault, { category: "people", query: "s.e." });
    expect(hit?.id).toBe("ent-people-sergey");
  });

  test("resolves without category when unambiguous", () => {
    seedSergey();
    const hit = getEntity(vault, { query: "Серёжа" });
    expect(hit?.id).toBe("ent-people-sergey");
  });

  test("returns null for unknown names", () => {
    seedSergey();
    expect(getEntity(vault, { category: "people", query: "nobody" })).toBeNull();
  });
});

describe("listEntities", () => {
  test("filters by category and sorts by id", () => {
    seedSergey();
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const all = listEntities(vault);
    expect(all.map((e) => e.id)).toEqual(["ent-people-sergey", "ent-projects-open-second-brain"]);
    const people = listEntities(vault, { category: "people" });
    expect(people).toHaveLength(1);
  });
});

describe("relateEntities", () => {
  test("writes a typed relation edge readable from frontmatter", () => {
    seedSergey();
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const updated = relateEntities(vault, {
      from: { category: "people", query: "Sergey" },
      relation: "related",
      to: { category: "projects", query: "Open Second Brain" },
      now: LATER,
    });
    expect(updated.relations).toEqual([
      { relation: "related", target: "ent-projects-open-second-brain" },
    ]);
    const raw = readFileSync(updated.path, "utf8");
    expect(raw).toContain("ent-projects-open-second-brain");
  });

  test("rejects relations outside the known vocabulary", () => {
    seedSergey();
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      agent: "claude-dev-agent",
      now: NOW,
    });
    expect(() =>
      relateEntities(vault, {
        from: { category: "people", query: "Sergey" },
        relation: "loves",
        to: { category: "projects", query: "Open Second Brain" },
        now: LATER,
      }),
    ).toThrow(/relation/i);
  });

  test("relating twice is idempotent", () => {
    seedSergey();
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      agent: "claude-dev-agent",
      now: NOW,
    });
    const args = {
      from: { category: "people", query: "Sergey" },
      relation: "related",
      to: { category: "projects", query: "Open Second Brain" },
      now: LATER,
    } as const;
    relateEntities(vault, args);
    const second = relateEntities(vault, args);
    expect(second.relations).toHaveLength(1);
  });
});

describe("archiveEntity", () => {
  test("removes the entity from active lookup but keeps the file", () => {
    const { entity } = seedSergey();
    const archived = archiveEntity(vault, { category: "people", query: "Sergey" }, { now: LATER });
    expect(archived.status).toBe("archived");
    expect(archived.archived_at).toBe("2026-06-02T13:00:00Z");
    expect(existsSync(entity.path)).toBe(true);
    expect(getEntity(vault, { category: "people", query: "Sergey" })).toBeNull();
    expect(listEntities(vault, { status: "archived" })).toHaveLength(1);
  });

  test("restore returns the entity to active lookup", () => {
    seedSergey();
    archiveEntity(vault, { category: "people", query: "Sergey" }, { now: LATER });
    const restored = archiveEntity(
      vault,
      { category: "people", query: "Sergey" },
      { now: LATER, restore: true },
    );
    expect(restored.status).toBe("active");
    expect(restored.archived_at).toBeUndefined();
    expect(getEntity(vault, { category: "people", query: "Sergey" })?.id).toBe("ent-people-sergey");
  });

  test("upsert refuses a name held by an archived entity and names the remedy", () => {
    seedSergey();
    archiveEntity(vault, { category: "people", query: "Sergey" }, { now: LATER });
    expect(() => seedSergey()).toThrow(/archived/i);
  });
});

describe("buildEntityIndex", () => {
  test("rebuilds identically from the Markdown files alone", () => {
    seedSergey();
    upsertEntity(vault, {
      category: "projects",
      name: "Open Second Brain",
      aliases: ["o2b vault"],
      agent: "claude-dev-agent",
      now: NOW,
    });
    const first = buildEntityIndex(vault);
    const second = buildEntityIndex(vault);
    expect(second.entities.map((e) => e.id)).toEqual(first.entities.map((e) => e.id));
    expect([...second.byAlias.keys()].toSorted()).toEqual([...first.byAlias.keys()].toSorted());
    expect(first.byKey.get("people:sergey")?.id).toBe("ent-people-sergey");
    expect(first.byAlias.get("o2b vault")?.id).toBe("ent-projects-open-second-brain");
  });

  test("reports duplicate identity claims from hand-authored files as conflicts", () => {
    const { entity } = seedSergey();
    // Simulate a sync/hand-edit duplicate claiming the same (category, name).
    const dupPath = join(entity.path, "..", "ent-people-sergey-dup.md");
    atomicWriteFileSync(
      dupPath,
      [
        "---",
        "kind: brain-entity",
        "entity_id: ent-people-sergey-dup",
        "category: people",
        "name: sergey",
        "status: active",
        "created_at: 2026-06-02T12:30:00Z",
        "updated_at: 2026-06-02T12:30:00Z",
        "---",
        "",
        "# sergey",
        "",
      ].join("\n"),
    );
    const index = buildEntityIndex(vault);
    expect(index.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(index.conflicts[0]!.kind).toBe("duplicate-name");
    expect(index.conflicts[0]!.paths).toHaveLength(2);
  });

  test("skips malformed entity files without aborting the walk", () => {
    const { entity } = seedSergey();
    atomicWriteFileSync(join(entity.path, "..", "broken.md"), "not frontmatter at all");
    const index = buildEntityIndex(vault);
    expect(index.entities).toHaveLength(1);
  });
});

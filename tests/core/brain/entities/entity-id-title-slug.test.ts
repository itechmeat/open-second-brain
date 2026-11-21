/**
 * Entity ids keep letters of any script, and an entity minted under the
 * old Latin-only id keeps that id.
 *
 * Before, the id was `ent-<category>-<slugify(name)>`: "Иван Петров" was
 * `ent-people-unnamed-<hash>` and "Анна Smith" `ent-people-smith`. New
 * entities take `titleSlug`. An existing entity is found by its name key
 * and aliases before any id is minted, and its id is never re-derived, so
 * a write of the same name updates the old-id record rather than minting
 * a second one under the new id.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { slugify } from "../../../../src/core/vault.ts";

const NOW = new Date("2026-07-01T10:00:00Z");
let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-entity-slug-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function upsert(name: string, now = NOW) {
  return upsertEntity(vault, { category: "people", name, agent: "tester", now });
}

function peopleDir(): string {
  return join(vault, "Brain", "entities", "people");
}

/** Mint `name`, then move it to the id an older release gave it. */
function storeUnderOldId(name: string): string {
  const { entity } = upsert(name);
  const oldId = `ent-people-${slugify(name)}`;
  const text = readFileSync(entity.path, "utf8").replaceAll(entity.id, oldId);
  writeFileSync(join(peopleDir(), `${oldId}.md`), text, "utf8");
  rmSync(entity.path);
  return oldId;
}

describe("entity ids of non-Latin names", () => {
  for (const [name, id] of [
    ["Иван Петров", "ent-people-иван-петров"],
    ["Анна Smith", "ent-people-анна-smith"],
    ["王小明", "ent-people-王小明"],
  ] as const) {
    test(`a new entity keeps the name's words in its id (${name})`, () => {
      expect(upsert(name).entity.id).toBe(id);
    });
  }

  test("an ASCII device name keeps the id it always had", () => {
    // An id is never a bare file name, so it takes no device suffix.
    expect(upsert("Con").entity.id).toBe("ent-people-con");
  });

  test("two names that share only their Latin words take two plain ids", () => {
    expect(upsert("Анна Smith").entity.id).toBe("ent-people-анна-smith");
    expect(upsert("Мария Smith").entity.id).toBe("ent-people-мария-smith");
  });
});

describe("an entity minted under its old Latin-only id", () => {
  for (const name of ["Иван Петров", "王小明"]) {
    test(`a write of the same name updates it, never mints a second id (${name})`, () => {
      const oldId = storeUnderOldId(name);
      const again = upsert(name, new Date("2026-07-02T10:00:00Z"));
      expect(again.created).toBe(false);
      expect(again.entity.id).toBe(oldId);
      expect(readdirSync(peopleDir()).filter((n) => n.endsWith(".md"))).toEqual([`${oldId}.md`]);
    });
  }
});

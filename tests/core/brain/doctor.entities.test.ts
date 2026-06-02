import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { relateEntities, upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-02T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function entityFile(name: string, lines: string[]): void {
  atomicWriteFileSync(join(brainDirs(vault).entities, "people", name), lines.join("\n") + "\n");
}

describe("doctor entity lints", () => {
  test("clean registry produces no entity issues", () => {
    upsertEntity(vault, { category: "people", name: "Sergey", agent: "a", now: NOW });
    const out = runDoctor(vault);
    const all = [...out.warnings, ...out.errors];
    expect(all.filter((i) => i.code.includes("entity"))).toEqual([]);
  });

  test("duplicate identity claims surface as duplicate-entity warnings", () => {
    upsertEntity(vault, { category: "people", name: "Sergey", agent: "a", now: NOW });
    entityFile("ent-people-sergey-dup.md", [
      "---",
      "kind: brain-entity",
      "entity_id: ent-people-sergey-dup",
      "category: people",
      "name: SERGEY",
      "status: active",
      "created_at: 2026-06-02T12:30:00Z",
      "updated_at: 2026-06-02T12:30:00Z",
      "---",
      "",
      "# dup",
    ]);
    const out = runDoctor(vault);
    const dup = out.warnings.filter((i) => i.code === "duplicate-entity");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.severity).toBe("warning");
    expect(dup[0]!.message).toContain("people:sergey");
  });

  test("a relation pointing at a missing entity surfaces as broken-entity-relation", () => {
    upsertEntity(vault, { category: "people", name: "Sergey", agent: "a", now: NOW });
    upsertEntity(vault, { category: "projects", name: "Open Second Brain", agent: "a", now: NOW });
    relateEntities(vault, {
      from: { category: "people", query: "Sergey" },
      relation: "related",
      to: { category: "projects", query: "Open Second Brain" },
      now: NOW,
    });
    // Healthy relation: no issue.
    expect(runDoctor(vault).warnings.filter((i) => i.code === "broken-entity-relation")).toEqual(
      [],
    );

    // Hand-author a relation to a non-existent entity.
    entityFile("ent-people-orphan.md", [
      "---",
      "kind: brain-entity",
      "entity_id: ent-people-orphan",
      "category: people",
      "name: Orphan Author",
      "status: active",
      "created_at: 2026-06-02T12:30:00Z",
      "updated_at: 2026-06-02T12:30:00Z",
      'related: ["[[ent-systems-ghost]]"]',
      "---",
      "",
      "# orphan",
    ]);
    const broken = runDoctor(vault).warnings.filter((i) => i.code === "broken-entity-relation");
    expect(broken).toHaveLength(1);
    expect(broken[0]!.message).toContain("ent-systems-ghost");
  });
});

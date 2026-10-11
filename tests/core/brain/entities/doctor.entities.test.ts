/**
 * Recall-quality A3: the doctor surfaces the lexicon-refused stored labels
 * under the EXISTING `entity-label-malformed` warning with the EXISTING
 * `o2b brain entity prune` remedy - no new repair command, no new code.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../../src/core/vault.ts";
import { brainDirs } from "../../../../src/core/brain/paths.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import { __clearEntityIndexCache } from "../../../../src/core/brain/entities/index-builder.ts";
import {
  deriveEntityLexicon,
  writeEntityLexicon,
  __clearEntityLexiconCache,
} from "../../../../src/core/brain/entities/lexicon.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-doctor-entities-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  __clearEntityIndexCache();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityIndexCache();
  __clearEntityLexiconCache();
});

/** Write an entity node file directly, bypassing the creation quality gate. */
function writeEntityNode(category: string, id: string, name: string): string {
  const dir = join(brainDirs(vault).entities, category);
  const path = join(dir, `${id}.md`);
  writeFrontmatterAtomic(
    path,
    {
      kind: "brain-entity",
      entity_id: id,
      category,
      name,
      status: "active",
      created_at: "2026-07-18T00:00:00Z",
      updated_at: "2026-07-18T00:00:00Z",
      tags: ["brain", "brain/entity"],
    },
    `# ${name}`,
    { overwrite: true },
  );
  __clearEntityIndexCache();
  return path;
}

/** Teach the lexicon from one corpus page, then rebuild the artifact. */
function seedLexicon(corpus: string): void {
  atomicWriteFileSync(join(vault, "corpus-page.md"), `${corpus}\n`);
  writeEntityLexicon(vault, deriveEntityLexicon(vault, { now: NOW }));
}

describe("doctor entity-label-malformed - lexicon reasons (recall-quality A3)", () => {
  test("surfaces a stored common-word run with the existing prune remedy", () => {
    writeEntityNode("people", "ent-people-junk", "The Of And");
    seedLexicon("the of and the Of and.");
    const doctor = runDoctor(vault);
    const lint = doctor.warnings.filter((i) => i.code === "entity-label-malformed");
    expect(lint).toHaveLength(1);
    expect(lint[0]!.severity).toBe("warning");
    expect(lint[0]!.message).toContain("ent-people-junk");
    expect(lint[0]!.message).toContain("function-word-run");
    // The remedy is the EXISTING prune command, unchanged.
    expect(lint[0]!.message).toContain("o2b brain entity prune");
  });

  test("surfaces a stored shouted heading the same way", () => {
    writeEntityNode("projects", "ent-projects-junk", "MEETING NOTES");
    seedLexicon("Atlas kept the weekly meeting notes about the setup.");
    const doctor = runDoctor(vault);
    const lint = doctor.warnings.filter((i) => i.code === "entity-label-malformed");
    expect(lint).toHaveLength(1);
    expect(lint[0]!.message).toContain("shouted-heading");
    expect(lint[0]!.message).toContain("o2b brain entity prune");
  });

  test("a lexicon-clean store draws no malformed-label warning", () => {
    writeEntityNode("people", "ent-people-ada", "Ada");
    seedLexicon("the of and the Of and. Ada kept the setup.");
    const doctor = runDoctor(vault);
    const codes = [...doctor.warnings, ...doctor.errors].map((i) => i.code);
    expect(codes).not.toContain("entity-label-malformed");
  });
});

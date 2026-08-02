/**
 * The shared entity status scope (provenance-at-the-boundary, unit A).
 *
 * `quarantine` is only worth having if the read paths honour it. Before this
 * unit the `active` filter was re-implemented at every caller and eight
 * callers applied none at all, so a third status value would have read as
 * "not archived, therefore visible" almost everywhere. One predicate now
 * answers the question and this file pins what it answers.
 *
 * The two scopes are deliberately different questions:
 *   - `canonical` - may this record HOLD the identity a lookup resolves to,
 *   - `readable`  - may a surface show or reason over this record at all.
 * `quarantine` is admitted by neither; `archived` by the second only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  archiveEntity,
  getEntity,
  listEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import {
  BRAIN_ENTITY_STATUS,
  isBrainEntityStatus,
} from "../../../../src/core/brain/entities/types.ts";
import {
  ENTITY_STATUS_SCOPE,
  entityStatusInScope,
} from "../../../../src/core/brain/entities/status-scope.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("entityStatusInScope", () => {
  test("quarantine is admitted by no scope - that is what the value means", () => {
    for (const scope of Object.values(ENTITY_STATUS_SCOPE)) {
      expect(entityStatusInScope(BRAIN_ENTITY_STATUS.quarantine, scope)).toBe(false);
    }
  });

  test("active holds the identity and is readable; archived is readable only", () => {
    expect(entityStatusInScope(BRAIN_ENTITY_STATUS.active, ENTITY_STATUS_SCOPE.canonical)).toBe(
      true,
    );
    expect(entityStatusInScope(BRAIN_ENTITY_STATUS.active, ENTITY_STATUS_SCOPE.readable)).toBe(
      true,
    );
    expect(entityStatusInScope(BRAIN_ENTITY_STATUS.archived, ENTITY_STATUS_SCOPE.canonical)).toBe(
      false,
    );
    expect(entityStatusInScope(BRAIN_ENTITY_STATUS.archived, ENTITY_STATUS_SCOPE.readable)).toBe(
      true,
    );
  });

  test("a status outside the vocabulary is admitted by no scope", () => {
    // The entity-like slices the guards consume carry `status: string`, so
    // the predicate has to answer for a value that never parsed. Refusing
    // is the only answer that cannot leak an unknown record into a surface.
    expect(isBrainEntityStatus("smuggled")).toBe(false);
    for (const scope of Object.values(ENTITY_STATUS_SCOPE)) {
      expect(entityStatusInScope("smuggled", scope)).toBe(false);
    }
  });

  test("every status in the vocabulary has a decision, none by omission", () => {
    // The scope table is keyed by BrainEntityStatus, so a new value cannot
    // be added to the vocabulary without a decision here. Measured rather
    // than trusted to the type checker alone.
    const decided = Object.values(BRAIN_ENTITY_STATUS).filter((status) =>
      Object.values(ENTITY_STATUS_SCOPE).some((scope) => entityStatusInScope(status, scope)),
    );
    expect(decided.toSorted()).toEqual([BRAIN_ENTITY_STATUS.active, BRAIN_ENTITY_STATUS.archived]);
  });
});

describe("registry reads honour the scope", () => {
  function quarantined(name: string): void {
    upsertEntity(vault, {
      category: "concept",
      name,
      agent: "intake",
      now: NOW,
      untrustedOrigin: true,
    });
  }

  test("a quarantined entity is absent from an unfiltered list and from lookup", () => {
    upsertEntity(vault, { category: "concept", name: "Restaking", agent: "op", now: NOW });
    quarantined("Scraped Claim");

    expect(listEntities(vault, { category: "concept" }).map((e) => e.name)).toEqual(["Restaking"]);
    expect(getEntity(vault, { category: "concept", query: "Scraped Claim" })).toBeNull();
    expect(getEntity(vault, { query: "Scraped Claim" })).toBeNull();
  });

  test("an archived entity stays in an unfiltered list, exactly as before", () => {
    upsertEntity(vault, { category: "concept", name: "Restaking", agent: "op", now: NOW });
    archiveEntity(vault, { category: "concept", query: "Restaking" }, { now: NOW });
    const listed = listEntities(vault, { category: "concept" });
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe(BRAIN_ENTITY_STATUS.archived);
  });

  test("an explicit status ask still reaches quarantined records", () => {
    quarantined("Scraped Claim");
    const listed = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(listed.map((e) => e.name)).toEqual(["Scraped Claim"]);
  });

  test("a second untrusted intake updates the quarantined record, it does not fork one", () => {
    quarantined("Scraped Claim");
    quarantined("Scraped Claim");
    const all = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe("ent-concept-scraped-claim");
  });

  test("a trusted mention does not promote a quarantined record on its own", () => {
    quarantined("Scraped Claim");
    upsertEntity(vault, { category: "concept", name: "Scraped Claim", agent: "op", now: NOW });
    const quarantinedRecords = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(quarantinedRecords).toHaveLength(1);
    // ...and the trusted write is not swallowed by it either. Until v1.43.0
    // this asserted zero readable records, which is the defect rather than
    // the guarantee: an untrusted source that guessed a name captured it, and
    // every later trusted write landed inside the quarantined record and read
    // back as absent. A trusted write now creates its own canonical record.
    const readable = listEntities(vault, { category: "concept" });
    expect(readable).toHaveLength(1);
    expect(readable[0]!.status).toBe(BRAIN_ENTITY_STATUS.active);
  });

  test("restore is the named exit from quarantine, not a dead end", () => {
    quarantined("Scraped Claim");
    const released = archiveEntity(
      vault,
      { category: "concept", query: "Scraped Claim" },
      { now: NOW, restore: true },
    );
    expect(released.status).toBe(BRAIN_ENTITY_STATUS.active);
    expect(getEntity(vault, { category: "concept", query: "Scraped Claim" })).not.toBeNull();
    // The release also clears the untrusted-source marker: the record is
    // now held on the operator's authority, not the source's.
    expect(readFileSync(released.path, "utf8")).not.toContain("untrusted_source");
  });
});

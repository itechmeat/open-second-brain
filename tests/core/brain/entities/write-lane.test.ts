/**
 * The two write lanes of the entity registry (provenance-at-the-boundary).
 *
 * `quarantine` was introduced as a lane for records an untrusted source
 * introduced, but the write seam resolved a quarantined holder for EVERY
 * upsert. That gave an untrusted source permanent capture of a name: the
 * first scraped page that mentioned `Acme Corp` created the quarantined
 * record, and every later TRUSTED write of that name landed inside it -
 * `created: false`, status copied from the quarantined target, the
 * `untrusted_source` marker carried forward as an extra, and the result
 * invisible to `getEntity`, to the default listing, to alias resolution and
 * to the retrieval gate. The writer was told the write succeeded.
 *
 * What is pinned here is the lane rule that replaced it: a write resolves
 * only inside its OWN identity space. A trusted write never lands on a
 * quarantined record (so an untrusted source cannot capture a name), and an
 * untrusted write never lands on a canonical one (so untrusted material
 * cannot ride into a trusted record's aliases, agent stamp or edges). The
 * two spaces are joined again only by the operator's explicit release, which
 * is why the collision that release can now produce is refused with its
 * remedy rather than silently forked into two active records.
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
  relateEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import { BRAIN_ENTITY_STATUS } from "../../../../src/core/brain/entities/types.ts";
import { UNTRUSTED_SOURCE_FRONTMATTER_KEY } from "../../../../src/core/brain/trust/untrusted-provenance.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const CATEGORY = "org";
const NAME = "Acme Corp";

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-lane-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-lane-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function untrustedUpsert(name: string, aliases?: readonly string[]): string {
  return upsertEntity(vault, {
    category: CATEGORY,
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    agent: "scraper",
    now: NOW,
    untrustedOrigin: true,
  }).entity.id;
}

function trustedUpsert(name: string, aliases?: readonly string[]) {
  return upsertEntity(vault, {
    category: CATEGORY,
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    agent: "operator",
    now: NOW,
  });
}

describe("a trusted write does not disappear into an untrusted-seeded record", () => {
  test("the trusted write creates a readable record of its own", () => {
    untrustedUpsert(NAME);
    const res = trustedUpsert(NAME);

    expect(res.created).toBe(true);
    expect(res.entity.status).toBe(BRAIN_ENTITY_STATUS.active);
    const found = getEntity(vault, { category: CATEGORY, query: NAME });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(res.entity.id);
    expect(listEntities(vault, { category: CATEGORY })).toHaveLength(1);
  });

  test("the trusted record carries no untrusted-source marker", () => {
    untrustedUpsert(NAME);
    const res = trustedUpsert(NAME);
    expect(readFileSync(res.entity.path, "utf8")).not.toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
  });

  test("the quarantined record is neither promoted nor rewritten by it", () => {
    const quarantinedId = untrustedUpsert(NAME);
    const before = readFileSync(
      listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })[0]!.path,
      "utf8",
    );
    trustedUpsert(NAME);

    const quarantined = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine });
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.id).toBe(quarantinedId);
    expect(quarantined[0]!.source_agent).toBe("scraper");
    expect(readFileSync(quarantined[0]!.path, "utf8")).toBe(before);
  });
});

describe("an untrusted write does not launder itself into a trusted record", () => {
  test("it lands in the quarantine lane even when a trusted namesake exists", () => {
    const trusted = trustedUpsert(NAME);
    untrustedUpsert(NAME, ["Acme Holdings"]);

    const found = getEntity(vault, { category: CATEGORY, query: NAME })!;
    expect(found.id).toBe(trusted.entity.id);
    expect(found.status).toBe(BRAIN_ENTITY_STATUS.active);
    expect(found.aliases).toHaveLength(0);
    expect(found.source_agent).toBe("operator");
    expect(readFileSync(found.path, "utf8")).not.toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("an alias claimed only by an untrusted record never resolves a trusted lookup", () => {
    untrustedUpsert(NAME, ["Acme Holdings"]);
    expect(getEntity(vault, { category: CATEGORY, query: "Acme Holdings" })).toBeNull();
  });

  test("re-ingesting the same untrusted source updates its record rather than forking one", () => {
    const first = untrustedUpsert(NAME);
    const second = untrustedUpsert(NAME);
    expect(second).toBe(first);
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("a quarantined record keeps its marker across an untrusted update", () => {
    untrustedUpsert(NAME);
    untrustedUpsert(NAME);
    const path = listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })[0]!.path;
    expect(readFileSync(path, "utf8")).toContain(UNTRUSTED_SOURCE_FRONTMATTER_KEY);
  });
});

describe("edges stay inside the lane that wrote them", () => {
  test("an untrusted intake can link the records it quarantined", () => {
    untrustedUpsert("Acme Corp");
    untrustedUpsert("Acme Labs");
    const from = relateEntities(vault, {
      from: { category: CATEGORY, query: "Acme Corp" },
      relation: "related",
      to: { category: CATEGORY, query: "Acme Labs" },
      now: NOW,
      untrustedOrigin: true,
    });
    expect(from.status).toBe(BRAIN_ENTITY_STATUS.quarantine);
    expect(from.relations.some((r) => r.relation === "related")).toBe(true);
  });

  test("an untrusted edge cannot attach itself to a trusted record", () => {
    const trusted = trustedUpsert("Acme Corp");
    untrustedUpsert("Acme Corp");
    untrustedUpsert("Acme Labs");
    relateEntities(vault, {
      from: { category: CATEGORY, query: "Acme Corp" },
      relation: "related",
      to: { category: CATEGORY, query: "Acme Labs" },
      now: NOW,
      untrustedOrigin: true,
    });
    const stillClean = getEntity(vault, { category: CATEGORY, query: "Acme Corp" })!;
    expect(stillClean.id).toBe(trusted.entity.id);
    expect(stillClean.relations).toHaveLength(0);
  });

  test("a trusted relate that finds only a quarantined holder names the exit", () => {
    trustedUpsert("Acme Labs");
    untrustedUpsert("Acme Corp");
    expect(() =>
      relateEntities(vault, {
        from: { category: CATEGORY, query: "Acme Corp" },
        relation: "related",
        to: { category: CATEGORY, query: "Acme Labs" },
        now: NOW,
      }),
    ).toThrow(/quarantine/);
  });
});

describe("release is refused when it would collide, not silently duplicated", () => {
  test("restoring a quarantined record whose name a trusted record holds throws with the ids", () => {
    untrustedUpsert(NAME);
    const trusted = trustedUpsert(NAME);
    expect(() =>
      archiveEntity(vault, { category: CATEGORY, query: NAME }, { now: NOW, restore: true }),
    ).toThrow(new RegExp(trusted.entity.id));
    expect(listEntities(vault, { status: BRAIN_ENTITY_STATUS.quarantine })).toHaveLength(1);
  });

  test("restore still releases a quarantined record when no trusted record holds the name", () => {
    untrustedUpsert(NAME);
    const released = archiveEntity(
      vault,
      { category: CATEGORY, query: NAME },
      { now: NOW, restore: true },
    );
    expect(released.status).toBe(BRAIN_ENTITY_STATUS.active);
    expect(getEntity(vault, { category: CATEGORY, query: NAME })).not.toBeNull();
  });
});

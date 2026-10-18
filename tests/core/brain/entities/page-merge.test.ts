/**
 * Entity page-merge (actionable-now-batch A1 / t_28a8789d).
 *
 * Fixtures are built through the canonical `upsertEntity` so the on-disk
 * shape stays in lockstep with production output. Guards are tested by
 * `expect.toThrow(EntityMergeError)` plus a `code` check; the happy path
 * is verified by re-reading the registry, the snapshot listing, the
 * reliability audit shard and the Brain log day.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { __clearEntityIndexCache } from "../../../../src/core/brain/entities/index-builder.ts";
import {
  EntityMergeError,
  applyEntityMerge,
  entityMergePlanHash,
  planEntityMerge,
} from "../../../../src/core/brain/entities/page-merge.ts";
import {
  archiveEntity,
  relateEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { listSnapshots } from "../../../../src/core/brain/snapshot.ts";
import { HYGIENE_AUDIT_DIR } from "../../../../src/core/brain/audit-dirs.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { getEntity } from "../../../../src/core/brain/entities/registry.ts";
import { normalizeRelationTarget } from "../../../../src/core/graph/frontmatter-relations.ts";
import { parseFrontmatter, writeFrontmatterAtomic } from "../../../../src/core/vault.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-page-merge-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-page-merge-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  __clearEntityIndexCache();
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityIndexCache();
});

const NOW = new Date("2026-10-17T09:00:00Z");

function seedPair(): { keepId: string; dropId: string } {
  const keep = upsertEntity(vault, {
    category: "people",
    name: "Ada Lovelace",
    body: "Analytical engines.",
    agent: "test-agent",
    now: NOW,
  });
  const drop = upsertEntity(vault, {
    category: "people",
    name: "Ada",
    body: "Short note about Ada.",
    agent: "test-agent",
    now: NOW,
  });
  return { keepId: keep.entity.id, dropId: drop.entity.id };
}

/**
 * A pair the text-level merge guard refuses: the keep body anchors Mary
 * Somerville (a guarded-category person) while the drop body anchors only
 * Ada, so the guarded anchor sets are disjoint and non-empty - the one
 * shape `guardEntityMerge` blocks.
 */
function seedGuardedPair(): { keepId: string; dropId: string } {
  upsertEntity(vault, {
    category: "people",
    name: "Mary Somerville",
    agent: "test-agent",
    now: NOW,
  });
  const keep = upsertEntity(vault, {
    category: "people",
    name: "Ada Lovelace",
    body: "Mary Somerville wrote often.",
    agent: "test-agent",
    now: NOW,
  });
  const drop = upsertEntity(vault, {
    category: "people",
    name: "Ada",
    body: "Short note about Ada.",
    agent: "test-agent",
    now: NOW,
  });
  return { keepId: keep.entity.id, dropId: drop.entity.id };
}

/** Digest of every file under the vault, in walk order, for no-op assertions. */
function vaultFingerprint(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else parts.push(`${abs}:${readFileSync(abs, "utf8")}`);
    }
  };
  walk(root);
  return parts.join("\n");
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(EntityMergeError);
    return (err as EntityMergeError).code;
  }
  throw new Error("expected the call to throw EntityMergeError");
}

/** Hand-write an entity file, bypassing the registry's write gate. */
function writeRawEntity(category: string, id: string, name: string, stem = id): string {
  const dir = join(vault, "Brain", "entities", category);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stem}.md`);
  writeFileSync(
    path,
    [
      "---",
      "kind: brain-entity",
      `entity_id: ${id}`,
      `category: ${category}`,
      `name: ${name}`,
      "status: active",
      "created_at: 2026-07-18T00:00:00Z",
      "updated_at: 2026-07-18T00:00:00Z",
      "tags:",
      "  - brain",
      "  - brain/entity",
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
  return path;
}

describe("planEntityMerge", () => {
  test("plans alias-on-survivor with the drop body folded and a stable hash", () => {
    const { keepId, dropId } = seedPair();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.keep_id).toBe(keepId);
    expect(plan.drop_id).toBe(dropId);
    expect(plan.category).toBe("people");
    expect(plan.alias_added).toBe("Ada");
    expect(plan.body_folded).toBe(true);
    expect(plan.drop_path.endsWith(".md")).toBe(true);
    // Frozen, and the hash is stable across two calls on identical input.
    expect(Object.isFrozen(plan)).toBe(true);
    expect(entityMergePlanHash(plan)).toBe(entityMergePlanHash(plan));
  });

  test("a drop with an empty body plans an archive without a fold", () => {
    const { keepId, dropId } = seedPair();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    const before = readFileSync(join(vault, plan.drop_path), "utf8");
    expect(before).toContain("Short note about Ada.");
    const bare = upsertEntity(vault, {
      category: "people",
      name: "Ada Twice",
      body: "",
      agent: "test-agent",
      now: NOW,
    });
    const barePlan = planEntityMerge(vault, { keep: keepId, drop: bare.entity.id });
    expect(barePlan.body_folded).toBe(false);
  });

  test("planning is a byte-no-op on the vault", () => {
    const { keepId, dropId } = seedPair();
    const before = vaultFingerprint(vault);
    planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(vaultFingerprint(vault)).toBe(before);
  });

  test("an empty drop body still merges when the survivor body anchors the pair", () => {
    // The survivor body anchors BOTH records of the pair ("ada lovelace"
    // and "ada" both hit the guard's anchor rule) while the empty drop
    // body anchors nothing: one-sided anchors are not the disjoint shape
    // the guard blocks, and with nothing to fold the plan skips the fold.
    const keep = upsertEntity(vault, {
      category: "people",
      name: "Ada Lovelace",
      body: "Ada Lovelace and Ada are the same person.",
      agent: "test-agent",
      now: NOW,
    });
    const drop = upsertEntity(vault, {
      category: "people",
      name: "Ada",
      body: "",
      agent: "test-agent",
      now: NOW,
    });
    // Resolution by the OLD name after a successful merge resolves to the
    // survivor, asserted in the apply tests; here the plan guards run.
    const plan = planEntityMerge(vault, { keep: keep.entity.id, drop: drop.entity.id });
    expect(plan.keep_id).toBe(keep.entity.id);
    expect(plan.drop_id).toBe(drop.entity.id);
    expect(plan.body_folded).toBe(false);
  });

  test("guards: same id, missing subjects and category mismatch refuse by code", () => {
    const { keepId, dropId } = seedPair();
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: keepId }))).toBe(
      "same-entity",
    );
    expect(codeOf(() => planEntityMerge(vault, { keep: "ent-people-none", drop: dropId }))).toBe(
      "keep-not-found",
    );
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: "ent-people-none" }))).toBe(
      "drop-not-found",
    );
    const elsewhere = upsertEntity(vault, {
      category: "projects",
      name: "Ada Project",
      agent: "test-agent",
      now: NOW,
    });
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: elsewhere.entity.id }))).toBe(
      "category-mismatch",
    );
  });

  test("an id subject outside the expected category refuses like the name path", () => {
    const { keepId, dropId } = seedPair();
    expect(
      codeOf(() =>
        planEntityMerge(vault, { keep: keepId, keepCategory: "projects", drop: dropId }),
      ),
    ).toBe("keep-not-found");
    expect(
      codeOf(() =>
        planEntityMerge(vault, { keep: keepId, drop: dropId, dropCategory: "projects" }),
      ),
    ).toBe("drop-not-found");
    // The right category still resolves by id on both sides.
    expect(() =>
      planEntityMerge(vault, {
        keep: keepId,
        drop: dropId,
        keepCategory: "people",
        dropCategory: "people",
      }),
    ).not.toThrow();
  });

  test("two files sharing one entity_id refuse as the shared-id collision", () => {
    const { keepId, dropId } = seedPair();
    // A synced or hand-copied page keeps its entity_id: two records answer
    // to one id, and "pass both sides by id" cannot disambiguate itself.
    // The copy lives under a different file name - the id travels in the
    // frontmatter, not the stem.
    writeRawEntity("people", keepId, "Ada Lovelace", `${keepId}-copy`);
    __clearEntityIndexCache();
    let thrown: EntityMergeError | null = null;
    try {
      planEntityMerge(vault, { keep: keepId, drop: dropId });
    } catch (err) {
      thrown = err as EntityMergeError;
    }
    expect(thrown).toBeInstanceOf(EntityMergeError);
    expect(thrown!.code).toBe("shared-entity-id");
    expect(thrown!.message).toContain(keepId);
    expect(thrown!.message).toContain("archive or rename");

    // The same collision with diverged names: the id path must still name
    // it rather than fall through to name resolution.
    writeRawEntity("people", dropId, "Ada Copy", `${dropId}-copy`);
    __clearEntityIndexCache();
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: dropId }))).toBe(
      "shared-entity-id",
    );
  });

  test("a quarantine-lane record is refused with a named reason", () => {
    seedPair();
    const quarantined = upsertEntity(vault, {
      category: "people",
      name: "Ada Unverified",
      agent: "test-agent",
      now: NOW,
      untrustedOrigin: true,
    });
    const keep = getEntity(vault, { query: "Ada Lovelace" });
    expect(
      codeOf(() => planEntityMerge(vault, { keep: keep!.id, drop: quarantined.entity.id })),
    ).toBe("quarantine-record");
    expect(
      codeOf(() => planEntityMerge(vault, { keep: quarantined.entity.id, drop: keep!.id })),
    ).toBe("quarantine-record");
  });

  test("subjects found by name refuse through the shared status gate", () => {
    seedPair();
    const quarantined = upsertEntity(vault, {
      category: "people",
      name: "Ada Unverified",
      agent: "test-agent",
      now: NOW,
      untrustedOrigin: true,
    });
    let thrown: EntityMergeError | null = null;
    try {
      planEntityMerge(vault, { keep: "Ada Lovelace", drop: "Ada Unverified" });
    } catch (err) {
      thrown = err as EntityMergeError;
    }
    expect(thrown).toBeInstanceOf(EntityMergeError);
    expect(thrown!.code).toBe("quarantine-record");
    // The refusal names the record and its lane - the shared gate's words,
    // not a hard-coded "archived" guess at the status.
    expect(thrown!.message).toContain(quarantined.entity.id);
    expect(thrown!.message).toContain("quarantine-lane record");

    // An archived holder found by name refuses as inactive, naming the
    // record.
    const drop = getEntity(vault, { query: "Ada" })!;
    archiveEntity(vault, { query: "Ada" }, { now: NOW });
    __clearEntityIndexCache();
    let archivedThrown: EntityMergeError | null = null;
    try {
      planEntityMerge(vault, { keep: "Ada Lovelace", drop: "Ada" });
    } catch (err) {
      archivedThrown = err as EntityMergeError;
    }
    expect(archivedThrown).toBeInstanceOf(EntityMergeError);
    expect(archivedThrown!.code).toBe("inactive-record");
    expect(archivedThrown!.message).toContain(drop.id);
    expect(archivedThrown!.message).toContain("archived");
  });

  test("a drop page listing its own name as an alias still merges", () => {
    const { keepId, dropId } = seedPair();
    // `upsertEntity` refuses a self-name alias, but a hand edit or an older
    // build can land one: the dropped page then holds its own name in the
    // alias map, and the claimed-alias check must not read that as a third
    // party's claim on the merge's own subject.
    const drop = getEntity(vault, { query: "Ada" })!;
    const [meta, body] = parseFrontmatter(drop.path);
    writeFrontmatterAtomic(drop.path, { ...meta, aliases: ["Ada"] }, body, { overwrite: true });
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.alias_added).toBe("Ada");
  });

  test("the dropped page's aliases move to the survivor, deduplicated", () => {
    const keep = upsertEntity(vault, {
      category: "people",
      name: "Ada Lovelace",
      body: "Analytical engines.",
      agent: "test-agent",
      now: NOW,
    });
    const drop = upsertEntity(vault, {
      category: "people",
      name: "Ada",
      agent: "test-agent",
      now: NOW,
    });
    // Hand-write the alias list so it carries a duplicate variant: the plan
    // must fold `the countess` into `The Countess` by normalized form.
    const [meta, body] = parseFrontmatter(drop.entity.path);
    writeFrontmatterAtomic(
      drop.entity.path,
      { ...meta, aliases: ["The Countess", "the countess", "Augusta Ada"] },
      body,
      { overwrite: true },
    );
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keep.entity.id, drop: drop.entity.id });
    // The display name leads, then the drop's own aliases in file order,
    // duplicates by normalized form collapsed.
    expect([...plan.aliases_merged]).toEqual(["Ada", "The Countess", "Augusta Ada"]);
    applyEntityMerge(
      vault,
      { keep: keep.entity.id, drop: drop.entity.id },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const survivor = getEntity(vault, { query: "Ada Lovelace" })!;
    expect(survivor.aliases).toEqual(["Ada", "The Countess", "Augusta Ada"]);
    // Every name the dropped page answered to keeps resolving - to the
    // survivor, never to the archived file.
    expect(getEntity(vault, { query: "The Countess" })!.id).toBe(keep.entity.id);
    expect(getEntity(vault, { query: "Augusta Ada" })!.id).toBe(keep.entity.id);
  });

  test("an alias claimed by a third record refuses the plan by name", () => {
    const { keepId, dropId } = seedPair();
    const third = upsertEntity(vault, {
      category: "people",
      name: "Charles Babbage",
      aliases: ["The Countess"],
      agent: "test-agent",
      now: NOW,
    });
    // Hand-add the contested alias to the drop page: upsert would refuse a
    // duplicate claim, but a hand edit or an older build can land one.
    const drop = getEntity(vault, { query: "Ada" })!;
    const [meta, body] = parseFrontmatter(drop.path);
    writeFrontmatterAtomic(drop.path, { ...meta, aliases: ["The Countess"] }, body, {
      overwrite: true,
    });
    __clearEntityIndexCache();
    let thrown: EntityMergeError | null = null;
    try {
      planEntityMerge(vault, { keep: keepId, drop: dropId });
    } catch (err) {
      thrown = err as EntityMergeError;
    }
    expect(thrown).toBeInstanceOf(EntityMergeError);
    expect(thrown!.code).toBe("alias-claimed");
    expect(thrown!.message).toContain("The Countess");
    expect(thrown!.message).toContain(third.entity.id);
  });

  test("an alias equal to a third record's display name refuses as claimed", () => {
    // The holder check read only other records' ALIASES: an alias equal
    // to a third canonical record's NAME moved onto the survivor
    // unrefused, leaving two records answering to one name - the exact
    // duplicate identity this verb exists to repair.
    const { keepId, dropId } = seedPair();
    const third = upsertEntity(vault, {
      category: "people",
      name: "Charles Babbage",
      agent: "test-agent",
      now: NOW,
    });
    // Hand-add the contested alias to the drop page: upsert would refuse
    // a duplicate claim, but a hand edit or an older build can land one.
    const drop = getEntity(vault, { query: "Ada" })!;
    const [meta, body] = parseFrontmatter(drop.path);
    writeFrontmatterAtomic(drop.path, { ...meta, aliases: ["Charles Babbage"] }, body, {
      overwrite: true,
    });
    __clearEntityIndexCache();
    let thrown: EntityMergeError | null = null;
    try {
      planEntityMerge(vault, { keep: keepId, drop: dropId });
    } catch (err) {
      thrown = err as EntityMergeError;
    }
    expect(thrown).toBeInstanceOf(EntityMergeError);
    expect(thrown!.code).toBe("alias-claimed");
    expect(thrown!.message).toContain(third.entity.id);
  });

  test("a same-named record in another category does not block the merge", () => {
    // The registry scopes display names per category (`byKey` is
    // `category:normalized`), so two categories sharing a display name
    // is a valid vault, and the holder check must not read a foreign
    // category's same-named record as a claim - merging people/Jordan
    // into people/Jordan Smith would otherwise refuse forever, with no
    // way for the operator to fix it. A name matches only inside the
    // merge's own category; alias matches stay global (pinned below and
    // by the same-category refusal test above), mirroring
    // `checkAliasClaims`.
    const keep = upsertEntity(vault, {
      category: "people",
      name: "Jordan Smith",
      body: "One person.",
      agent: "test-agent",
      now: NOW,
    });
    const drop = upsertEntity(vault, {
      category: "people",
      name: "Jordan",
      body: "Short note about Jordan.",
      agent: "test-agent",
      now: NOW,
    });
    upsertEntity(vault, {
      category: "places",
      name: "Jordan",
      body: "A country.",
      agent: "test-agent",
      now: NOW,
    });
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keep.entity.id, drop: drop.entity.id });
    expect(plan.alias_added).toBe("Jordan");
    applyEntityMerge(
      vault,
      { keep: keep.entity.id, drop: drop.entity.id },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const survivor = getEntity(vault, { query: "Jordan Smith" })!;
    expect(survivor.aliases).toEqual(["Jordan"]);
    // The other category's record is untouched and still itself.
    const place = getEntity(vault, { query: "Jordan", category: "places" })!;
    expect(place.id).not.toBe(keep.entity.id);

    // Aliases remain global: a drop alias held by ANOTHER category's
    // record still refuses the plan, exactly like the registry's
    // byAlias lookup refuses a write.
    const drop2 = upsertEntity(vault, {
      category: "people",
      name: "River Jordan",
      body: "A river.",
      agent: "test-agent",
      now: NOW,
    });
    upsertEntity(vault, {
      category: "places",
      name: "Petra",
      aliases: ["Wadi Musa"],
      body: "A city.",
      agent: "test-agent",
      now: NOW,
    });
    const drop2Fresh = getEntity(vault, { query: "River Jordan" })!;
    const [meta, body] = parseFrontmatter(drop2Fresh.path);
    writeFrontmatterAtomic(drop2Fresh.path, { ...meta, aliases: ["Wadi Musa"] }, body, {
      overwrite: true,
    });
    __clearEntityIndexCache();
    expect(
      codeOf(() => planEntityMerge(vault, { keep: keep.entity.id, drop: drop2.entity.id })),
    ).toBe("alias-claimed");
  });

  test("a guarded pair plans only through the explicit bypass option", () => {
    const { keepId, dropId } = seedGuardedPair();
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: dropId }))).toBe(
      "entity-guard",
    );
    // `--force` reaches the core as this option, and it is opt-in per call:
    // a plain re-plan afterwards still refuses.
    const plan = planEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { bypassEntityGuard: true },
    );
    expect(plan.keep_id).toBe(keepId);
    expect(plan.drop_id).toBe(dropId);
    expect(codeOf(() => planEntityMerge(vault, { keep: keepId, drop: dropId }))).toBe(
      "entity-guard",
    );
  });

  test("a guarded pair applies only through the explicit bypass option", () => {
    const { keepId, dropId } = seedGuardedPair();
    const plan = planEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { bypassEntityGuard: true },
    );
    const hash = entityMergePlanHash(plan);
    const before = vaultFingerprint(vault);
    expect(
      codeOf(() =>
        applyEntityMerge(vault, { keep: keepId, drop: dropId }, { expectHash: hash, now: NOW }),
      ),
    ).toBe("entity-guard");
    expect(vaultFingerprint(vault)).toBe(before);
    const result = applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: hash, bypassEntityGuard: true, now: NOW, agent: "test-agent" },
    );
    expect(existsSync(join(vault, result.dropped_path))).toBe(false);
  });
});

describe("applyEntityMerge", () => {
  test("refuses before any write without a verified hash", () => {
    const { keepId, dropId } = seedPair();
    const before = vaultFingerprint(vault);
    expect(codeOf(() => applyEntityMerge(vault, { keep: keepId, drop: dropId }))).toBe(
      "hash-required",
    );
    expect(vaultFingerprint(vault)).toBe(before);
  });

  test("refuses before any write on a stale or mismatched hash", () => {
    const { keepId, dropId } = seedPair();
    const before = vaultFingerprint(vault);
    expect(
      codeOf(() =>
        applyEntityMerge(vault, { keep: keepId, drop: dropId }, { expectHash: "deadbeef" }),
      ),
    ).toBe("hash-mismatch");
    expect(vaultFingerprint(vault)).toBe(before);
  });

  test("the plan stamps the bypass only when the guard would refuse", () => {
    // A clean pair: the guard passes, so a bypass-requested plan IS the
    // guarded plan - same stamp, same hash. The standard agent flow
    // (preview without --force, apply with it for consent) re-plans to
    // the hash the preview echoed and lands.
    const { keepId, dropId } = seedPair();
    const guarded = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(guarded.guard_bypassed).toBe(false);
    const bypassRequested = planEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { bypassEntityGuard: true },
    );
    expect(bypassRequested.guard_bypassed).toBe(false);
    expect(entityMergePlanHash(bypassRequested)).toBe(entityMergePlanHash(guarded));

    // A pair the guard refuses: only the bypassed plan exists, and it
    // says so - the stamp names an override that happened, never a flag
    // that was merely passed.
    const { keepId: gKeep, dropId: gDrop } = seedGuardedPair();
    const bypassed = planEntityMerge(
      vault,
      { keep: gKeep, drop: gDrop },
      { bypassEntityGuard: true },
    );
    expect(bypassed.guard_bypassed).toBe(true);
  });

  test("a pair that would refuse cannot apply under a preview that claimed no bypass", () => {
    // The keep body anchors Mary Somerville before her record exists: at
    // preview time the guard passes (nothing anchored to), and a later
    // registration flips the verdict WITHOUT touching either page - the
    // digest-sealed bytes are identical, only the guard stance moved.
    const keep = upsertEntity(vault, {
      category: "people",
      name: "Ada Lovelace",
      body: "Mary Somerville wrote often.",
      agent: "test-agent",
      now: NOW,
    });
    const drop = upsertEntity(vault, {
      category: "people",
      name: "Ada",
      body: "Short note about Ada.",
      agent: "test-agent",
      now: NOW,
    });
    const previewed = planEntityMerge(vault, { keep: keep.entity.id, drop: drop.entity.id });
    expect(previewed.guard_bypassed).toBe(false);
    const previewHash = entityMergePlanHash(previewed);

    upsertEntity(vault, {
      category: "people",
      name: "Mary Somerville",
      agent: "test-agent",
      now: NOW,
    });
    __clearEntityIndexCache();

    // Applying with the bypass re-plans at a stance the preview never
    // took: the plan now stamps guard_bypassed, the hash differs, and the
    // apply refuses as stale before any write.
    const before = vaultFingerprint(vault);
    expect(
      codeOf(() =>
        applyEntityMerge(
          vault,
          { keep: keep.entity.id, drop: drop.entity.id },
          {
            expectHash: previewHash,
            bypassEntityGuard: true,
            now: NOW,
            agent: "test-agent",
          },
        ),
      ),
    ).toBe("hash-mismatch");
    expect(vaultFingerprint(vault)).toBe(before);
    // Without the bypass the guard itself refuses, by its own code.
    expect(
      codeOf(() =>
        applyEntityMerge(
          vault,
          { keep: keep.entity.id, drop: drop.entity.id },
          { expectHash: previewHash, now: NOW },
        ),
      ),
    ).toBe("entity-guard");
    expect(vaultFingerprint(vault)).toBe(before);
  });

  test("the plan hash seals page content: a post-preview body edit refuses the apply", () => {
    const { keepId, dropId } = seedPair();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    // The digests are part of the plan, so the echoed hash covers the bytes.
    expect(plan.keep_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.drop_digest).toMatch(/^[0-9a-f]{64}$/);
    const hash = entityMergePlanHash(plan);
    // Rewrite the drop page's body AFTER the operator read the plan: the
    // counts and booleans are unchanged, but the prose moved underneath.
    const dropAbs = join(vault, plan.drop_path);
    const [meta, body] = parseFrontmatter(dropAbs);
    writeFrontmatterAtomic(dropAbs, meta, `${body.trimEnd()}\n\nUnreviewed late edit.\n`, {
      overwrite: true,
    });
    __clearEntityIndexCache();
    // A hash over ids and counts alone would still match; the sealed one
    // must refuse before any write.
    expect(
      codeOf(() =>
        applyEntityMerge(vault, { keep: keepId, drop: dropId }, { expectHash: hash, now: NOW }),
      ),
    ).toBe("hash-mismatch");
  });

  test("with the echoed hash it archives the old page, adds the alias and folds the body", () => {
    const { keepId, dropId } = seedPair();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    const result = applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      {
        expectHash: entityMergePlanHash(plan),
        now: NOW,
        agent: "test-agent",
      },
    );
    // The old page is archived (gone from the registry tree), never bare-deleted
    // without a recovery point.
    expect(existsSync(join(vault, result.dropped_path))).toBe(false);
    const snapshots = listSnapshots(vault);
    expect(snapshots.snapshots.length).toBeGreaterThan(0);

    const survivor = getEntity(vault, { query: "Ada Lovelace" })!;
    expect(survivor.aliases).toContain("Ada");
    expect(survivor.body).toContain("Analytical engines.");
    expect(survivor.body).toContain("Short note about Ada.");
    // The old name now resolves to the survivor - zero claim rewrites.
    const byOldName = getEntity(vault, { query: "Ada" });
    expect(byOldName!.id).toBe(keepId);
    expect(byOldName!.id).not.toBe(dropId);
  });

  test("inbound relation edges retarget to the survivor inside the same snapshot", () => {
    const { keepId, dropId } = seedPair();
    upsertEntity(vault, {
      category: "people",
      name: "Mary Somerville",
      agent: "test-agent",
      now: NOW,
    });
    relateEntities(vault, {
      from: { query: "Mary Somerville" },
      relation: "related",
      to: { query: "Ada" },
      now: NOW,
    });
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.inbound_edges_retargeted).toBe(1);
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const mary = getEntity(vault, { query: "Mary Somerville" })!;
    expect(mary.relations.map((r) => r.target)).toEqual([keepId]);
  });

  test("an inbound field holding both sides lands as ONE survivor edge", () => {
    const { keepId, dropId } = seedPair();
    upsertEntity(vault, {
      category: "people",
      name: "Mary Somerville",
      agent: "test-agent",
      now: NOW,
    });
    // Mary links to BOTH pages of the pair - a field the retarget maps onto
    // `[[keep]]` twice unless it dedups by normalized target.
    relateEntities(vault, {
      from: { query: "Mary Somerville" },
      relation: "related",
      to: { query: "Ada Lovelace" },
      now: NOW,
    });
    relateEntities(vault, {
      from: { query: "Mary Somerville" },
      relation: "related",
      to: { query: "Ada" },
      now: NOW,
    });
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.inbound_edges_retargeted).toBe(1);
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    // Read the raw frontmatter: the field holds the survivor exactly once -
    // first occurrence kept, order preserved - never a duplicated edge.
    const mary = getEntity(vault, { query: "Mary Somerville" })!;
    const [meta] = parseFrontmatter(mary.path);
    const raw = meta["related"];
    const items = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    expect(items.map((i) => normalizeRelationTarget(i))).toEqual([keepId]);
    expect(mary.relations.map((r) => r.target)).toEqual([keepId]);
  });

  test("an inbound page's unrelated relation fields stay untouched", () => {
    const { keepId, dropId } = seedPair();
    upsertEntity(vault, {
      category: "people",
      name: "Mary Somerville",
      agent: "test-agent",
      now: NOW,
    });
    const mary = getEntity(vault, { query: "Mary Somerville" })!;
    const [meta, body] = parseFrontmatter(mary.path);
    // One field points at the dropped page; the other two never did - a
    // scalar naming someone else, and an empty field.
    writeFrontmatterAtomic(
      mary.path,
      { ...meta, depends_on: `[[${dropId}]]`, related: "[[Bridge]]", contradicts: "" },
      body,
      { overwrite: true },
    );
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const [after] = parseFrontmatter(mary.path);
    // The rewrite touches only the field that pointed at the dropped page;
    // a scalar stays scalar and an empty field stays empty.
    expect(after["related"]).toBe("[[Bridge]]");
    expect(after["contradicts"]).toBe("");
    expect(after["depends_on"]).toEqual([`[[${keepId}]]`]);
    // The retargeted edge is present, and the untouched field still reads
    // as its own edge - nothing was dropped to make the rewrite convenient.
    expect(
      getEntity(vault, { query: "Mary Somerville" })!
        .relations.map((r) => r.target)
        .toSorted(),
    ).toEqual(["Bridge", keepId]);
  });

  test("relations_absorbed counts edges the way the apply writes them", () => {
    const { keepId, dropId } = seedPair();
    const bridge = upsertEntity(vault, {
      category: "projects",
      name: "Bridge",
      agent: "test-agent",
      now: NOW,
    });
    // Hand-write a duplicated edge onto the drop page: the apply's union
    // writes it once, so the plan must count it once.
    const drop = getEntity(vault, { query: "Ada" })!;
    const [meta, body] = parseFrontmatter(drop.path);
    writeFrontmatterAtomic(
      drop.path,
      { ...meta, related: [`[[${bridge.entity.id}]]`, `[[${bridge.entity.id}]]`] },
      body,
      { overwrite: true },
    );
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.relations_absorbed).toBe(1);
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const survivor = getEntity(vault, { query: "Ada Lovelace" })!;
    expect(survivor.relations.map((r) => r.target)).toEqual([bridge.entity.id]);
  });

  test("the cyclic edges the merge removes are named in the audit and the log", () => {
    const { keepId, dropId } = seedPair();
    relateEntities(vault, {
      from: { query: "Ada Lovelace" },
      relation: "related",
      to: { query: "Ada" },
      now: NOW,
    });
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    expect(plan.cyclic_edges_removed).toBe(1);
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    // The operator agreed to the edge removal - the audit record and the
    // log event both say how many edges went.
    const auditDir = join(vault, "Brain", "log", HYGIENE_AUDIT_DIR);
    const auditText = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => readFileSync(join(auditDir, f), "utf8"))
      .join("\n");
    expect(auditText).toContain('"cyclic_edges_removed":"1"');
    const day = readLogDay(vault, "2026-10-17");
    const mergeEvents = day.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.merge);
    expect(mergeEvents[0]!.body["cyclic_edges_removed"]).toBe("1");
  });

  test("the merged alias list is named in the audit record and the log event", () => {
    const keep = upsertEntity(vault, {
      category: "people",
      name: "Ada Lovelace",
      body: "Analytical engines.",
      agent: "test-agent",
      now: NOW,
    });
    const drop = upsertEntity(vault, {
      category: "people",
      name: "Ada",
      agent: "test-agent",
      now: NOW,
    });
    // An extra alias from the dropped page's own list: alias_added names
    // only the display name, so the audit trail is where the rest of the
    // moved set must show up.
    const [meta, body] = parseFrontmatter(drop.entity.path);
    writeFrontmatterAtomic(drop.entity.path, { ...meta, aliases: ["The Countess"] }, body, {
      overwrite: true,
    });
    __clearEntityIndexCache();
    const plan = planEntityMerge(vault, { keep: keep.entity.id, drop: drop.entity.id });
    expect([...plan.aliases_merged]).toEqual(["Ada", "The Countess"]);
    applyEntityMerge(
      vault,
      { keep: keep.entity.id, drop: drop.entity.id },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );

    // The reliability audit record carries the full list, serialized as
    // JSON beside alias_added.
    const auditDir = join(vault, "Brain", "log", HYGIENE_AUDIT_DIR);
    const records = readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) =>
        readFileSync(join(auditDir, f), "utf8")
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as { action: string; details: Record<string, string> }),
      );
    const mergeRecord = records.find((r) => r.action === "entity_merge");
    expect(mergeRecord).toBeDefined();
    expect(JSON.parse(String(mergeRecord!.details["aliases_merged"]))).toEqual([
      "Ada",
      "The Countess",
    ]);

    // The Brain log event carries the same full list.
    const day = readLogDay(vault, "2026-10-17");
    const mergeEvents = day.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.merge);
    expect(mergeEvents.length).toBe(1);
    expect(JSON.parse(String(mergeEvents[0]!.body["aliases_merged"]))).toEqual([
      "Ada",
      "The Countess",
    ]);
  });

  test("the apply appends the audit record and a merge log event", () => {
    const { keepId, dropId } = seedPair();
    const plan = planEntityMerge(vault, { keep: keepId, drop: dropId });
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    // Reliability audit: a week shard exists under Brain/log/hygiene/ and
    // carries the entity_merge action.
    const auditDir = join(vault, "Brain", "log", HYGIENE_AUDIT_DIR);
    expect(existsSync(auditDir)).toBe(true);
    const shards = readdirSync(auditDir).filter((f) => f.endsWith(".jsonl"));
    expect(shards.length).toBeGreaterThan(0);
    const auditText = shards.map((f) => readFileSync(join(auditDir, f), "utf8")).join("\n");
    expect(auditText).toContain('"entity_merge"');
    expect(auditText).toContain(keepId);

    // Brain log event: a merge event naming both ids lands in today's log.
    const day = readLogDay(vault, "2026-10-17");
    const mergeEvents = day.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.merge);
    expect(mergeEvents.length).toBe(1);
    expect(mergeEvents[0]!.body["keep_id"]).toBe(keepId);
    expect(mergeEvents[0]!.body["drop_id"]).toBe(dropId);
  });
});

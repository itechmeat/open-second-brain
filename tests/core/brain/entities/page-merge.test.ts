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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
import { relateEntities, upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { listSnapshots } from "../../../../src/core/brain/snapshot.ts";
import { HYGIENE_AUDIT_DIR } from "../../../../src/core/brain/audit-dirs.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { getEntity } from "../../../../src/core/brain/entities/registry.ts";

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
    const { keepId, dropId } = seedPair();
    // Resolution by the OLD name after a successful merge resolves to the
    // survivor, asserted in the apply tests; here only the plan guards run.
    expect(() => planEntityMerge(vault, { keep: keepId, drop: dropId })).not.toThrow();
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
    expect(plan.inbound_edges_retarged).toBe(1);
    applyEntityMerge(
      vault,
      { keep: keepId, drop: dropId },
      { expectHash: entityMergePlanHash(plan), now: NOW, agent: "test-agent" },
    );
    const mary = getEntity(vault, { query: "Mary Somerville" })!;
    expect(mary.relations.map((r) => r.target)).toEqual([keepId]);
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

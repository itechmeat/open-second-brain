/**
 * A1 (t_657b365e): entity-label hygiene - denylist resolution, malformed
 * node detection, and the snapshot-gated prune leaving no orphaned edges.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { writeFrontmatterAtomic } from "../../../src/core/vault.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { __clearEntityIndexCache } from "../../../src/core/brain/entities/index-builder.ts";
import {
  ENTITY_LABEL_DENYLIST_ENV_KEY,
  findMalformedEntityLabels,
  pruneEntityLabels,
  resolveEntityLabelDenylist,
} from "../../../src/core/brain/entities/label-hygiene.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-label-hygiene-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-label-hygiene-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  __clearEntityIndexCache();
  delete process.env[ENTITY_LABEL_DENYLIST_ENV_KEY];
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityIndexCache();
});

/** Write an entity node file directly, bypassing the creation quality gate. */
function writeEntityNode(
  category: string,
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
): string {
  const dir = join(brainDirs(vault).entities, category);
  mkdirSync(dir, { recursive: true });
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
      ...extra,
    },
    `# ${name}`,
    { overwrite: true },
  );
  __clearEntityIndexCache();
  return path;
}

describe("resolveEntityLabelDenylist", () => {
  test("is empty by default", () => {
    expect(resolveEntityLabelDenylist().size).toBe(0);
  });

  test("reads the env twin as a comma-separated post-normalized set", () => {
    process.env[ENTITY_LABEL_DENYLIST_ENV_KEY] = "Blocked Name, Other";
    try {
      const set = resolveEntityLabelDenylist();
      expect(set.has("blocked name")).toBe(true);
      expect(set.has("other")).toBe(true);
      expect(set.has("Blocked Name")).toBe(false); // normalised, not raw
    } finally {
      delete process.env[ENTITY_LABEL_DENYLIST_ENV_KEY];
    }
  });
});

describe("findMalformedEntityLabels", () => {
  test("returns only nodes whose labels fail the gate", () => {
    writeEntityNode("people", "ent-people-ada", "Ada");
    writeEntityNode("people", "ent-people-junk", "***");
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed.map((m) => m.id)).toEqual(["ent-people-junk"]);
    expect(malformed[0]!.reason).toBe("empty");
  });

  test("flags a denylisted label", () => {
    writeEntityNode("people", "ent-people-ada", "Ada");
    const denylist = new Set(["ada"]);
    const malformed = findMalformedEntityLabels(vault, { denylist });
    expect(malformed.map((m) => m.id)).toEqual(["ent-people-ada"]);
    expect(malformed[0]!.reason).toBe("denylisted");
  });

  test("records inbound references from other nodes", () => {
    writeEntityNode("people", "ent-people-junk", "***");
    writeEntityNode("people", "ent-people-ada", "Ada", {
      related: ["[[ent-people-junk]]"],
    });
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed[0]!.inboundReferences).toEqual(["ent-people-ada"]);
  });
});

describe("pruneEntityLabels", () => {
  test("dry-run lists candidates and mutates nothing (no snapshot)", () => {
    const junkPath = writeEntityNode("people", "ent-people-junk", "***");
    const result = pruneEntityLabels(vault, { confirm: false, now: NOW });
    expect(result.confirmed).toBe(false);
    expect(result.candidates.map((c) => c.id)).toEqual(["ent-people-junk"]);
    expect(result.removed).toEqual([]);
    expect(result.snapshotRunId).toBeNull();
    expect(existsSync(junkPath)).toBe(true);
    expect(listSnapshots(vault)).toHaveLength(0);
  });

  test("confirm removes the node and its edges behind a snapshot, doctor-clean", () => {
    const junkPath = writeEntityNode("people", "ent-people-junk", "***");
    writeEntityNode("people", "ent-people-ada", "Ada", {
      related: ["[[ent-people-junk]]"],
    });

    const result = pruneEntityLabels(vault, { confirm: true, now: NOW });
    expect(result.confirmed).toBe(true);
    expect(result.removed).toEqual([junkPath]);
    expect(result.edgesStripped).toBe(1);
    expect(result.snapshotRunId).toMatch(/^entity-prune-/);
    expect(result.snapshotPath).not.toBeNull();

    // Node file gone, snapshot recovery point written.
    expect(existsSync(junkPath)).toBe(false);
    expect(listSnapshots(vault).length).toBeGreaterThan(0);

    // No orphaned references remain: the inbound edge was stripped, so the
    // doctor reports neither a broken relation nor a malformed-label lint.
    const doctor = runDoctor(vault);
    const codes = [...doctor.warnings, ...doctor.errors].map((i) => i.code);
    expect(codes).not.toContain("broken-entity-relation");
    expect(codes).not.toContain("entity-label-malformed");
  });

  test("confirm with no candidates is a no-op that takes no snapshot", () => {
    writeEntityNode("people", "ent-people-ada", "Ada");
    const result = pruneEntityLabels(vault, { confirm: true, now: NOW });
    expect(result.confirmed).toBe(false);
    expect(result.removed).toEqual([]);
    expect(listSnapshots(vault)).toHaveLength(0);
  });
});

describe("doctor entity-label-malformed lint", () => {
  test("surfaces a malformed node as a warning prune candidate", () => {
    writeEntityNode("people", "ent-people-junk", "***");
    const doctor = runDoctor(vault);
    const lint = doctor.warnings.find((i) => i.code === "entity-label-malformed");
    expect(lint).toBeDefined();
    expect(lint!.severity).toBe("warning");
    expect(lint!.message).toContain("ent-people-junk");
  });
});

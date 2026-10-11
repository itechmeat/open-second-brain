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
  deriveEntityLexicon,
  writeEntityLexicon,
  __clearEntityLexiconCache,
} from "../../../src/core/brain/entities/lexicon.ts";
import {
  ENTITY_LABEL_DENYLIST_ENV_KEY,
  findMalformedEntityLabels,
  pruneEntityLabels,
  resolveEntityLabelDenylist,
} from "../../../src/core/brain/entities/label-hygiene.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";

let vault: string;
let configHome: string;
let originalDenylist: string | undefined;

const NOW = new Date("2026-07-18T12:00:00Z");

beforeEach(() => {
  originalDenylist = process.env[ENTITY_LABEL_DENYLIST_ENV_KEY];
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
  __clearEntityLexiconCache();
  // Restore any pre-existing env value so this suite does not contaminate
  // other tests sharing the process.
  if (originalDenylist === undefined) {
    delete process.env[ENTITY_LABEL_DENYLIST_ENV_KEY];
  } else {
    process.env[ENTITY_LABEL_DENYLIST_ENV_KEY] = originalDenylist;
  }
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
    // A structural verdict is never advisory: it has always been prune-
    // eligible, at creation and on the heal side alike.
    expect(malformed[0]!.advisory).toBe(false);
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

/**
 * Recall-quality A3: the store-wide re-admission pass resolves the same
 * store-learned lexicon the creation gate does, so a tightened verdict
 * automatically becomes the idempotent heal. Recall-quality review M3:
 * the ADVISORY classes (a single-token shout, a common-word run) are
 * doctor-visible but excluded from the prune set unless the operator
 * opts in with `--include-advisory` - the destructive default clears
 * structural junk only. The only vocabulary is what a corpus page
 * teaches the artifact.
 */
describe("findMalformedEntityLabels - lexicon-aware re-admission (recall-quality A3)", () => {
  /** Teach the lexicon from one corpus page, then rebuild the artifact. */
  function seedLexicon(corpus: string): void {
    atomicWriteFileSync(join(vault, "corpus-page.md"), `${corpus}\n`);
    writeEntityLexicon(vault, deriveEntityLexicon(vault, { now: NOW }));
  }

  test("reports a stored caseful common-word run with function-word-run", () => {
    // "The Of And" passes the structural gate, so only the lexicon sees it.
    writeEntityNode("people", "ent-people-junk", "The Of And");
    writeEntityNode("people", "ent-people-ada", "Ada");
    seedLexicon("the of and the Of and.");
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed.map((m) => m.id)).toEqual(["ent-people-junk"]);
    expect(malformed[0]!.reason).toBe("function-word-run");
    expect(malformed[0]!.advisory).toBe(true);
  });

  test("reports a stored MULTI-token shout as a structural finding", () => {
    // A two-word all-caps run is pasted '# HEADING' residue - prune-eligible
    // as today; only the SINGLE-token shout is the advisory class.
    writeEntityNode("projects", "ent-projects-junk", "MEETING NOTES");
    seedLexicon("Atlas kept the weekly meeting notes about the setup.");
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed.map((m) => m.id)).toEqual(["ent-projects-junk"]);
    expect(malformed[0]!.reason).toBe("shouted-heading");
    expect(malformed[0]!.advisory).toBe(false);
  });

  test("marks a SINGLE-token shout advisory - a brand or acronym (NASA)", () => {
    writeEntityNode("projects", "ent-projects-nasa", "NASA");
    seedLexicon("Atlas kept the weekly meeting notes about the setup.");
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed.map((m) => m.id)).toEqual(["ent-projects-nasa"]);
    expect(malformed[0]!.reason).toBe("shouted-heading");
    expect(malformed[0]!.advisory).toBe(true);
  });

  test("a common-word run is advisory: doctor-visible, outside the prune set", () => {
    // Creation would admit this label (the multi-token policy split), and
    // the heal side must agree: the finding is reported but stays OUT of
    // the prune candidate set unless the operator opts in.
    writeEntityNode("people", "ent-people-title", "The Notes");
    seedLexicon("the runner kept notes about the setup. The runner ran.");
    const malformed = findMalformedEntityLabels(vault);
    expect(malformed.map((m) => m.id)).toEqual(["ent-people-title"]);
    expect(malformed[0]!.reason).toBe("function-word-run");

    const dry = pruneEntityLabels(vault, { confirm: false, now: NOW });
    expect(dry.confirmed).toBe(false);
    expect(dry.candidates).toEqual([]);
    expect(dry.advisorySkipped).toBe(1);
    expect(dry.snapshotRunId).toBeNull();
    expect(dry.removed).toEqual([]);

    // The opt-in puts the advisory class back into the candidate set.
    const optedIn = pruneEntityLabels(vault, {
      confirm: false,
      includeAdvisory: true,
      now: NOW,
    });
    expect(optedIn.candidates.map((c) => c.id)).toEqual(["ent-people-title"]);
    expect(optedIn.advisorySkipped).toBe(0);
  });

  test("without a lexicon artifact the pass is unchanged (fail-open)", () => {
    writeEntityNode("people", "ent-people-junk", "The Of And");
    expect(findMalformedEntityLabels(vault)).toEqual([]);
  });

  test("prune --confirm keeps NASA-style and Meeting-style entities; --include-advisory removes them", () => {
    const nasa = writeEntityNode("projects", "ent-projects-nasa", "NASA");
    const notes = writeEntityNode("people", "ent-people-notes", "Notes");
    const junk = writeEntityNode("people", "ent-people-junk", "***");
    // An edge pointing at an advisory survivor must survive the default run.
    writeEntityNode("people", "ent-people-ada", "Ada", {
      related: ["[[ent-people-notes]]"],
    });
    seedLexicon("Atlas kept the weekly meeting notes about the setup.");

    // The destructive default clears only structural junk: the acronym and
    // the common-word topic stay in place, still reported by the doctor,
    // and no edge pointing at them is stripped.
    const structural = pruneEntityLabels(vault, { confirm: true, now: NOW });
    expect(structural.confirmed).toBe(true);
    expect(structural.removed).toEqual([junk]);
    expect(structural.advisorySkipped).toBe(2);
    expect(structural.edgesStripped).toBe(0);
    expect(existsSync(nasa)).toBe(true);
    expect(existsSync(notes)).toBe(true);

    const doctor = runDoctor(vault);
    const advisoryLints = doctor.warnings.filter((i) => i.code === "entity-label-malformed");
    expect(advisoryLints).toHaveLength(2);
    const doctorCodes = [...doctor.warnings, ...doctor.errors].map((i) => i.code);
    expect(doctorCodes).not.toContain("broken-entity-relation");

    // Opting in removes the advisory classes too, behind the same snapshot
    // gate, and strips the inbound edge so the store ends up doctor-clean.
    const all = pruneEntityLabels(vault, { confirm: true, includeAdvisory: true, now: NOW });
    expect(all.confirmed).toBe(true);
    expect([...all.removed].sort()).toEqual([nasa, notes].sort());
    expect(all.advisorySkipped).toBe(0);
    expect(all.edgesStripped).toBe(1);
    expect(all.snapshotRunId).toMatch(/^entity-prune-/);
    expect(existsSync(nasa)).toBe(false);
    expect(existsSync(notes)).toBe(false);

    const clean = runDoctor(vault);
    const codes = [...clean.warnings, ...clean.errors].map((i) => i.code);
    expect(codes).not.toContain("entity-label-malformed");
    expect(codes).not.toContain("broken-entity-relation");
  });

  test("a MULTI-token shout is structural: the default confirm still prunes it", () => {
    const junk = writeEntityNode("projects", "ent-projects-junk", "MEETING NOTES");
    writeEntityNode("people", "ent-people-ada", "Ada", {
      related: ["[[ent-projects-junk]]"],
    });
    seedLexicon("Atlas kept the weekly meeting notes about the setup.");

    const result = pruneEntityLabels(vault, { confirm: true, now: NOW });
    expect(result.confirmed).toBe(true);
    expect(result.candidates[0]!.reason).toBe("shouted-heading");
    expect(result.candidates[0]!.advisory).toBe(false);
    expect(result.advisorySkipped).toBe(0);
    expect(result.removed).toEqual([junk]);
    expect(result.edgesStripped).toBe(1);
    expect(result.snapshotRunId).toMatch(/^entity-prune-/);
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
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
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
    expect(listSnapshots(vault).snapshots.length).toBeGreaterThan(0);

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
    expect(listSnapshots(vault).snapshots).toHaveLength(0);
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

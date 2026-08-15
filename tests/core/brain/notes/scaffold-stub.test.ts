/**
 * Materialising an unresolved wikilink target (B3).
 *
 * The defect. Three places in this codebase already KNOW a link target
 * does not exist and each of them stops there: `repair-lane.ts` decides
 * `skip-missing-target`, `deep-synthesis.ts` emits the advice "write the
 * missing note or fix the dangling link", and the doctor emits
 * `broken-backlinks` with a structured target and its sources. Nothing
 * materialises anything, so every one of those is a report the operator
 * has to act on by hand.
 *
 * The second defect, and the one this file spends most of its assertions
 * on. The index reports dangling links as a COUNT
 * (`LinkResolutionCounts`), and a count taken after an incremental pass
 * is not reproducible: `resolveLinkTargets` is a global post-pass but
 * alias replacement runs only for the documents a run actually read. A
 * reader that returned an empty list from a partially-resolved index
 * would be saying "no dangling links" about a vault nobody finished
 * measuring - the same defect this release exists to remove, in a new
 * place. So the scan refuses, in the shape `link-ratchet.ts` already
 * models with `unmeasurable("partial-resolution")`.
 *
 * Deliberately NOT covered here: the SQL itself (its own file under
 * `tests/core/search/`), and the MCP / CLI argument surfaces.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { indexVault } from "../../../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../../../src/core/search/index.ts";
import {
  DANGLING_SCAN,
  DANGLING_SCANS,
  isDanglingScan,
  listDanglingTargets,
  scaffoldStub,
  ScaffoldStubError,
} from "../../../../src/core/brain/notes/scaffold-stub.ts";
import {
  IDENTITY_STRENGTH,
  REPAIR_CONFIRM_PHRASE,
  runRepairLane,
} from "../../../../src/core/brain/link-graph/repair-lane.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-scaffold-stub-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-scaffold-stub-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function note(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

function read(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

/**
 * Append a `notes.read_paths` declaration to the bootstrapped config.
 * Appended rather than written over, because the file the bootstrap left
 * carries a `schema_version` the loader requires.
 */
function declareNoteRoots(roots: ReadonlyArray<string>): void {
  const path = join(vault, "Brain", "_brain.yaml");
  const block = `\nnotes:\n  read_paths:\n${roots.map((r) => `    - ${r}`).join("\n")}\n`;
  atomicWriteFileSync(path, readFileSync(path, "utf8") + block);
}

describe("the scan-state vocabulary", () => {
  test("every declared state is a member and the guard refuses everything else", () => {
    expect([...DANGLING_SCANS].toSorted()).toEqual(Object.values(DANGLING_SCAN).toSorted());
    for (const state of DANGLING_SCANS) expect(isDanglingScan(state)).toBe(true);
    for (const outsider of [null, 42, {}, "", "Measured"]) {
      expect(isDanglingScan(outsider)).toBe(false);
    }
  });
});

describe("listing dangling targets", () => {
  test("refuses when no index exists rather than reporting zero", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const scan = await listDanglingTargets(vault);
    expect(scan.state).toBe(DANGLING_SCAN.indexMissing);
    expect(scan.targets).toEqual([]);
    expect(scan.detail).not.toBeNull();
    expect(scan.nextCommand.length).toBeGreaterThan(0);
  });

  test("refuses a partially-resolved index rather than reporting zero", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const config = resolveSearchConfig({ vault });
    // An incremental pass: `last_full_index_at` never equals
    // `last_indexed_at`, which is precisely the state whose counts are
    // not reproducible.
    await indexVault(config, { force: false });
    const scan = await listDanglingTargets(vault);
    expect(scan.state).toBe(DANGLING_SCAN.partialResolution);
    expect(scan.targets).toEqual([]);
  });

  test("measures after a forced full pass and names the targets", async () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    await indexVault(resolveSearchConfig({ vault }), { force: true });
    const scan = await listDanglingTargets(vault);
    expect(scan.state).toBe(DANGLING_SCAN.measured);
    expect(scan.targets.map((t) => t.target)).toContain("Projects/Ghost");
  });
});

describe("scaffolding a stub", () => {
  test("writes a real note with real frontmatter at the target's own path", () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const res = scaffoldStub(vault, {
      target: "Projects/Ghost",
      sources: ["Projects/A.md"],
      apply: true,
    });
    expect(res.applied).toBe(true);
    expect(res.path).toBe("Projects/Ghost.md");
    expect(res.outcome).toBe("created");
    const md = read("Projects/Ghost.md");
    expect(md).toContain("title: Ghost");
    // The body is derived from the index's own sources, not invented:
    // the stub links back to what referenced it.
    expect(md).toContain("[[Projects/A]]");
  });

  test("dry run is the default and puts no file on disk", () => {
    note("Projects/A.md", "[[Projects/Ghost]]\n");
    const res = scaffoldStub(vault, { target: "Projects/Ghost" });
    expect(res.applied).toBe(false);
    expect(res.outcome).toBeNull();
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(false);
  });

  test("refuses a target that already resolves - there is nothing missing", () => {
    note("Projects/Real.md", "x\n");
    expect(() => scaffoldStub(vault, { target: "Projects/Real", apply: true })).toThrow(
      ScaffoldStubError,
    );
  });

  test("refuses an ambiguous bare target and lists the candidates", () => {
    declareNoteRoots(["Projects", "Inbox"]);
    note("Projects/Dup.md", "x\n");
    note("Inbox/Dup.md", "x\n");
    let caught: unknown;
    try {
      scaffoldStub(vault, { target: "Dup", apply: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ScaffoldStubError);
    expect((caught as ScaffoldStubError).candidates.length).toBeGreaterThan(1);
  });

  test("honours if_exists=skip when the destination is occupied but the target is not", () => {
    // The residual case `if_exists` exists for, and the reason it is
    // forwarded rather than hardcoded. The title resolver walks
    // `notes.read_paths`; a file OUTSIDE those roots is invisible to it,
    // so `Ghost` is genuinely unresolvable while `Ghost.md` at the vault
    // root is genuinely occupied. `skip` is the discriminated no-op the
    // create-note primitive already exposes, and it must read as a skip -
    // never as a create.
    declareNoteRoots(["Projects"]);
    note("Ghost.md", "already here\n");
    const res = scaffoldStub(vault, { target: "Ghost", ifExists: "skip", apply: true });
    expect(res.outcome).toBe("skipped");
    expect(read("Ghost.md")).toBe("already here\n");
  });

  test("refuses an occupied destination by default rather than clobbering it", () => {
    declareNoteRoots(["Projects"]);
    note("Ghost.md", "already here\n");
    expect(() => scaffoldStub(vault, { target: "Ghost", apply: true })).toThrow();
    expect(read("Ghost.md")).toBe("already here\n");
  });

  test("puts the destination through the create-note path envelope", () => {
    expect(() =>
      scaffoldStub(vault, { target: "Ghost", path: "Brain/Sneaky.md", apply: true }),
    ).toThrow();
  });
});

describe("the repair lane does not scaffold as a side effect", () => {
  const candidate = {
    source: "Projects/A.md",
    target: "Projects/Ghost.md",
    strength: IDENTITY_STRENGTH.explicitReference,
    confidence: 0.9,
    reason: "test",
  };

  test("a missing target is still skip-missing-target by default", () => {
    note("Projects/A.md", "x\n");
    const res = runRepairLane(vault, [candidate], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
    });
    expect(res.decisions[0]!.action).toBe("skip-missing-target");
    expect(res.scaffolded).toEqual([]);
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(false);
  });

  test("scaffolding is opt-in, and then the edge is written", () => {
    note("Projects/A.md", "x\n");
    const res = runRepairLane(vault, [candidate], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
      scaffoldMissingTargets: true,
    });
    expect(res.scaffolded).toEqual(["Projects/Ghost.md"]);
    expect(res.decisions[0]!.action).toBe("write");
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(true);
  });

  test("a dry run never scaffolds, whatever the opt-in says", () => {
    note("Projects/A.md", "x\n");
    const res = runRepairLane(vault, [candidate], { scaffoldMissingTargets: true });
    expect(res.scaffolded).toEqual([]);
    expect(existsSync(join(vault, "Projects/Ghost.md"))).toBe(false);
  });
});

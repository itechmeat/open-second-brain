/**
 * The held-chunks doctor check (chunk skip-and-hold, F2, task B4).
 *
 * A held chunk is invisible to every surface that counts pending work:
 * the pending census, the refresh estimate and the backfill all stop
 * seeing it BY DESIGN - the index does not owe it a vector. That is
 * correct for spend and wrong for awareness: nothing told the operator
 * which SOURCE DOCUMENTS carry chunks the active model cannot take.
 * This check speaks from the doctor pass, ONE aggregated warning per
 * affected document, naming the count, the largest estimate and the
 * window the proof ran against.
 *
 * The index facts are an injected probe, following
 * `embeddings-health-check`: every verdict is reachable from a test
 * without building an index. The read-failure states stay this check's
 * silence for a stated reason rather than a second uncertain stream -
 * the sibling check already reports "the index could not be read" for
 * the same file, and two findings for one condition is what its docblock
 * refuses.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import {
  APPLIER_CAPABILITY,
  REPAIR_VERDICT,
} from "../../../../src/core/brain/applier-capability.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  CHUNK_HOLDS_ACTIVE_CODE,
  chunkHoldsCheck,
  makeChunkHoldsCheck,
  type ChunkHoldsProbe,
  type HeldChunkDocRow,
} from "../../../../src/core/brain/doctor/chunk-holds-check.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import type { ChunkHoldExclusion } from "../../../../src/core/search/store/chunks.ts";
import { RECOMMENDED_EMBEDDING_MODEL } from "../../../../src/core/search/embeddings/presets.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-chunk-holds-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-chunk-holds-cfg-"));
  configPath = join(configHome, "config.yaml");
  bootstrapBrain(vault);
  configure(RECOMMENDED_EMBEDDING_MODEL, "8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function configure(model: string, dimension: string): void {
  writeFileSync(
    configPath,
    [
      `vault: ${vault}`,
      `search_semantic_enabled: "true"`,
      `embedding_provider: "openai-compat"`,
      `embedding_base_url: "https://example.invalid/v1"`,
      `embedding_model: "${model}"`,
      `embedding_dimension: "${dimension}"`,
    ].join("\n") + "\n",
  );
}

function docRow(overrides: Partial<HeldChunkDocRow> = {}): HeldChunkDocRow {
  return { path: "Brain/big-note.md", heldChunks: 2, maxEstimatedTokens: 600, ...overrides };
}

function run(probe: ChunkHoldsProbe, extra: Partial<DoctorCheckContext> = {}): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  const uncertain: never[] = [];
  makeChunkHoldsCheck(probe).run(
    { vault, now: NOW, configPath, ...extra } as unknown as DoctorCheckContext,
    { issues, uncertain },
  );
  return issues;
}

function active(issues: DoctorIssue[]): DoctorIssue[] {
  return issues.filter((i) => i.code === CHUNK_HOLDS_ACTIVE_CODE);
}

describe("held documents become one warning each", () => {
  test("the warning names the count, the largest estimate and the window", () => {
    const issues = run(() => [docRow()]);
    expect(active(issues).length).toBe(1);
    const issue = active(issues)[0]!;
    expect(issue.severity).toBe("warning");
    expect(issue.path).toBe("Brain/big-note.md");
    expect(issue.message).toContain("2");
    expect(issue.message).toContain("600");
    expect(issue.message).toContain("512");
    expect(issue.message).toContain(RECOMMENDED_EMBEDDING_MODEL);
  });

  test("the probe is handed the active (model, window, signature) key", () => {
    const seen: ChunkHoldExclusion[] = [];
    run((_dbPath, hold) => {
      seen.push(hold);
      return [];
    });
    expect(seen.length).toBe(1);
    const hold = seen[0]!;
    expect(hold.model).toBe(RECOMMENDED_EMBEDDING_MODEL);
    expect(hold.windowTokens).toBe(512);
    expect(hold.embeddingSignature).toContain(RECOMMENDED_EMBEDDING_MODEL);
    expect(hold.embeddingSignature).toContain(":8");
  });

  test("affected documents warn separately", () => {
    const issues = run(() => [
      docRow({ path: "Brain/a.md" }),
      docRow({ path: "Brain/b.md", heldChunks: 1, maxEstimatedTokens: 900 }),
    ]);
    expect(active(issues).map((i) => i.path)).toEqual(["Brain/a.md", "Brain/b.md"]);
  });

  test("no held document, no finding", () => {
    expect(run(() => [])).toEqual([]);
  });
});

describe("states that are not this check's to report stay silent", () => {
  test("semantic search off: not configured, not probed", () => {
    writeFileSync(configPath, `vault: ${vault}\nsearch_semantic_enabled: "false"\n`);
    let probed = 0;
    const issues = run(() => {
      probed++;
      return [docRow()];
    });
    expect(probed).toBe(0);
    expect(issues).toEqual([]);
  });

  test("a model with no declared window can hold nothing: not probed", () => {
    configure("vendor-x/embed-v1", "8");
    let probed = 0;
    const issues = run(() => {
      probed++;
      return [docRow()];
    });
    expect(probed).toBe(0);
    expect(issues).toEqual([]);
  });

  test("an index that could not be read is the sibling check's finding, not a second one here", () => {
    // The embeddings-health check reports this file as census-unrecorded
    // or unmeasured; a null from this check's probe adds nothing to that.
    expect(run(() => null)).toEqual([]);
  });

  test("the ctx.dbPath the pass names is the index probed", () => {
    const seen: string[] = [];
    run(
      (dbPath) => {
        seen.push(dbPath);
        return [];
      },
      { dbPath: "/elsewhere/index.db" },
    );
    expect(seen).toEqual(["/elsewhere/index.db"]);
  });
});

describe("a caller who may not read a page does not learn it is held", () => {
  test("ctx.readable spends no warning slot and moves no count", () => {
    const probe: ChunkHoldsProbe = () => [
      docRow({ path: "Brain/a.md" }),
      docRow({ path: "Brain/b.md" }),
    ];
    const issues = run(probe, { readable: (rel: string) => rel !== "Brain/b.md" });
    expect(active(issues).map((i) => i.path)).toEqual(["Brain/a.md"]);
  });
});

describe("the registered instance and its exits", () => {
  test("the registered check is failSoft", () => {
    expect(chunkHoldsCheck.failSoft).toBe(true);
  });

  test("a semantic vault whose index is absent produces no held finding from runDoctor", () => {
    const result = runDoctor(vault, { now: NOW, configPath });
    expect(result.warnings.filter((i) => i.code === CHUNK_HOLDS_ACTIVE_CODE)).toEqual([]);
  });

  test("the warning code carries a written reason, not a command", () => {
    expect(DOCTOR_EXIT_EXCLUSIONS.has(CHUNK_HOLDS_ACTIVE_CODE)).toBe(true);
    expect(DIAGNOSTIC_SIGNALS.has(CHUNK_HOLDS_ACTIVE_CODE)).toBe(false);
    expect(
      DOCTOR_EXIT_EXCLUSIONS.get(CHUNK_HOLDS_ACTIVE_CODE)!.trim().length,
    ).toBeGreaterThanOrEqual(80);
  });

  test("the repair question is answered as a stated refusal", () => {
    const entry = APPLIER_CAPABILITY.get(CHUNK_HOLDS_ACTIVE_CODE);
    expect(entry?.verdict).toBe(REPAIR_VERDICT.refused);
    if (entry === undefined || entry.verdict !== REPAIR_VERDICT.refused) {
      throw new Error("chunk-holds-active must be a stated refusal");
    }
    expect(entry.reason.trim().length).toBeGreaterThan(0);
  });
});

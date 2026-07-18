/**
 * Source-ingest pipeline (Knowledge Provenance suite). One text-bearing source
 * becomes entity/concept pages plus a per-source summary page that backlinks
 * the source, lists the entities it introduced, and lists its connections to
 * pre-existing material. Idempotent on the source path. OSB runs no model -
 * the agent supplies the extraction and the summary prose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  getEntity,
  listEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { computePlanId, readCheckpoint } from "../../../../src/core/brain/ingest/checkpoint.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const INPUT = {
  sourcePath: "Articles/restaking-primer.md",
  summary: "An overview of restaking and its role for validators.",
  extraction: {
    entities: [
      { category: "concept", name: "Restaking" },
      { category: "concept", name: "Validators" },
    ],
    relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
  },
};

function readSummary(summaryPath: string): string {
  return readFileSync(join(vault, summaryPath), "utf8");
}

describe("ingestSource", () => {
  test("creates entity pages and a summary page that backlinks the source", () => {
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.created).toBe(true);
    expect(res.entitiesCreated).toHaveLength(2);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);

    const md = readSummary(res.summaryPath);
    expect(md).toContain("kind: brain-source");
    expect(md).toContain("An overview of restaking");
    expect(md).toContain("## Sources");
    expect(md).toContain("[[Articles/restaking-primer.md]]");
    expect(md).toContain("## Entities");
  });

  test("lists pre-existing entities as connections, new ones only as entities", () => {
    // Seed Validators so it pre-exists; the ingest should report it as a
    // connection to existing material, while Restaking is freshly created.
    upsertEntity(vault, { category: "concept", name: "Validators", agent: "claude", now: NOW });

    const res = ingestSource(vault, INPUT, { agent: "claude", now: LATER });
    expect(res.entitiesCreated).toHaveLength(1); // Restaking
    expect(res.connections).toHaveLength(1); // Validators
    expect(res.connections[0]).toContain("validators");

    const md = readSummary(res.summaryPath);
    expect(md).toContain("## Connections to existing notes");
  });

  test("is idempotent on the source path: re-ingest rewrites, does not duplicate", () => {
    const first = ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    const second = ingestSource(vault, INPUT, { agent: "claude", now: LATER });
    expect(second.created).toBe(false);
    expect(second.summaryPath).toBe(first.summaryPath);
    // created_at is preserved from the first ingest; updated_at advanced.
    expect(first.created).toBe(true);
    const md = readSummary(second.summaryPath);
    expect(md).toContain('created_at: "2026-06-13T12:00:00Z"');
    expect(md).toContain('updated_at: "2026-06-14T09:00:00Z"');
  });

  test("entity pages cite the source in their body", () => {
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.summaryPath).toBeTruthy();
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.body).toContain("[[Articles/restaking-primer.md]]");
  });

  test("planId records the ingested vault-file source into the plan checkpoint (t_ba1fa5f6)", () => {
    // The checkpoint is only recorded for a real vault file, so materialize it.
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles", "restaking-primer.md"), "content", "utf8");
    const planId = computePlanId("Articles", ["Articles/restaking-primer.md"]);
    ingestSource(vault, INPUT, { agent: "claude", now: NOW, planId });
    const cp = readCheckpoint(vault, planId);
    expect(cp?.completed).toEqual(["Articles/restaking-primer.md"]);
  });

  test("without planId no checkpoint is written", () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, "Articles", "restaking-primer.md"), "content", "utf8");
    const planId = computePlanId("Articles", ["Articles/restaking-primer.md"]);
    ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(readCheckpoint(vault, planId)).toBeNull();
  });
});

describe("ingestSource pre-extract pass (P4, t_ef786747)", () => {
  const CODE_INPUT = {
    sourcePath: "Code/widget.ts",
    summary: "A widget module.",
    extraction: { entities: [{ category: "concept", name: "Widget" }], relations: [] },
  };

  function writeCode(): void {
    mkdirSync(join(vault, "Code"), { recursive: true });
    writeFileSync(
      join(vault, "Code", "widget.ts"),
      'import { h } from "./dom";\nexport class Widget extends Base {}\n',
      "utf8",
    );
  }

  test("returns deterministic code-structure seeds when the pass is on", () => {
    writeCode();
    const res = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(true);
    if (res.preExtract?.extracted) {
      expect(res.preExtract.language).toBe("typescript");
      expect(res.preExtract.entities).toEqual([{ kind: "class", name: "Widget" }]);
      expect(res.preExtract.edges).toEqual([
        { kind: "imports", from: "Code/widget.ts", to: "./dom" },
        { kind: "inherits", from: "Widget", to: "Base" },
      ]);
    }
  });

  test("with the pass off the result carries no seeds and the page is byte-identical", () => {
    writeCode();
    // First ingest creates the entity + page; a second (idempotent) re-ingest
    // reaches a stable state where the entity already exists, so the page no
    // longer changes between runs. Compare that stable off-page against an
    // on-page: the only variable left is the pass, proving it never leaks.
    ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW });
    const off = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW });
    const offBytes = readSummary(off.summaryPath);
    expect(off.preExtract).toBeUndefined();

    const on = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(readSummary(on.summaryPath)).toBe(offBytes);
    expect(on.preExtract?.extracted).toBe(true);
  });

  test("a non-code source reports unextracted rather than a fake empty success", () => {
    // INPUT's source is not materialized on disk, so there is nothing to read.
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(false);
  });
});

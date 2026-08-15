/**
 * Extraction-intake primitive (shared lib a of the Knowledge Provenance
 * suite). The single validated, idempotent path that turns an agent-supplied
 * typed extraction (entities + relations) into entity-registry records, with
 * provenance stamped on newly created pages. Shared by the source-ingest
 * pipeline and on-write NER so neither reinvents entity intake.
 *
 * The model that produced the extraction lives on the agent side of the MCP
 * boundary; this primitive never calls a model. It only validates the typed
 * payload, refuses a malformed one with no partial write, and commits through
 * the registry's own duplicate-refusing upsert.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { getEntity, listEntities } from "../../../../src/core/brain/entities/registry.ts";
import {
  intakeExtraction,
  IntakeValidationError,
  type ExtractionIntake,
  type IntakeOptions,
} from "../../../../src/core/brain/intake/extract-intake.ts";
import type { Provenance } from "../../../../src/core/brain/provenance/provenance.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");

const DEFAULT_SOURCE = "Articles/restaking-primer.md";

/**
 * Every intake must cite a source, and a source is trusted only when its file
 * is on disk (GitHub #160). These helpers seed the file and build the
 * provenance so each test below states the source it means rather than the
 * plumbing that makes it real.
 */
function seed(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `bytes of ${rel}\n`, "utf8");
}

function citing(rel: string): Provenance {
  seed(rel);
  return { level: "stated", sources: [`[[${rel}]]`], premises: [] };
}

function opts(agent: string, rel = DEFAULT_SOURCE): IntakeOptions {
  return { agent, now: NOW, provenance: citing(rel) };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-intake-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-intake-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

const SAMPLE: ExtractionIntake = {
  entities: [
    { category: "concept", name: "Restaking" },
    { category: "concept", name: "Validators", aliases: ["Validator nodes"] },
  ],
  relations: [{ from: "Restaking", relation: "related", to: "Validators" }],
};

describe("intakeExtraction - happy path", () => {
  test("creates the extracted entities and reports their ids", () => {
    const res = intakeExtraction(vault, SAMPLE, opts("ingest-agent"));
    expect(res.entitiesCreated).toHaveLength(2);
    expect(res.entitiesUpdated).toHaveLength(0);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.name).toBe("Restaking");
  });

  test("applies the typed relations onto the from-entity", () => {
    const res = intakeExtraction(vault, SAMPLE, opts("ingest-agent"));
    expect(res.relationsApplied).toBe(1);
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    const related = restaking?.relations.find((r) => r.relation === "related");
    expect(related?.target).toContain("validators");
  });

  test("stamps the provenance Sources section into a newly created entity body", () => {
    intakeExtraction(vault, SAMPLE, opts("ingest-agent"));
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.body).toContain("## Sources");
    expect(restaking?.body).toContain("[[Articles/restaking-primer.md]]");
  });
});

describe("intakeExtraction - idempotency", () => {
  test("a second identical intake creates nothing new and does not duplicate", () => {
    intakeExtraction(vault, SAMPLE, opts("ingest-agent"));
    const second = intakeExtraction(vault, SAMPLE, opts("ingest-agent"));
    expect(second.entitiesCreated).toHaveLength(0);
    expect(second.entitiesUpdated).toHaveLength(2);
    expect(listEntities(vault, { category: "concept" })).toHaveLength(2);
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    const relatedEdges = restaking?.relations.filter((r) => r.relation === "related") ?? [];
    expect(relatedEdges).toHaveLength(1);
  });

  test("does not clobber an existing entity body on update", () => {
    intakeExtraction(vault, SAMPLE, opts("ingest-agent", "Articles/a.md"));
    intakeExtraction(vault, SAMPLE, opts("ingest-agent", "Articles/b.md"));
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    // First source is preserved; the update did not overwrite the body.
    expect(restaking?.body).toContain("[[Articles/a.md]]");
  });
});

describe("intakeExtraction - validation refuses malformed payloads with no partial write", () => {
  test("rejects an empty entity name", () => {
    const bad: ExtractionIntake = { entities: [{ category: "concept", name: "  " }] };
    expect(() => intakeExtraction(vault, bad, opts("a"))).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("rejects an unknown relation before writing any entity", () => {
    const bad: ExtractionIntake = {
      entities: [
        { category: "concept", name: "A" },
        { category: "concept", name: "B" },
      ],
      relations: [{ from: "A", relation: "causes", to: "B" }],
    };
    expect(() => intakeExtraction(vault, bad, opts("a"))).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("rejects a relation endpoint not declared among the intake entities", () => {
    const bad: ExtractionIntake = {
      entities: [{ category: "concept", name: "A" }],
      relations: [{ from: "A", relation: "related", to: "Ghost" }],
    };
    expect(() => intakeExtraction(vault, bad, opts("a"))).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("rejects a self-relation", () => {
    const bad: ExtractionIntake = {
      entities: [{ category: "concept", name: "A" }],
      relations: [{ from: "A", relation: "related", to: "A" }],
    };
    expect(() => intakeExtraction(vault, bad, opts("a"))).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });

  test("rejects an invalid entity category", () => {
    const bad: ExtractionIntake = { entities: [{ category: "Has Space", name: "A" }] };
    expect(() => intakeExtraction(vault, bad, opts("a"))).toThrow(IntakeValidationError);
    expect(listEntities(vault)).toHaveLength(0);
  });
});

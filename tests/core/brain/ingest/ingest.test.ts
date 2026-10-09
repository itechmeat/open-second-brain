/**
 * Source-ingest pipeline (Knowledge Provenance suite). One text-bearing source
 * becomes entity/concept pages plus a per-source summary page that backlinks
 * the source, lists the entities it introduced, and lists its connections to
 * pre-existing material. Idempotent on the source path. OSB runs no model -
 * the agent supplies the extraction and the summary prose.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

import { IS_WINDOWS } from "../../../helpers/platform.ts";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import {
  getEntity,
  listEntities,
  upsertEntity,
} from "../../../../src/core/brain/entities/registry.ts";
import {
  ingestSource,
  PRE_EXTRACT_MAX_SOURCE_BYTES,
  readSourceBounded,
} from "../../../../src/core/brain/ingest/ingest.ts";
import { manifestPath, hashBytes } from "../../../../src/core/brain/ingest/content-manifest.ts";
import { computeExtractionContractFingerprint } from "../../../../src/core/brain/ingest/contract.ts";
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

/**
 * A source is trusted only when its file exists (GitHub #160), and an
 * untrusted ingest quarantines the entities it introduces - so every case
 * that reads its entities back from the canonical registry seeds the source
 * it names. The cases that deliberately do NOT seed it are marked.
 */
function seedSourceFile(rel = INPUT.sourcePath): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "the source bytes\n", "utf8");
}

/** Write raw bytes as the content manifest, for the corrupted-manifest cases. */
function writeManifestBytes(bytes: string): void {
  const path = manifestPath(vault);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, bytes, "utf8");
}

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
    seedSourceFile();
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
    seedSourceFile();

    const res = ingestSource(vault, INPUT, { agent: "claude", now: LATER });
    expect(res.entitiesCreated).toHaveLength(1); // Restaking
    expect(res.connections).toHaveLength(1); // Validators
    expect(res.connections[0]).toContain("validators");

    const md = readSummary(res.summaryPath);
    expect(md).toContain("## Connections to existing notes");
  });

  test("is idempotent on the source path: re-ingest rewrites, does not duplicate", () => {
    seedSourceFile();
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
    seedSourceFile();
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.summaryPath).toBeTruthy();
    const restaking = getEntity(vault, { category: "concept", query: "Restaking" });
    expect(restaking?.body).toContain("[[Articles/restaking-primer.md]]");
  });

  test("planId records the ingested vault-file source into the plan checkpoint (t_ba1fa5f6)", () => {
    // The checkpoint is only recorded for a real vault file, so materialize it.
    seedSourceFile();
    const planId = computePlanId(
      "Articles",
      ["Articles/restaking-primer.md"],
      computeExtractionContractFingerprint(vault),
    );
    ingestSource(vault, INPUT, { agent: "claude", now: NOW, planId });
    const cp = readCheckpoint(vault, planId);
    expect(cp?.completed).toEqual(["Articles/restaking-primer.md"]);
  });

  test("without planId no checkpoint is written", () => {
    seedSourceFile();
    const planId = computePlanId(
      "Articles",
      ["Articles/restaking-primer.md"],
      computeExtractionContractFingerprint(vault),
    );
    ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(readCheckpoint(vault, planId)).toBeNull();
  });

  test("a plan id the checkpoint store cannot use is refused before anything is written", () => {
    // A plan id becomes a checkpoint filename, so the store refuses
    // anything but lowercase hex. Swallowed - as it was - the ingest
    // succeeded, no checkpoint was EVER written for that plan, and
    // `--reconcile` then reported every source as never ingested.
    seedSourceFile();
    expect(() =>
      ingestSource(vault, INPUT, { agent: "claude", now: NOW, planId: "docs-migration" }),
    ).toThrow(/plan id/);
    // Refused at the boundary: the summary page was not written either.
    expect(existsSync(join(vault, "Brain", "sources"))).toBe(false);
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

  test("a relative import binds to a sibling already in the content manifest", () => {
    writeCode();
    mkdirSync(join(vault, "Code"), { recursive: true });
    writeFileSync(join(vault, "Code", "dom.ts"), "export const h = 1;\n", "utf8");
    // The sibling lands in the manifest first; the importer's own pass runs
    // before its own manifest entry is written, so binding needs a prior
    // ingest of the imported file - exactly the incremental reality.
    ingestSource(
      vault,
      {
        sourcePath: "Code/dom.ts",
        summary: "A dom module.",
        extraction: { entities: [{ category: "concept", name: "Dom" }], relations: [] },
      },
      { agent: "claude", now: NOW },
    );
    const res = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(true);
    if (res.preExtract?.extracted) {
      expect(res.preExtract.edges[0]).toEqual({
        kind: "imports",
        from: "Code/widget.ts",
        to: "./dom",
        resolvedTo: "Code/dom.ts",
      });
    }
  });

  test.each([
    ["corrupted JSON", "{ not json", /ingest manifest is corrupted JSON/],
    [
      "an unsupported schema_version",
      JSON.stringify({ schema_version: 999, entries: {} }),
      /ingest manifest schema_version 999 not supported/,
    ],
  ])(
    "a manifest with %s surfaces its own error before anything is written",
    (_label, bytes, error) => {
      writeCode();
      writeManifestBytes(bytes);
      expect(() =>
        ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true }),
      ).toThrow(error);
      // The named manifest error must stop the ingest at the pre-extract read,
      // not get reported as unreadable source bytes while the page is written.
      expect(existsSync(join(vault, "Brain", "sources"))).toBe(false);
    },
  );

  test("a non-code source never reads the manifest", () => {
    // Deliberately unseeded, so the ingest itself never reaches the manifest
    // update either: a corrupted manifest is then visible only to the pass.
    writeManifestBytes("{ not json");
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(false);
    if (res.preExtract !== undefined && res.preExtract.extracted === false) {
      expect(res.preExtract.reason).toContain("unsupported source extension");
    }
  });

  test("a code source with no bytes on disk never reads the manifest", () => {
    writeManifestBytes("{ not json");
    const res = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(false);
    if (res.preExtract !== undefined && res.preExtract.extracted === false) {
      expect(res.preExtract.reason).toContain("no readable file bytes");
    }
  });

  test("a code source the caller may not read answers as one with no bytes", () => {
    writeCode();
    const refused = ingestSource(vault, CODE_INPUT, {
      agent: "claude",
      now: NOW,
      preExtract: true,
      readable: (rel) => rel !== CODE_INPUT.sourcePath,
    });
    expect(refused.preExtract).toEqual({
      extracted: false,
      reason: `source has no readable file bytes for code-structure pre-extraction: ${CODE_INPUT.sourcePath}`,
    });
    const allowed = ingestSource(vault, CODE_INPUT, {
      agent: "claude",
      now: NOW,
      preExtract: true,
      readable: () => true,
    });
    expect(allowed.preExtract?.extracted).toBe(true);
  });

  test("a code source larger than the read limit is skipped by name", () => {
    writeCode();
    writeFileSync(
      join(vault, "Code", "widget.ts"),
      `export const big = "${"x".repeat(PRE_EXTRACT_MAX_SOURCE_BYTES)}";\n`,
    );
    const res = ingestSource(vault, CODE_INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract).toEqual({
      extracted: false,
      reason: `source is larger than ${PRE_EXTRACT_MAX_SOURCE_BYTES} bytes; code-structure pre-extraction skipped: ${CODE_INPUT.sourcePath}`,
    });
  });

  // Windows has no FIFOs.
  test.skipIf(IS_WINDOWS)(
    "a FIFO code source has no readable bytes and the read does not block",
    () => {
      mkdirSync(join(vault, "Code"), { recursive: true });
      const fifo = join(vault, "Code", "widget.ts");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      // A writer that holds the FIFO open for two seconds and writes
      // nothing: a reader that blocks fails on its answer after two seconds
      // instead of hanging the run.
      const writer = Bun.spawn(["sh", "-c", 'exec 3>"$0"; exec sleep 2', fifo]);
      try {
        const res = ingestSource(vault, CODE_INPUT, {
          agent: "claude",
          now: NOW,
          preExtract: true,
        });
        expect(res.preExtract).toEqual({
          extracted: false,
          reason: `source has no readable file bytes for code-structure pre-extraction: ${CODE_INPUT.sourcePath}`,
        });
      } finally {
        writer.kill();
      }
    },
  );

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
    // Deliberately unseeded: INPUT's source is not materialized on disk, so
    // there is nothing to read (and the ingest quarantines its entities).
    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW, preExtract: true });
    expect(res.preExtract?.extracted).toBe(false);
  });

  test("a source_path that climbs out of the vault is never read (t_sec_ingest_containment)", () => {
    // The outside file exists and is parseable Python; if the pre-extract read
    // skipped containment, its class names would land in the result.
    const outside = mkdtempSync(join(tmpdir(), "o2b-ingest-outside-"));
    try {
      const outsideFile = join(outside, "secret-module.py");
      writeFileSync(outsideFile, "class OutsideSecret:\n    pass\n", "utf8");
      // A relative path from the vault to that file is, by construction, a
      // `..`-climbing traversal string - exactly what a caller would supply.
      const traversalPath = relative(vault, outsideFile);
      const res = ingestSource(
        vault,
        {
          sourcePath: traversalPath,
          summary: "An outside file.",
          extraction: { entities: [{ category: "concept", name: "Outside" }], relations: [] },
        },
        { agent: "claude", now: NOW, preExtract: true },
      );
      expect(res.preExtract?.extracted).toBe(false);
      if (res.preExtract !== undefined && res.preExtract.extracted === false) {
        expect(res.preExtract.reason).toContain("does not resolve inside this vault");
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/** Report `size` from the next fstat, as if the file grew after it. */
function fstatReportsSize(size: number): { mockRestore(): void; mock: { calls: unknown[] } } {
  const real = fs.fstatSync;
  return spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const stat = real(fd);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size });
  }) as typeof fs.fstatSync);
}

describe("readSourceBounded", () => {
  const READ_LIMIT = 64;

  test("a source read whole returns its text and its exact bytes", () => {
    const abs = join(vault, "small.txt");
    writeFileSync(abs, "caf\u00e9\n");
    const read = readSourceBounded(abs, READ_LIMIT);
    expect(read.text).toBe("caf\u00e9\n");
    expect(read.unread).toBeUndefined();
    expect(Buffer.from(read.bytes ?? new Uint8Array()).equals(fs.readFileSync(abs))).toBe(true);
  });

  test("a source that grows after the fstat but stays under the cap is read whole", () => {
    const abs = join(vault, "grown.txt");
    const body = "y".repeat(40);
    writeFileSync(abs, body);
    const spy = fstatReportsSize(16);
    try {
      const read = readSourceBounded(abs, READ_LIMIT);
      expect(spy.mock.calls.length).toBe(1);
      expect(read.text).toBe(body);
    } finally {
      spy.mockRestore();
    }
  });

  test("a source that grows past the cap after the fstat is refused", () => {
    const abs = join(vault, "big.txt");
    writeFileSync(abs, "z".repeat(READ_LIMIT + 10));
    const spy = fstatReportsSize(16);
    try {
      const read = readSourceBounded(abs, READ_LIMIT);
      expect(spy.mock.calls.length).toBe(1);
      expect(read).toEqual({ text: null, unread: "larger than the read limit" });
    } finally {
      spy.mockRestore();
    }
  });

  test("a source over the cap at the fstat is refused without a read", () => {
    const abs = join(vault, "over.txt");
    writeFileSync(abs, "z".repeat(READ_LIMIT + 1));
    expect(readSourceBounded(abs, READ_LIMIT)).toEqual({
      text: null,
      unread: "larger than the read limit",
    });
  });

  test("a directory is not a regular file", () => {
    mkdirSync(join(vault, "dir.txt"));
    expect(readSourceBounded(join(vault, "dir.txt"), READ_LIMIT)).toEqual({
      text: null,
      unread: "not a regular file",
    });
  });
});

describe("ingestSource — extraction contract (t_586d5d8b)", () => {
  test("ingesting under a v1 manifest rewrites the summary and lands the manifest as v2", () => {
    seedSourceFile();
    // Pre-fingerprint era manifest: the source's live hash recorded, no
    // contract. The ingest records the source under the live contract, so the
    // manifest it rewrites must land as v2 stamped with the fingerprint.
    writeManifestBytes(
      JSON.stringify({
        schema_version: 1,
        entries: {
          [INPUT.sourcePath]: hashBytes(readFileSync(join(vault, INPUT.sourcePath))),
        },
      }),
    );

    const res = ingestSource(vault, INPUT, { agent: "claude", now: NOW });
    expect(res.created).toBe(true);
    expect(readSummary(res.summaryPath)).toContain("kind: brain-source");

    const onDisk = JSON.parse(readFileSync(manifestPath(vault), "utf8")) as {
      schema_version: number;
      contract: { fingerprint: string } | null;
    };
    expect(onDisk.schema_version).toBe(2);
    expect(onDisk.contract?.fingerprint).toBe(computeExtractionContractFingerprint(vault));
  });
});

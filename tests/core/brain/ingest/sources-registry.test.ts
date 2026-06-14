/**
 * Ingested-source registry (Brain Portability & Interop suite, Unit C
 * support). Read/list/delete over the `kind: brain-source` summary pages
 * the ingest pipeline writes under Brain/sources. The SDK source CRUD
 * delegates here. Guarded: an id that resolves outside Brain/sources is
 * treated as not-found, never deleted.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import {
  deleteIngestedSource,
  getIngestedSource,
  listIngestedSources,
} from "../../../../src/core/brain/ingest/sources-registry.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sources-reg-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-sources-reg-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function seedSource(sourcePath: string): string {
  const res = ingestSource(
    vault,
    {
      sourcePath,
      summary: `summary of ${sourcePath}`,
      extraction: { entities: [{ category: "concept", name: "Topic" }], relations: [] },
    },
    { agent: "claude", now: new Date("2026-01-01T00:00:00Z") },
  );
  return res.summaryPath;
}

describe("ingested-source registry", () => {
  test("lists ingested source pages, sorted by path", () => {
    seedSource("Articles/a.md");
    seedSource("Articles/b.md");
    const sources = listIngestedSources(vault);
    expect(sources.length).toBe(2);
    const paths = sources.map((s) => s.path);
    expect(paths).toEqual([...paths].toSorted());
    expect(sources[0]!.sourcePath).toBeDefined();
  });

  test("ignores non-source markdown in the sources dir", () => {
    seedSource("Articles/a.md");
    // A stray markdown file without the brain-source kind is not a source.
    writeFileSync(join(vault, "Brain/sources/stray.md"), "---\ntitle: Stray\n---\nx\n");
    expect(listIngestedSources(vault).length).toBe(1);
  });

  test("getIngestedSource returns the record with its body, else null", () => {
    const id = seedSource("Articles/a.md");
    const detail = getIngestedSource(vault, id);
    expect(detail).not.toBeNull();
    expect(detail!.path).toBe(id);
    expect(detail!.body).toContain("summary of Articles/a.md");
    expect(getIngestedSource(vault, "Brain/sources/does-not-exist.md")).toBeNull();
  });

  test("deleteIngestedSource removes the page and reports whether it existed", () => {
    const id = seedSource("Articles/a.md");
    expect(deleteIngestedSource(vault, id)).toBe(true);
    expect(getIngestedSource(vault, id)).toBeNull();
    expect(deleteIngestedSource(vault, id)).toBe(false);
  });

  test("an id outside Brain/sources is treated as not-found, never deleted", () => {
    writeFileSync(join(vault, "Outside.md"), "important user note");
    expect(deleteIngestedSource(vault, "Outside.md")).toBe(false);
    expect(getIngestedSource(vault, "Outside.md")).toBeNull();
    // The unrelated file is untouched.
    expect(deleteIngestedSource(vault, "../escape.md")).toBe(false);
  });
});

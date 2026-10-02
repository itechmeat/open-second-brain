/**
 * Capture scope on ingest summary pages. The scope follows the lane the
 * intake already decided for the cited source: a vault file the summary was
 * built from is `full-local` and writes nothing new (the page stays
 * byte-identical to the pre-scope output), a source with no local bytes is
 * `url-only` and the page says so in `capture_scope`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import {
  CAPTURE_SCOPE,
  CAPTURE_SCOPE_KEY,
} from "../../../../src/core/brain/provenance/capture-scope.ts";
import { parseFrontmatter } from "../../../../src/core/vault.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const LATER = new Date("2026-06-14T09:00:00Z");
const LOCAL_SOURCE = "Articles/a.md";
const URL_SOURCE = "https://example.test/articles/a";

/** The summary page the base release (v1.66.0) wrote for {@link LOCAL_SOURCE}. */
const BASE_LOCAL_PAGE =
  '---\nkind: brain-source\nsource_path: Articles/a.md\nsource_hash: f84f9777c1d1c4b660d50d094897c7b95dab0108683ad9343c481a99d277c20e\nprovenance: stated\ncreated_at: "2026-06-13T12:00:00Z"\nupdated_at: "2026-06-13T12:00:00Z"\ntags: [brain, brain/source]\n---\n\nA summary.\n\n## Sources\n\n- [[Articles/a.md]]\n\n## Entities\n\n- [[ent-concept-alpha]]\n';

function input(sourcePath: string) {
  return {
    sourcePath,
    summary: "A summary.",
    extraction: { entities: [{ category: "concept", name: "Alpha" }], relations: [] },
  };
}

/**
 * A re-ingest of the same extraction lists its entity again as a connection
 * (it now pre-exists), so the inertness case carries no entities: what it
 * pins is that the stamp itself never churns the page.
 */
function bareInput(sourcePath: string) {
  return { sourcePath, summary: "A summary.", extraction: { entities: [], relations: [] } };
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ingest-scope-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ingest-scope-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("ingestSource capture scope", () => {
  test("an in-vault source is full-local and the page is byte-identical to the base output", () => {
    mkdirSync(join(vault, "Articles"), { recursive: true });
    writeFileSync(join(vault, LOCAL_SOURCE), "bytes\n", "utf8");

    const result = ingestSource(vault, input(LOCAL_SOURCE), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.fullLocal);
    expect(readFileSync(join(vault, result.summaryPath), "utf8")).toBe(BASE_LOCAL_PAGE);
  });

  test("a URL source stamps capture_scope: url-only and reports it", () => {
    const result = ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: NOW });

    expect(result.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    const [meta] = parseFrontmatter(join(vault, result.summaryPath));
    expect(meta[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.urlOnly);
  });

  test("re-ingesting an unchanged URL source is inert", () => {
    const first = ingestSource(vault, bareInput(URL_SOURCE), { agent: "claude", now: NOW });
    const abs = join(vault, first.summaryPath);
    const bytes = readFileSync(abs, "utf8");
    const mtime = statSync(abs).mtimeMs;

    const second = ingestSource(vault, bareInput(URL_SOURCE), { agent: "claude", now: NOW });

    expect(second.captureScope).toBe(CAPTURE_SCOPE.urlOnly);
    expect(second.created).toBe(false);
    expect(readFileSync(abs, "utf8")).toBe(bytes);
    expect(statSync(abs).mtimeMs).toBe(mtime);
  });

  test("a later re-ingest keeps the stamp beside the bumped updated_at", () => {
    ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: NOW });
    const again = ingestSource(vault, input(URL_SOURCE), { agent: "claude", now: LATER });
    const [meta] = parseFrontmatter(join(vault, again.summaryPath));
    expect(meta[CAPTURE_SCOPE_KEY]).toBe(CAPTURE_SCOPE.urlOnly);
  });
});

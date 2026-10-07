/**
 * The keyword-index widening collector for the write-receipt
 * near-duplicate hint. It pulls BM25 candidates from the existing search
 * index so a write can be compared with pages outside its own directory,
 * re-reads every candidate from disk, and answers at the caller's reach.
 * An index that cannot be opened is a named status, never a failed write.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import {
  NEAR_DUPLICATE_WIDENING_TOP_K,
  READ_ALL_REFS,
} from "../../../src/core/brain/near-duplicate.ts";
import { collectWideningCandidates } from "../../../src/core/brain/page-lint-widening.ts";
import { tokenise } from "../../../src/core/brain/similarity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";

const BODY = "orchard lantern copper meadow violet harbor";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-widening-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-widening-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function writeNote(rel: string, body: string, frontmatter = "title: T"): string {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return rel;
}

async function indexed() {
  const config = resolveSearchConfig({ vault });
  await indexVault(config, { force: true });
  return config;
}

describe("collectWideningCandidates", () => {
  test("a near-identical page in another directory is returned, re-read from disk", async () => {
    const earlier = writeNote("Projects/Earlier.md", BODY, "title: Earlier\nsession: atlas");
    const config = await indexed();
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(config, vault, [written], READ_ALL_REFS);
    expect(result.status).toBe("used");
    const found = result.candidates.find((c) => c.page === earlier);
    expect(found).toBeDefined();
    expect([...found!.tokens].toSorted()).toEqual([...tokenise(BODY)].toSorted());
    // The scope bucket comes from the page's own frontmatter.
    expect(found!.scopeKey).toContain("atlas");
  });

  test("a withheld page is dropped before it is returned", async () => {
    writeNote("Projects/Hidden.md", BODY);
    const visible = writeNote("Projects/Visible.md", BODY);
    const config = await indexed();
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(
      config,
      vault,
      [written],
      (rel) => rel !== "Projects/Hidden.md",
    );
    const pages = result.candidates.map((c) => c.page);
    expect(pages).toContain(visible);
    expect(pages).not.toContain("Projects/Hidden.md");
  });

  test("a page deleted from disk but still in the index is dropped", async () => {
    const gone = writeNote("Projects/Gone.md", BODY);
    const config = await indexed();
    unlinkSync(join(vault, gone));
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(config, vault, [written], READ_ALL_REFS);
    expect(result.status).toBe("used");
    expect(result.candidates.map((c) => c.page)).not.toContain(gone);
  });

  test("a missing index is a named status with no candidates", async () => {
    const config = resolveSearchConfig({ vault });
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(config, vault, [written], READ_ALL_REFS);
    expect(result).toEqual({
      status: "index_unavailable",
      candidates: [],
      detail: "INDEX_MISSING",
    });
  });

  test("an index that is there but will not open names a different failure", async () => {
    const config = resolveSearchConfig({ vault });
    mkdirSync(join(config.dbPath, ".."), { recursive: true });
    writeFileSync(config.dbPath, "not a database");
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(config, vault, [written], READ_ALL_REFS);
    expect(result).toEqual({
      status: "index_unavailable",
      candidates: [],
      detail: "INDEX_UNREADABLE",
    });
  });

  test("the keyword pull is bounded by the widening top-k", async () => {
    for (let i = 0; i < NEAR_DUPLICATE_WIDENING_TOP_K + 10; i++) {
      writeNote(`Projects/AA-Copy-${String(i).padStart(2, "0")}.md`, BODY);
    }
    const config = await indexed();
    const written = writeNote("Notes/Later.md", BODY);
    const result = await collectWideningCandidates(config, vault, [written], READ_ALL_REFS);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.length).toBeLessThanOrEqual(NEAR_DUPLICATE_WIDENING_TOP_K);
  });

  test("a rewritten long page's own indexed chunks do not crowd out a lookalike", async () => {
    // Every section repeats the probe tokens, so each of the page's own
    // chunks outranks the lookalike under BM25.
    const filler = Array.from({ length: 160 }, (_, i) => `filler${i}`).join(" ");
    const sections = Array.from(
      { length: NEAR_DUPLICATE_WIDENING_TOP_K + 10 },
      (_, i) => `## Section ${i}\n\n${BODY} ${BODY} ${BODY}\n\n${filler}`,
    );
    const long = writeNote("Notes/Long.md", sections.join("\n\n"));
    const lookalike = writeNote("Projects/Lookalike.md", BODY);
    const config = await indexed();
    const store = await Store.open(config, { mode: "read" });
    try {
      const ownId = store.getDocumentIdByPath(long);
      expect(ownId).not.toBeNull();
      expect(store.chunksForDocument(ownId!).length).toBeGreaterThan(NEAR_DUPLICATE_WIDENING_TOP_K);
    } finally {
      await store.close();
    }
    writeNote(long, `${sections.join("\n\n")}\n\nOne more line.`);
    const result = await collectWideningCandidates(config, vault, [long], READ_ALL_REFS);
    const pages = result.candidates.map((c) => c.page);
    expect(pages).toContain(lookalike);
    expect(pages).not.toContain(long);
  });

  test("a candidate two written pages both pull in is listed once", async () => {
    const earlier = writeNote("Projects/Earlier.md", BODY);
    const config = await indexed();
    const first = writeNote("Notes/Later.md", BODY);
    const second = writeNote("Notes/Later-Again.md", BODY);
    const result = await collectWideningCandidates(config, vault, [first, second], READ_ALL_REFS);
    expect(result.candidates.filter((c) => c.page === earlier)).toHaveLength(1);
  });

  test("no embedding provider is imported", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "..", "src", "core", "brain", "page-lint-widening.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+"[^"]*search\/embeddings\//);
  });
});

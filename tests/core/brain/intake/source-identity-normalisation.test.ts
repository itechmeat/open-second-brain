/**
 * One source identity, one normaliser (GitHub #160, adjacent defect).
 *
 * The wikilink strip lived inline in the trust classifier and nowhere else.
 * Two consequences, both one-way.
 *
 * The regex handled the wrapper only, so `[[note|Alias]]` normalised to
 * `note|Alias` - a single segment without the vault's note extension, which
 * the shape gate reads as a bare hostname. A legitimate operator note, cited
 * the way Obsidian writes an aliased link, was quarantined; quarantine leaves
 * every ordinary read and only an explicit release brings the record back.
 * The anchor form `[[note#Section]]` failed the same way.
 *
 * The ingest pipeline did not strip the wrapper at all. A bracketed
 * `source_path` therefore canonicalised to `[[Articles/primer.md]]`, which
 * wrapped again into `[[[[Articles/primer.md]]]]` on the summary page and
 * hashed to a different source identity than the bare form - two summary pages
 * for one source, against the pipeline's documented idempotency.
 *
 * Both are the same missing seam, so both are pinned against the one exported
 * normaliser here.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../../../src/core/fs-atomic.ts";
import { ingestSource } from "../../../../src/core/brain/ingest/ingest.ts";
import { listIngestedSources } from "../../../../src/core/brain/ingest/sources-registry.ts";
import {
  classifySourceOrigin,
  normalizeSourceIdentity,
} from "../../../../src/core/brain/intake/source-trust.ts";
import { INTAKE_TRUST } from "../../../../src/core/brain/trust/untrusted-provenance.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-06-13T12:00:00Z");
const SOURCE = "Articles/primer.md";

/** Every wikilink spelling Obsidian accepts for the same target. */
const EQUIVALENT_SPELLINGS: ReadonlyArray<string> = Object.freeze([
  SOURCE,
  `[[${SOURCE}]]`,
  `[[${SOURCE}|Primer]]`,
  `[[${SOURCE}#Section]]`,
  `[[${SOURCE}#Section|Primer]]`,
  `  [[${SOURCE}]]  `,
]);

function seed(rel: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, "the source bytes\n", "utf8");
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-source-identity-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-source-identity-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("normalizeSourceIdentity", () => {
  test("every wikilink spelling of one target resolves to the same identity", () => {
    for (const spelling of EQUIVALENT_SPELLINGS) {
      expect(normalizeSourceIdentity(spelling)).toBe(SOURCE);
    }
  });

  test("a pipe or a hash outside a wikilink belongs to the identity, not to its grammar", () => {
    // `|` and `#` mean alias and anchor only INSIDE `[[...]]`. A bare path is
    // not wikilink syntax, so stripping there would rewrite the caller's
    // identity into a different one.
    expect(normalizeSourceIdentity("https://example.com/a#frag")).toBe(
      "https://example.com/a#frag",
    );
    expect(normalizeSourceIdentity("Notes/odd#name.md")).toBe("Notes/odd#name.md");
  });
});

describe("classifySourceOrigin - an aliased link is not a hostname", () => {
  test("the aliased and anchored forms of a real note are trusted like the bare one", () => {
    seed(SOURCE);
    for (const spelling of EQUIVALENT_SPELLINGS) {
      expect(classifySourceOrigin(vault, spelling).trust).toBe(INTAKE_TRUST.trusted);
    }
  });
});

describe("ingestSource - a bracketed source is the same source", () => {
  const INPUT = {
    summary: "An overview.",
    extraction: { entities: [{ category: "concept", name: "Restaking" }], relations: [] },
  };

  test("bracketed and bare spellings write one summary page, not two", () => {
    seed(SOURCE);
    const bare = ingestSource(
      vault,
      { ...INPUT, sourcePath: SOURCE },
      { agent: "claude", now: NOW },
    );
    const bracketed = ingestSource(
      vault,
      { ...INPUT, sourcePath: `[[${SOURCE}]]` },
      { agent: "claude", now: NOW },
    );
    expect(bracketed.summaryPath).toBe(bare.summaryPath);
    expect(bracketed.created).toBe(false);
    expect(listIngestedSources(vault)).toHaveLength(1);
  });
});

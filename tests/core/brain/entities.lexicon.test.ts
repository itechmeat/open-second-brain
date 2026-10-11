/**
 * A1 (t_11d51443): the store-learned entity lexicon.
 *
 * The lexicon is a derived artifact (Brain/entities/lexicon.json,
 * `o2b.entity-lexicon.v1`) folded from a corpus walk over the vault's
 * operator pages - Brain root excluded, so session transcripts and every
 * other Brain-resident page are excluded with it. Nothing is hardcoded:
 * the only vocabulary is what the store itself reads. The suite pins the
 * fold's scope and case buckets, the S2-helper artifact round trip with
 * dataset-hash fail-open (mirroring the tuning-store family), the top-K
 * cap, and the pinned `EntityLexiconHandle` resolver.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { validateEntityLabel } from "../../../src/core/brain/entities/canonical.ts";
import {
  ENTITY_LEXICON_ARTIFACT_REL,
  ENTITY_LEXICON_CORPUS_SCOPE,
  ENTITY_LEXICON_SCHEMA_VERSION,
  ENTITY_LEXICON_TOP_K,
  __clearEntityLexiconCache,
  deriveEntityLexicon,
  deriveEntityLexiconFromPaths,
  entityLexiconDatasetHash,
  loadEntityLexicon,
  resolveEntityLexicon,
  writeEntityLexicon,
} from "../../../src/core/brain/entities/lexicon.ts";

let vault: string;
let configHome: string;

const NOW = new Date("2026-10-11T12:00:00Z");

beforeEach(() => {
  // Resolve-memo and identity pins are keyed by resolved root; tests run
  // many vaults in one process, so every test starts unpinned and clear.
  resetVaultIdentityPins();
  __clearEntityLexiconCache();
  vault = mkdtempSync(join(tmpdir(), "o2b-entity-lexicon-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-entity-lexicon-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  __clearEntityLexiconCache();
});

/** Write an operator corpus page (outside Brain) with the given body. */
function writeCorpusPage(rel: string, body: string): void {
  const path = join(vault, rel);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${body}\n`);
}

/** Derive the lexicon from the current corpus and persist it. */
function rebuild(): ReturnType<typeof deriveEntityLexicon> {
  const doc = deriveEntityLexicon(vault, { now: NOW });
  writeEntityLexicon(vault, doc);
  return doc;
}

describe("deriveEntityLexicon corpus scope", () => {
  test("folds tokens from operator pages and never from Brain-resident pages", () => {
    writeCorpusPage("alpha.md", "the runner kept notes about the setup. the notes were quick.");
    // A session-transcript-shaped page: it lives under the Brain root,
    // which the walk excludes whole, so none of its tokens may surface.
    writeCorpusPage(
      join("Brain", "sessions", "transcript-2026-10-11.md"),
      "Zebra QUOKKA herelocation transcript words appear here only.",
    );
    const doc = deriveEntityLexicon(vault, { now: NOW });
    const tokens = Object.keys(doc.entries);
    expect(tokens).toContain("notes");
    expect(tokens).toContain("runner");
    expect(tokens).toContain("quick");
    expect(tokens).not.toContain("zebra");
    expect(tokens).not.toContain("quokka");
    expect(tokens).not.toContain("transcript");
  });

  test("the artifact header asserts the walked scope", () => {
    writeCorpusPage("alpha.md", "the runner kept notes.");
    const doc = deriveEntityLexicon(vault, { now: NOW });
    expect(doc.schema).toBe(ENTITY_LEXICON_SCHEMA_VERSION);
    expect(ENTITY_LEXICON_SCHEMA_VERSION).toBe("o2b.entity-lexicon.v1");
    expect(doc.corpus_scope).toBe(ENTITY_LEXICON_CORPUS_SCOPE);
    // The header names the exclusion the scope relies on.
    expect(doc.corpus_scope).toContain("Brain");
    expect(doc.generated_at).toBe("2026-10-11T12:00:00Z");
  });
});

describe("deriveEntityLexicon case buckets", () => {
  test("counts lower, capitalised, and upper occurrences per lowercased token", () => {
    writeCorpusPage("atlas.md", "Atlas ran. atlas fell. ATLAS rose.");
    const doc = deriveEntityLexicon(vault, { now: NOW });
    expect(doc.entries["atlas"]).toEqual({ lower: 1, capitalised: 1, upper: 1 });
    expect(doc.caseful).toBe(true);
  });

  test("a caseless-script corpus resolves a caseless handle", () => {
    writeCorpusPage(join("notes", "han.md"), "项目 笔记 设置 关于 项目");
    const doc = rebuild();
    expect(doc.caseful).toBe(false);
    const handle = resolveEntityLexicon(vault);
    expect(handle).not.toBeNull();
    expect(handle!.caseful).toBe(false);
    // A caseless handle suppresses BOTH case-based verdicts: the label
    // gate degrades to the structural gate alone.
    expect(validateEntityLabel("MEETING NOTES", { lexicon: handle })).toEqual({ valid: true });
  });
});

describe("writeEntityLexicon / loadEntityLexicon", () => {
  test("round-trips through the S2 helper with schema and dataset hash", () => {
    writeCorpusPage("alpha.md", "the runner kept notes about the setup.");
    const doc = rebuild();
    const path = join(vault, ENTITY_LEXICON_ARTIFACT_REL);
    expect(ENTITY_LEXICON_ARTIFACT_REL).toBe(join("Brain", "entities", "lexicon.json"));
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(raw["schema"]).toBe("o2b.entity-lexicon.v1");
    expect(raw["generated_at"]).toBe("2026-10-11T12:00:00Z");
    expect(raw["dataset_hash"]).toBe(doc.dataset_hash);
    expect(raw["corpus_scope"]).toBe(ENTITY_LEXICON_CORPUS_SCOPE);

    // The artifact lives under the Brain root, so writing it does not
    // move the dataset it was derived from: the current hash still matches.
    const reloaded = loadEntityLexicon(vault, entityLexiconDatasetHash(vault));
    expect(reloaded).not.toBeNull();
    expect(reloaded!.entries).toEqual(doc.entries);
    expect(reloaded!.caseful).toBe(doc.caseful);
  });

  test("torn JSON reads as null and resolves as null (fail-open)", () => {
    writeCorpusPage("alpha.md", "the runner kept notes.");
    rebuild();
    const path = join(vault, ENTITY_LEXICON_ARTIFACT_REL);
    atomicWriteFileSync(path, "{not json");
    __clearEntityLexiconCache();
    expect(loadEntityLexicon(vault, entityLexiconDatasetHash(vault))).toBeNull();
    expect(resolveEntityLexicon(vault)).toBeNull();
  });

  test("a stale artifact (the corpus moved on) reads as null (fail-open)", () => {
    writeCorpusPage("alpha.md", "the runner kept notes.");
    rebuild();
    // The store grows after the rebuild: the stored derivation no longer
    // fingerprints the current input set, so it reads as absent.
    writeCorpusPage("beta.md", "fresh pages about the new setup arrived.");
    expect(loadEntityLexicon(vault, entityLexiconDatasetHash(vault))).toBeNull();
    // The resolver re-walks when the artifact changed or the cache cleared;
    // a cleared cache is how a fresh process meets the stale artifact.
    __clearEntityLexiconCache();
    expect(resolveEntityLexicon(vault)).toBeNull();
  });

  test("a missing artifact resolves as null: the gate degrades to the structural gate", () => {
    writeCorpusPage("alpha.md", "the runner kept notes.");
    expect(resolveEntityLexicon(vault)).toBeNull();
    expect(validateEntityLabel("MEETING NOTES")).toEqual({ valid: true });
  });
});

describe("top-K cap", () => {
  test("keeps the highest-total entries, ties broken lexicographically", () => {
    writeCorpusPage("alpha.md", "zebra zebra zebra yak yak quail vastus unicorn");
    const doc = deriveEntityLexicon(vault, { now: NOW, topK: 3 });
    expect(Object.keys(doc.entries)).toEqual(["zebra", "yak", "quail"]);
    // The default cap is the exported constant; a small corpus keeps
    // everything under it.
    expect(deriveEntityLexicon(vault, { now: NOW }).entries["vastus"]).toBeDefined();
    expect(ENTITY_LEXICON_TOP_K).toBeGreaterThan(0);
  });
});

describe("resolveEntityLexicon handle", () => {
  test("returns the pinned EntityLexiconHandle with learned commonness", () => {
    writeCorpusPage(
      "alpha.md",
      "notes about the setup. the notes were quick. Quantum was here. Quantum again.",
    );
    rebuild();
    const handle = resolveEntityLexicon(vault);
    expect(handle).not.toBeNull();
    expect(handle!.caseful).toBe(true);
    // Lowercase-heavy tokens are learned common words.
    expect(handle!.isCommonWord("notes")).toBe(true);
    expect(handle!.isCommonWord("about")).toBe(true);
    // Name-evidence-dominant tokens are not: "quantum" only ever
    // appeared capitalised.
    expect(handle!.isCommonWord("quantum")).toBe(false);
    // Unknown tokens are not common words either.
    expect(handle!.isCommonWord("unseentoken")).toBe(false);
    // The handle contract: tokens arrive LOWERCASED and the lookup is
    // exact - no re-normalisation inside the handle.
    expect(handle!.isCommonWord("Notes")).toBe(false);
  });

  test("a caseful handle lets the case-based verdicts fire end to end", () => {
    writeCorpusPage("alpha.md", "Atlas kept notes about the setup.");
    rebuild();
    const handle = resolveEntityLexicon(vault);
    expect(validateEntityLabel("MEETING NOTES", { lexicon: handle })).toEqual({
      valid: false,
      reason: "shouted-heading",
    });
  });
});

/**
 * Recall-quality review M5: the freshness signature must be a COARSE
 * corpus fingerprint - the page set plus per-page token-count buckets,
 * with no mtimes - so an edited vault keeps the gate resolving instead
 * of silently switching it off until a manual rebuild. Real corpus
 * shifts (pages added or removed, a token-count bucket crossed) still
 * expire the artifact honestly.
 */
describe("the corpus signature survives small edits (recall-quality M5)", () => {
  const BODY = "the runner kept notes about the setup. ";

  test("editing one page's body keeps the gate resolving", () => {
    writeCorpusPage("alpha.md", BODY.repeat(30));
    rebuild();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
    // A small in-place edit: reword every sentence (the content changes,
    // the learned entries lag) without moving the page's token-count
    // bucket. A fresh process - the cleared cache - must still resolve.
    writeCorpusPage("alpha.md", "a runner kept notes about the setup. ".repeat(30));
    __clearEntityLexiconCache();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
  });

  test("a small append that stays in the token-count bucket keeps it too", () => {
    writeCorpusPage("alpha.md", BODY.repeat(30));
    rebuild();
    writeCorpusPage("alpha.md", BODY.repeat(32));
    __clearEntityLexiconCache();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
  });

  test("an edit that crosses the token-count bucket expires the artifact", () => {
    writeCorpusPage("alpha.md", BODY.repeat(30));
    rebuild();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
    // Well past the next bucket boundary: the corpus genuinely shifted.
    writeCorpusPage("alpha.md", BODY.repeat(95));
    __clearEntityLexiconCache();
    expect(resolveEntityLexicon(vault)).toBeNull();
  });

  test("removing a page expires the artifact", () => {
    writeCorpusPage("alpha.md", BODY.repeat(30));
    writeCorpusPage("beta.md", "another page about the runner.");
    rebuild();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
    rmSync(join(vault, "beta.md"));
    __clearEntityLexiconCache();
    expect(resolveEntityLexicon(vault)).toBeNull();
  });

  test("the derive and freshness signatures agree without stat calls", () => {
    writeCorpusPage("alpha.md", BODY);
    const doc = deriveEntityLexicon(vault, { now: NOW });
    expect(doc.dataset_hash).toBe(entityLexiconDatasetHash(vault));
  });
});

describe("deriveEntityLexicon mid-derive races", () => {
  test("a corpus file removed between enumeration and fold does not poison the artifact", () => {
    writeCorpusPage("keep.md", "atlas kept notes about the setup.");
    writeCorpusPage("vanish.md", "orphanword vanishes mid derive.");
    // The race, reproduced deterministically: enumerate the corpus the way
    // the derive does, then lose a file BEFORE the fold reads it.
    const enumerated = [join(vault, "keep.md"), join(vault, "vanish.md")];
    rmSync(join(vault, "vanish.md"));

    const doc = deriveEntityLexiconFromPaths(vault, enumerated, { now: NOW });

    // The fold reflects what was enumerated and still readable: the
    // vanished file's tokens are gone by absence, the survivor's remain -
    // skipped by name, never folded as a silent empty page while the hash
    // vouches for its bytes.
    expect(doc.entries["atlas"]).toBeDefined();
    expect(doc.entries["orphanword"]).toBeUndefined();

    // The hash fingerprints the enumerated set with the vanished file
    // skipped, so it agrees with the fingerprint a fresh walk computes now:
    // the artifact does not fail freshness on every read until re-derived.
    expect(doc.dataset_hash).toBe(entityLexiconDatasetHash(vault));

    // End to end: the persisted artifact validates at resolve time.
    writeEntityLexicon(vault, doc);
    expect(loadEntityLexicon(vault, entityLexiconDatasetHash(vault))).not.toBeNull();
    expect(resolveEntityLexicon(vault)).not.toBeNull();
  });

  test("deriving over a fresh enumeration is the single-pass derive", () => {
    writeCorpusPage("alpha.md", "the runner kept notes about the setup.");
    const doc = deriveEntityLexicon(vault, { now: NOW });
    // The one-walk derive and the explicit-paths derive over the same
    // corpus agree on everything but are driven by the same enumeration.
    const paths = [join(vault, "alpha.md")];
    const explicit = deriveEntityLexiconFromPaths(vault, paths, { now: NOW });
    expect(explicit.entries).toEqual(doc.entries);
    expect(explicit.dataset_hash).toBe(doc.dataset_hash);
    expect(explicit.caseful).toBe(doc.caseful);
  });
});

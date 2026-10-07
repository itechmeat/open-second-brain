/**
 * `buildReviewCandidates` - read-only projection over what the next
 * dream pass would do. The helper drives `dream({ dryRun: true })`
 * so no persistent state mutates between invocations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { dream, DreamPreviewReadableError } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { dreamRunsDir } from "../../../src/core/brain/paths.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { buildReviewCandidates } from "../../../src/core/brain/review-candidates.ts";
import type { RetireSibling } from "../../../src/core/brain/retire-siblings.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rc-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rc-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("buildReviewCandidates", () => {
  test("returns a frozen report with all six top-level fields", async () => {
    const r = await buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Array.isArray(r.would_create)).toBe(true);
    expect(Array.isArray(r.would_promote)).toBe(true);
    expect(Array.isArray(r.would_retire)).toBe(true);
    expect(Array.isArray(r.would_supersede)).toBe(true);
    expect(Array.isArray(r.clusters_below_threshold)).toBe(true);
    expect(Array.isArray(r.gated_retires)).toBe(true);
  });

  test("returns empty arrays on a fresh-bootstrap vault", async () => {
    const r = await buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(r.would_create).toEqual([]);
    expect(r.would_promote).toEqual([]);
    expect(r.would_retire).toEqual([]);
    expect(r.would_supersede).toEqual([]);
    expect(r.clusters_below_threshold).toEqual([]);
    expect(r.gated_retires).toEqual([]);
  });

  test("does NOT create a workrun file (dry-run path)", async () => {
    await buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    const dir = dreamRunsDir(vault);
    if (existsSync(dir)) {
      const entries = readdirSync(dir);
      expect(entries).toEqual([]);
    }
  });

  test("invoked twice in a row produces identical output (idempotent)", async () => {
    const a = await buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    const b = await buildReviewCandidates(vault, { now: new Date("2026-05-27T12:00:00Z") });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("a real pass refuses a preview filter by name", () => {
    expect(() => dream(vault, { previewReadable: () => true })).toThrow(DreamPreviewReadableError);
  });
});

const FLAG_ENV = "OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED";
const NOW = new Date("2026-06-10T12:00:00Z");
const MODEL = "rc-model";
const DIMENSION = 4;
const RULE = "always run the formatter before every commit in this repository";
const PARAPHRASE = "always run the formatter before each commit in this repository";
const SEMANTIC = "keep source tidy with the code styler ahead of saving changes";
const UNRELATED = "prefer tabs over spaces inside every makefile you touch";

function seedPreference(slug: string, topic: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic,
    principle,
    created_at: "2026-06-01T00:00:00Z",
    confirmed_at: "2026-06-02T00:00:00Z",
    unconfirmed_until: "2026-06-15T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-06-02T00:00:00Z",
    confidence: "low",
  });
}

function searchConfig(): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath: join(vault, ".open-second-brain", "brain.sqlite"),
    semantic: {
      enabled: true,
      baseUrl: "https://x/v1",
      model: MODEL,
      apiKey: "k",
      dimension: DIMENSION,
    },
  });
}

async function plant(config: ResolvedSearchConfig, bySlug: Record<string, number[]>) {
  const store = await Store.open(config, { mode: "write" });
  try {
    for (const [slug, values] of Object.entries(bySlug)) {
      const docId = store.getDocumentIdByPath(`Brain/preferences/pref-${slug}.md`);
      expect(docId).not.toBeNull();
      const norm = Math.hypot(...values);
      for (const chunk of store.chunksForDocument(docId!)) {
        const vector = values.map((v) => v / norm);
        store.vecUpsert(chunk.id, vector, MODEL, DIMENSION, `eh-${slug}-${chunk.id}`);
      }
    }
  } finally {
    await store.close();
  }
}

describe("buildReviewCandidates retire_siblings", () => {
  let savedFlag: string | undefined;

  beforeEach(() => {
    savedFlag = process.env[FLAG_ENV];
    delete process.env[FLAG_ENV];
    seedPreference("old", "formatting", RULE);
    seedPreference("paraphrase", "commit-hygiene", PARAPHRASE);
    seedPreference("semantic", "tidiness", SEMANTIC);
    seedPreference("unrelated", "makefiles", UNRELATED);
    appendApplyEvidence(
      vault,
      { pref_id: "pref-old", artifact: "[[AA-artifact]]", result: "outdated", agent: "test-agent" },
      { now: new Date("2026-06-09T12:00:00Z") },
    );
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG_ENV];
    else process.env[FLAG_ENV] = savedFlag;
  });

  const LEXICAL: RetireSibling = {
    retiring_id: "pref-old",
    sibling_id: "pref-paraphrase",
    score: 0.818,
    method: "lexical",
  };

  test("with the key on, the lexical siblings are projected", async () => {
    process.env[FLAG_ENV] = "1";
    const r = await buildReviewCandidates(vault, { now: NOW });
    expect(r.retire_siblings).toEqual([LEXICAL]);
    expect("retire_siblings_semantic" in r).toBe(false);
  });

  test.skipIf(!sqliteVecLoadable())(
    "stored-vector matches merge in with method embedding at or above the bar",
    async () => {
      process.env[FLAG_ENV] = "1";
      const config = searchConfig();
      await indexVault(config);
      await plant(config, {
        old: [1, 0, 0, 0],
        paraphrase: [1, 0.05, 0, 0],
        semantic: [1, 0.3, 0, 0],
        unrelated: [1, 1, 0, 0],
      });
      const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: config });
      expect(r.retire_siblings_semantic).toBe("used");
      // `paraphrase` stays lexical; `semantic` (cosine 0.958) joins by
      // embedding; `unrelated` (0.707) is below the 0.92 bar.
      expect(r.retire_siblings).toEqual([
        { retiring_id: "pref-old", sibling_id: "pref-semantic", score: 0.958, method: "embedding" },
        LEXICAL,
      ]);
    },
  );

  test.skipIf(!sqliteVecLoadable())(
    "a retire the confirmed-evidence gate will hold back gets no embedding sibling",
    async () => {
      process.env[FLAG_ENV] = "1";
      const yamlPath = join(vault, "Brain", "_brain.yaml");
      writeFileSync(
        yamlPath,
        readFileSync(yamlPath, "utf8").replace(
          "# confirmed_evidence_min_threshold: 3",
          "confirmed_evidence_min_threshold: 50",
        ),
      );
      const config = searchConfig();
      await indexVault(config);
      await plant(config, { old: [1, 0, 0, 0], semantic: [1, 0.3, 0, 0] });
      const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: config });
      expect(r.would_retire).toEqual([{ id: "ret-old", reason: "superseded-by-context" }]);
      expect("retire_siblings" in r).toBe(false);
      expect("retire_siblings_semantic" in r).toBe(false);
    },
  );

  test("a missing index is reported by name and leaves the lexical list", async () => {
    process.env[FLAG_ENV] = "1";
    const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: searchConfig() });
    expect(r.retire_siblings_semantic).toBe("index_missing");
    expect(r.retire_siblings).toEqual([LEXICAL]);
    expect("retire_siblings_semantic_detail" in r).toBe(false);
  });

  test("an index that will not open degrades to the lexical list and names the failure", async () => {
    process.env[FLAG_ENV] = "1";
    const config = searchConfig();
    mkdirSync(join(config.dbPath, ".."), { recursive: true });
    writeFileSync(config.dbPath, "not a database");
    const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: config });
    expect(r.retire_siblings_semantic).toBe("index_unavailable");
    expect(r.retire_siblings_semantic_detail).toBe("INDEX_UNREADABLE");
    expect(r.retire_siblings).toEqual([LEXICAL]);
    expect(r.would_retire).toEqual([{ id: "ret-old", reason: "superseded-by-context" }]);
  });

  test.skipIf(!sqliteVecLoadable())(
    "an index that has not embedded the preferences reports not_embedded, not used",
    async () => {
      process.env[FLAG_ENV] = "1";
      const config = searchConfig();
      await indexVault(config);
      const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: config });
      expect(r.retire_siblings_semantic).toBe("not_embedded");
      expect(r.retire_siblings).toEqual([LEXICAL]);
    },
  );

  test("an explicit retireSiblingsEnabled decides over the default config", async () => {
    const on = await buildReviewCandidates(vault, { now: NOW, retireSiblingsEnabled: true });
    expect(on.retire_siblings).toEqual([LEXICAL]);
    process.env[FLAG_ENV] = "1";
    const off = await buildReviewCandidates(vault, { now: NOW, retireSiblingsEnabled: false });
    expect("retire_siblings" in off).toBe(false);
  });

  test("with the key off, both fields are absent", async () => {
    const r = await buildReviewCandidates(vault, { now: NOW, searchConfig: searchConfig() });
    expect("retire_siblings" in r).toBe(false);
    expect("retire_siblings_semantic" in r).toBe(false);
    expect(r.would_retire).toEqual([{ id: "ret-old", reason: "superseded-by-context" }]);
  });
});

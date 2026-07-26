/**
 * Pack provenance stamp and validity window (context-integrity-gates,
 * Unit B / Task 9).
 *
 * A context pack carries no record of the vault state it was built from,
 * so a stale pack is indistinguishable from a fresh one. These tests pin
 * the stamp's two tokens, the "no search index" modelling, and the
 * byte-identical contract for a pack that never asked for a stamp.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import {
  CORPUS_GENERATION_UNREADABLE,
  PACK_STAMP_FIELD,
  buildPackStamp,
  packStampRefusal,
  packStampTokens,
} from "../../../src/core/brain/pack-stamp.ts";
import { PACK_VALIDITY_SECONDS_DEFAULT } from "../../../src/core/brain/policy.ts";
import { compareStamps, formatStampMismatch } from "../../../src/core/integrity/stamp.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pack-stamp-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const T0 = new Date("2026-06-10T12:00:00Z");

/** A config path that does not exist, so no operator config leaks in. */
const ABSENT_CONFIG = join(tmpdir(), "o2b-pack-stamp-no-such-config.yaml");

function writePref(slug: string, body: string, mtimeSeconds: number): string {
  const path = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  writeFileSync(
    path,
    [
      "---",
      `id: pref-${slug}`,
      `topic: ${slug}`,
      "principle: p",
      "tier: core",
      "---",
      "",
      body,
    ].join("\n"),
  );
  utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

describe("packStampTokens", () => {
  test("records both tokens, and an absent search index is unrecorded rather than matched", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const tokens = packStampTokens(vault);
    expect(Object.keys(tokens).toSorted()).toEqual(
      [PACK_STAMP_FIELD.brainTree, PACK_STAMP_FIELD.corpusGeneration].toSorted(),
    );
    // No index has ever been built: the corpus token is explicitly
    // `null` ("this side recorded nothing"), never a stand-in value that
    // would compare equal to a real generation.
    expect(tokens[PACK_STAMP_FIELD.corpusGeneration]).toBe(null);
    expect(typeof tokens[PACK_STAMP_FIELD.brainTree]).toBe("string");
    expect((tokens[PACK_STAMP_FIELD.brainTree] as string).length).toBeGreaterThan(0);
  });

  test("the Brain-tree token carries invalidation on a vault with no search index", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const before = packStampTokens(vault);
    writePref("a", "alpha body rewritten with different length", 1_700_000_500);
    const after = packStampTokens(vault);
    const drift = compareStamps(before, after);
    expect(drift.map((m) => m.field)).toEqual([PACK_STAMP_FIELD.brainTree]);
  });

  test("adding a memory changes the Brain-tree token", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const before = packStampTokens(vault);
    writePref("b", "beta body", 1_700_000_000);
    const after = packStampTokens(vault);
    expect(after[PACK_STAMP_FIELD.brainTree]).not.toBe(before[PACK_STAMP_FIELD.brainTree]);
  });

  test("an unchanged vault produces a byte-identical token map", () => {
    writePref("a", "alpha body", 1_700_000_000);
    expect(JSON.stringify(packStampTokens(vault))).toBe(JSON.stringify(packStampTokens(vault)));
  });

  test("a search index appearing is a named corpus_generation drift, not a silent match", async () => {
    writePref("a", "alpha body", 1_700_000_000);
    const before = packStampTokens(vault);
    expect(before[PACK_STAMP_FIELD.corpusGeneration]).toBe(null);

    await indexVault(
      makeConfig({ vault, dbPath: join(vault, ".open-second-brain", "brain.sqlite") }),
      {},
    );

    const after = packStampTokens(vault);
    expect(typeof after[PACK_STAMP_FIELD.corpusGeneration]).toBe("string");
    const drift = compareStamps(before, after);
    const fields = drift.map((m) => m.field);
    expect(fields).toContain(PACK_STAMP_FIELD.corpusGeneration);
    const rendered = drift.map(formatStampMismatch).join("; ");
    expect(rendered).toContain(PACK_STAMP_FIELD.corpusGeneration);
    expect(rendered).toContain("<unrecorded>");
  });
});

describe("buildPackStamp", () => {
  test("derives the validity window from integrity.pack_validity_seconds", () => {
    const stamp = buildPackStamp(vault, T0);
    expect(stamp.generatedAt).toBe(T0.toISOString());
    expect(stamp.expiresAt).toBe(
      new Date(T0.getTime() + PACK_VALIDITY_SECONDS_DEFAULT * 1_000).toISOString(),
    );
  });

  test("honours a configured pack_validity_seconds", () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      ["schema_version: 1", "integrity:", "  pack_validity_seconds: 60", ""].join("\n"),
    );
    const stamp = buildPackStamp(vault, T0);
    expect(stamp.expiresAt).toBe(new Date(T0.getTime() + 60_000).toISOString());
  });
});

describe("packStampRefusal", () => {
  test("returns null for an unexpired stamp whose tokens still match", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const stamp = buildPackStamp(vault, T0);
    const reason = packStampRefusal(stamp, packStampTokens(vault), new Date(T0.getTime() + 1_000));
    expect(reason).toBe(null);
  });

  test("names the drifted field when the Brain tree changed", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const stamp = buildPackStamp(vault, T0);
    writePref("a", "alpha body rewritten with different length", 1_700_000_500);
    const reason = packStampRefusal(stamp, packStampTokens(vault), new Date(T0.getTime() + 1_000));
    expect(reason).not.toBe(null);
    expect(reason!).toContain(PACK_STAMP_FIELD.brainTree);
  });

  test("refuses an expired window even when every token still matches", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const stamp = buildPackStamp(vault, T0);
    const expired = new Date(T0.getTime() + (PACK_VALIDITY_SECONDS_DEFAULT + 1) * 1_000);
    const reason = packStampRefusal(stamp, packStampTokens(vault), expired);
    expect(reason).not.toBe(null);
    expect(reason!).toContain(stamp.expiresAt);
  });

  test("a stamp whose recorded tokens are unreadable is refused, never accepted", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const stamp = buildPackStamp(vault, T0);
    const reason = packStampRefusal(
      { ...stamp, tokens: {} },
      packStampTokens(vault),
      new Date(T0.getTime() + 1_000),
    );
    expect(reason).not.toBe(null);
  });
});

describe("packContext stamp option", () => {
  test("a pack that did not ask for a stamp carries no stamp key", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const report = packContext(vault, { maxTokens: 1_000 });
    expect("stamp" in report).toBe(false);
  });

  test("the stamp rides the pack when requested", () => {
    writePref("a", "alpha body", 1_700_000_000);
    const report = packContext(vault, { maxTokens: 1_000, stamp: { now: T0 } });
    expect(report.stamp).toBeDefined();
    expect(report.stamp!.generatedAt).toBe(T0.toISOString());
    expect(report.stamp!.tokens[PACK_STAMP_FIELD.brainTree]).toBe(
      packStampTokens(vault)[PACK_STAMP_FIELD.brainTree],
    );
  });

  test("a stamped empty-budget pack still carries its stamp", () => {
    const report = packContext(vault, { maxTokens: 0, stamp: { now: T0 } });
    expect(report.stamp).toBeDefined();
  });
});

/**
 * `packIndexPath` consulted only `OPEN_SECOND_BRAIN_SEARCH_DB`, while
 * `resolveSearchConfig` also honours the config-file `search_db_path`.
 * On a vault configured that way the stamp read a database that was not
 * there, `corpus_generation` was `null` on both sides, "two unrecorded
 * sides are not a finding" applied, and half the pack stamp was
 * permanently inert - while its own docblock claimed it observed the
 * database `search()` would read.
 */
describe("packStampTokens observes the index search() would read", () => {
  test("a config-file search_db_path is honoured, not just the env var", async () => {
    const home = mkdtempSync(join(tmpdir(), "o2b-pack-stamp-cfg-"));
    const dbPath = join(home, "elsewhere.sqlite");
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, `vault: "${vault}"\nsearch_db_path: "${dbPath}"\n`, "utf8");
    writeFileSync(join(vault, "note.md"), "# Note\n\nbody\n", "utf8");
    try {
      await indexVault(makeConfig({ vault, dbPath }), {});
      const generation = packStampTokens(vault, { configPath })[PACK_STAMP_FIELD.corpusGeneration];
      expect(generation).not.toBeNull();
      // The default location holds no database, so the env-only
      // resolution this replaces still reads as unrecorded.
      expect(packStampTokens(vault, { configPath: join(home, "absent.yaml") })).toHaveProperty(
        PACK_STAMP_FIELD.corpusGeneration,
        null,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt index is recorded as unreadable, not as unrecorded", async () => {
    const home = mkdtempSync(join(tmpdir(), "o2b-pack-stamp-corrupt-"));
    const dbPath = join(home, "corrupt.sqlite");
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, `vault: "${vault}"\nsearch_db_path: "${dbPath}"\n`, "utf8");
    writeFileSync(dbPath, "this is not a sqlite database", "utf8");
    try {
      const generation = packStampTokens(vault, { configPath })[PACK_STAMP_FIELD.corpusGeneration];
      // Not null: an index that exists and cannot be read is a state, and
      // collapsing it onto "no index" makes both sides agree by accident.
      expect(generation).not.toBeNull();
      expect(generation).toBe(CORPUS_GENERATION_UNREADABLE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * `brain_tree` digested only the preference and retired directories,
 * while `packContext` also reads `Brain/_brain.yaml` - whose
 * `untrusted_source_delimiting` flag changes the emitted bodies. A pack
 * built before the flag flipped therefore compared EQUAL to the vault
 * state after it, which is exactly the staleness the stamp exists to
 * name. The digest was extended rather than the docblock narrowed: the
 * config is one stat, and it changes what the pack returns.
 */
describe("brain_tree covers every input packContext reads", () => {
  test("flipping a config flag moves the digest", () => {
    const configFile = join(vault, "Brain", "_brain.yaml");
    writeFileSync(configFile, "schema_version: 1\n", "utf8");
    const before = packStampTokens(vault, { configPath: ABSENT_CONFIG })[
      PACK_STAMP_FIELD.brainTree
    ];
    writeFileSync(
      configFile,
      "schema_version: 1\nguardrails:\n  untrusted_source_delimiting: true\n",
      "utf8",
    );
    const after = packStampTokens(vault, { configPath: ABSENT_CONFIG })[PACK_STAMP_FIELD.brainTree];
    expect(after).not.toBe(before);
  });

  test("creating the config where there was none moves the digest", () => {
    const before = packStampTokens(vault, { configPath: ABSENT_CONFIG })[
      PACK_STAMP_FIELD.brainTree
    ];
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n", "utf8");
    const after = packStampTokens(vault, { configPath: ABSENT_CONFIG })[PACK_STAMP_FIELD.brainTree];
    expect(after).not.toBe(before);
  });
});

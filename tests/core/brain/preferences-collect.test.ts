import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectPreferencePages,
  collectPreferences,
  listPreferenceFiles,
  PREFERENCE_FILE_EXT,
  PREFERENCE_ID_PREFIX,
} from "../../../src/core/brain/preferences-collect.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";
import { GATE_MODE } from "../../../src/core/integrity/stamp.ts";
import type { OwnerScopeDelivery } from "../../../src/core/brain/preferences-collect.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pref-collect-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function makePref(slug: string, extra: Record<string, unknown> = {}): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    ...extra,
  });
}

test("constants name the on-disk grammar the delivery path shares", () => {
  expect(PREFERENCE_FILE_EXT).toBe(".md");
  expect(PREFERENCE_ID_PREFIX).toBe("pref-");
});

test("an absent directory collects nothing rather than throwing", () => {
  const missing = join(vault, "Brain", "does-not-exist");
  expect(listPreferenceFiles(missing)).toEqual([]);
  expect(collectPreferences(missing).entries).toEqual([]);
  expect(collectPreferencePages(missing).entries).toEqual([]);
});

test("listing keeps readdirSync order and drops non-markdown names", () => {
  const dir = brainDirs(vault).preferences;
  makePref("alpha");
  makePref("beta");
  writeFileSync(join(dir, "notes.txt"), "ignored\n");
  writeFileSync(join(dir, ".keep"), "");

  const expected = readdirSync(dir).filter((n) => n.endsWith(".md"));
  expect(listPreferenceFiles(dir).map((f) => f.name)).toEqual(expected);
  for (const file of listPreferenceFiles(dir)) {
    expect(file.path).toBe(join(dir, file.name));
  }
});

test("namePrefix restricts the listing the way the digest scan does", () => {
  const dir = brainDirs(vault).preferences;
  makePref("alpha");
  writeFileSync(join(dir, "stray-note.md"), "---\nkind: brain-preference\n---\n");

  expect(listPreferenceFiles(dir).map((f) => f.name)).toContain("stray-note.md");
  expect(listPreferenceFiles(dir, { namePrefix: PREFERENCE_ID_PREFIX }).map((f) => f.name)).toEqual(
    ["pref-alpha.md"],
  );
});

test("regularFilesOnly excludes a directory whose name ends in .md", () => {
  const dir = brainDirs(vault).preferences;
  makePref("alpha");
  mkdirSync(join(dir, "pref-decoy.md"));

  expect(listPreferenceFiles(dir).map((f) => f.name)).toContain("pref-decoy.md");
  expect(listPreferenceFiles(dir, { regularFilesOnly: true }).map((f) => f.name)).toEqual([
    "pref-alpha.md",
  ]);
});

test("collectPreferences parses each file and skips an unparseable one", () => {
  const dir = brainDirs(vault).preferences;
  makePref("alpha");
  writeFileSync(join(dir, "pref-broken.md"), "not frontmatter at all\n");

  const collected = collectPreferences(dir).entries;
  expect(collected.map((c) => c.pref.id)).toEqual(["pref-alpha"]);
  expect(collected[0]!.name).toBe("pref-alpha.md");
  expect(collected[0]!.path).toBe(join(dir, "pref-alpha.md"));
  expect(collected[0]!.pref.principle).toBe("principle for alpha");
});

test("collectPreferencePages returns raw frontmatter and body without throwing", () => {
  const dir = brainDirs(vault).preferences;
  makePref("alpha");
  writeFileSync(join(dir, "pref-freeform.md"), "---\ntopic: freeform\n---\nbody text\n");

  const pages = collectPreferencePages(dir).entries;
  const byName = new Map(pages.map((p) => [p.name, p]));
  expect(byName.get("pref-freeform.md")!.meta["topic"]).toBe("freeform");
  expect(byName.get("pref-freeform.md")!.body.trim()).toBe("body text");
  expect(byName.get("pref-alpha.md")!.meta["kind"]).toBe("brain-preference");
});

// ----- A2: a present-but-unresolvable `owner:` is never ownerless ----------

/** The gate verdict an operator who set `fail` produces for `scope`. */
function enforcing(scope: string): OwnerScopeDelivery {
  return Object.freeze({
    mode: GATE_MODE.fail,
    enforcedScope: scope,
    requestedScope: scope,
  });
}

/**
 * Rewrite the preference's scalar `owner:` into a block-style YAML
 * sequence — the shape Obsidian Properties writes for any list-valued
 * field, and the shape `parseFrontmatterText` has parsed into an array
 * since commit 426d06f8.
 */
function makeListOwnedPref(slug: string, owners: ReadonlyArray<string>): void {
  makePref(slug, { owner: owners[0] });
  const path = join(brainDirs(vault).preferences, `pref-${slug}.md`);
  const text = readFileSync(path, "utf8");
  const block = ["owner:", ...owners.map((o) => `  - ${o}`)].join("\n");
  writeFileSync(path, text.replace(`owner: ${owners[0]}`, block));
}

test("a list-valued owner is withheld from every scope, not shared with all", () => {
  const dir = brainDirs(vault).preferences;
  makePref("shared");
  makeListOwnedPref("listed", ["agent-a", "agent-b"]);

  for (const scope of ["agent-a", "agent-b"]) {
    const collected = collectPreferences(dir, { ownerScope: enforcing(scope) });
    expect(collected.entries.map((c) => c.pref.id)).toEqual(["pref-shared"]);
    expect(collected.hiddenByOwnerScope).toBe(1);

    const pages = collectPreferencePages(dir, { ownerScope: enforcing(scope) });
    expect(pages.entries.map((p) => p.name)).toEqual(["pref-shared.md"]);
    expect(pages.hiddenByOwnerScope).toBe(1);
  }
});

test("with the gate off, a list-valued owner changes nothing", () => {
  const dir = brainDirs(vault).preferences;
  makePref("shared");
  makeListOwnedPref("listed", ["agent-a"]);

  const collected = collectPreferences(dir);
  expect(collected.entries.map((c) => c.pref.id).toSorted()).toEqual([
    "pref-listed",
    "pref-shared",
  ]);
  expect(collected.hiddenByOwnerScope).toBe(0);
});

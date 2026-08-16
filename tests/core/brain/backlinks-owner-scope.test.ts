/**
 * `buildBacklinkIndex`'s two U3 obligations (a-label-is-not-a-boundary).
 *
 * 1. An optional owner scope, second parameter, that drops refs whose
 *    SOURCE artifact the scope may not see. Nine existing call sites pass
 *    nothing and keep the index they always got.
 * 2. An artifact the collector cannot parse is REPORTED. The `catch {
 *    continue; }` this replaced returned a confident `count: 0` on a
 *    vault whose preferences use the un-prefixed Group C frontmatter
 *    shape, and the caller had no way to tell that from a genuine zero.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBacklinkIndex } from "../../../src/core/brain/backlinks.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

/** Pinned per file; nothing in this repository pins it globally. */
process.env["HOME"] = mkdtempSync(join(tmpdir(), "o2b-backlinks-scope-home-"));

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";
const TARGET = "pref-shared";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-backlinks-scope-vault-"));
  for (const sub of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

/**
 * A preference in the CURRENT frontmatter shape (`_`-prefixed Group C
 * keys), optionally owner-tagged.
 */
function writePref(slug: string, owner: string | null, body: string): void {
  writeFileSync(
    join(brainDirs(vault).preferences, `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      ...(owner === null ? [] : [`owner: ${owner}`]),
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-08T00:00:00Z",
      "tags: []",
      `topic: ${slug}`,
      `principle: principle for ${slug}`,
      "_status: confirmed",
      "_confirmed_at: 2026-05-02T00:00:00Z",
      "_evidenced_by: []",
      "_applied_count: 0",
      "_violated_count: 0",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

/**
 * The Group C shape a legacy vault carries: `status:` un-prefixed.
 * `normalizeDerivedKeys` throws on it, which is what the collector used
 * to swallow.
 */
function writeLegacyPref(slug: string, body: string): void {
  writeFileSync(
    join(brainDirs(vault).preferences, `pref-${slug}.md`),
    [
      "---",
      "kind: brain-preference",
      `id: pref-${slug}`,
      "created_at: 2026-05-01T00:00:00Z",
      "unconfirmed_until: 2026-05-08T00:00:00Z",
      "tags: []",
      `topic: ${slug}`,
      `principle: principle for ${slug}`,
      "status: confirmed",
      "_status: confirmed",
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

test("an owner scope drops refs written by another owner's artifact", () => {
  writePref("shared", null, "the target");
  writePref("owned-by-a", OWNER_A, `points at [[${TARGET}]]`);
  writePref("also-shared", null, `points at [[${TARGET}]]`);

  const unscoped = buildBacklinkIndex(vault);
  expect((unscoped.get(TARGET) ?? []).map((r) => r.source).toSorted()).toEqual([
    "pref-also-shared",
    "pref-owned-by-a",
  ]);

  const scoped = buildBacklinkIndex(vault, OWNER_B);
  expect((scoped.get(TARGET) ?? []).map((r) => r.source)).toEqual(["pref-also-shared"]);

  // The owner still sees its own, and an absent scope still sees both -
  // the nine existing call sites pass nothing and are unaffected.
  const asOwner = buildBacklinkIndex(vault, OWNER_A);
  expect((asOwner.get(TARGET) ?? []).map((r) => r.source).toSorted()).toEqual([
    "pref-also-shared",
    "pref-owned-by-a",
  ]);
});

test("a legacy-frontmatter preference is reported, not silently dropped", () => {
  writePref("shared", null, "the target");
  writeLegacyPref("legacy", `points at [[${TARGET}]]`);

  const index = buildBacklinkIndex(vault);
  // The ref is still absent - the fields could not be read - but the
  // caller is now told which artifact was skipped and why, so a `count`
  // of 0 beside a non-empty report is distinguishable from a real zero.
  expect(index.get(TARGET)).toBeUndefined();
  expect(index.unparsed.map((u) => u.source)).toEqual(["pref-legacy"]);
  expect(index.unparsed[0]!.sourceKind).toBe("preference");
  expect(index.unparsed[0]!.reason).toContain("'_status'");
  // The reason crosses the MCP boundary: no absolute host path in it.
  expect(index.unparsed[0]!.reason).not.toContain(vault);
});

test("a clean vault reports no failures at all", () => {
  writePref("shared", null, "the target");
  writePref("other", null, `points at [[${TARGET}]]`);
  expect(buildBacklinkIndex(vault).unparsed).toEqual([]);
});

test("another owner's unparseable artifact is withheld from the failure report", () => {
  // Reporting it would name the artifact the ref filter just withheld,
  // which is the leak with the evidence moved one field over. The
  // artifact's owner is still readable from its frontmatter - it is the
  // DERIVED keys that fail - so the ownership rule still has a subject.
  writePref("shared", null, "the target");
  const legacy = join(brainDirs(vault).preferences, "pref-legacy.md");
  writeLegacyPref("legacy", `points at [[${TARGET}]]`);
  writeFileSync(
    legacy,
    readFileSync(legacy, "utf8").replace(
      "kind: brain-preference",
      `kind: brain-preference\nowner: ${OWNER_A}`,
    ),
  );

  expect(buildBacklinkIndex(vault).unparsed.map((u) => u.source)).toEqual(["pref-legacy"]);
  expect(buildBacklinkIndex(vault, OWNER_B).unparsed).toEqual([]);
  expect(buildBacklinkIndex(vault, OWNER_A).unparsed.map((u) => u.source)).toEqual(["pref-legacy"]);
});

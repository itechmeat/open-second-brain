/**
 * Per-scope page dedup (t_37c05a34): identical rule text under different
 * composite scopes must NOT be collapsed, while identical text in one scope
 * (or scopeless, the pre-scope world) still collapses. Additive keying: a
 * scopeless page keys byte-identically to before, so existing global dedup
 * state is untouched and a rerun over old rows does not re-collapse.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findDuplicateCandidates, mergePage } from "../../../src/core/brain/page-dedup.ts";
import { createTempVault } from "../../helpers/search-fixtures.ts";

let vault: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("page-dedup-scope");
  vault = v.vault;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function writePref(slug: string, extra: Record<string, string>): void {
  const dir = join(vault, "Brain", "preferences");
  mkdirSync(dir, { recursive: true });
  const fm = ["---", `id: pref-${slug}`, "topic: em-dashes", "principle: never use em dashes"];
  for (const [k, val] of Object.entries(extra)) fm.push(`${k}: ${val}`);
  fm.push("created_at: 2026-01-01T00:00:00Z", "---", "", "never use em dashes", "");
  writeFileSync(join(dir, `pref-${slug}.md`), fm.join("\n"));
}

test("identical text under different owners is not collapsed", () => {
  writePref("a", { owner: "alice" });
  writePref("b", { owner: "bob" });
  expect(findDuplicateCandidates(vault).candidates).toHaveLength(0);
});

test("identical text under different sessions is not collapsed", () => {
  writePref("a", { session: "s1" });
  writePref("b", { session: "s2" });
  expect(findDuplicateCandidates(vault).candidates).toHaveLength(0);
});

test("identical text within one scope still collapses", () => {
  writePref("a", { owner: "alice" });
  writePref("b", { owner: "alice" });
  const report = findDuplicateCandidates(vault);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]!.secondaries).toHaveLength(1);
});

test("additive keying: scopeless identical pages still collapse (byte-identical)", () => {
  writePref("a", {});
  writePref("b", {});
  const report = findDuplicateCandidates(vault);
  expect(report.candidates).toHaveLength(1);
});

test("N2 idempotency: a second dedup pass over pre-existing scopeless rows re-collapses nothing new", () => {
  writePref("a", {});
  writePref("b", {});

  // Pass 1: scan and apply, exactly as `o2b brain page-dedup --apply` would.
  const first = findDuplicateCandidates(vault);
  expect(first.candidates).toHaveLength(1);
  expect(first.candidates[0]!.secondaries).toHaveLength(1);
  for (const c of first.candidates) {
    for (const s of c.secondaries) mergePage(vault, s.id, c.canonical.id);
  }

  // Pass 2: rerun over the same rows. The scopeless scope key is unaffected
  // by `merged_into`, so the same pair is found again - not a NEW cluster
  // and not additional secondaries beyond the one already merged.
  const second = findDuplicateCandidates(vault);
  expect(second.candidates).toHaveLength(1);
  expect(second.candidates[0]!.secondaries.map((s) => s.id)).toEqual(
    first.candidates[0]!.secondaries.map((s) => s.id),
  );

  // Re-applying is a pure no-op: no additional wikilink rewrites happen.
  const secondary = second.candidates[0]!.secondaries[0]!;
  const canonical = second.candidates[0]!.canonical;
  const rerun = mergePage(vault, secondary.id, canonical.id);
  expect(rerun.wikilinksUpdated).toBe(0);
});

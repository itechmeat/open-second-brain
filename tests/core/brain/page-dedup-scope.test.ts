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

import { findDuplicateCandidates } from "../../../src/core/brain/page-dedup.ts";
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

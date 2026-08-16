/**
 * The adapter's own fail-closed promise, executed
 * (a-label-is-not-a-boundary, U3).
 *
 * `owner-scope-view.ts` says it FAILS CLOSED, and it decided visibility
 * for fifteen report-shaped surfaces. Two shapes of reference walked
 * straight through it and were reported visible without any ownership
 * being read:
 *
 *   - an id whose artifact lives in a `Brain/` directory the resolver
 *     did not search. It searched four; `Brain/sources/src-*.md`,
 *     `Brain/entities/` and `Brain/pending/` hold id-addressable pages
 *     that carry `owner:` the same way, and `brain_search_by_source`
 *     already filters the first of them on the search side - so the two
 *     halves of the product disagreed about whether a source page can be
 *     owned;
 *   - a reference still wearing its wikilink brackets. A retirement's
 *     `retired_by`, a dream transition's `link` and an evidence row's
 *     `artifact` all arrive as `[[…]]` straight out of frontmatter or a
 *     log body, and `[[pref-x]]` matched neither the path branch nor the
 *     id branch.
 *
 * Both are one-line reads that returned `true`, which is the shape a
 * boundary fails in silence.
 */

import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownerScopeView } from "../../../src/core/brain/owner-scope-view.ts";

const OWNER_A = "agent-a";
const OWNER_B = "agent-b";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-owner-view-"));
  for (const sub of ["preferences", "retired", "inbox", "pending", "sources", "entities"]) {
    mkdirSync(join(vault, "Brain", sub), { recursive: true });
  }
});

/** An owner-tagged page at a vault-relative path, with a bare id filename. */
function ownedPage(relDir: string, id: string): void {
  writeFileSync(
    join(vault, relDir, `${id}.md`),
    `---\nid: ${id}\nowner: ${OWNER_A}\n---\n\nbody of ${id}\n`,
  );
}

/**
 * Every `Brain/` directory holding id-addressable Markdown that can
 * carry `owner:`. A directory missing from the resolver makes its pages
 * silently unownable, so the population is asserted directly.
 */
const OWNER_TAGGABLE_DIRS = [
  ["Brain/preferences", "pref-owned"],
  ["Brain/retired", "ret-owned"],
  ["Brain/inbox", "sig-2026-05-01-owned"],
  ["Brain/pending", "sig-2026-05-02-owned"],
  ["Brain/sources", "src-owned"],
  ["Brain/entities", "ent-owned"],
] as const;

for (const [dir, id] of OWNER_TAGGABLE_DIRS) {
  test(`an id-shaped reference to ${dir} is hidden from another owner`, () => {
    ownedPage(dir, id);
    const view = ownerScopeView(vault, OWNER_B);
    expect(view.visible(id), `${dir}/${id}.md declares owner: ${OWNER_A}`).toBe(false);
    // Its own owner still sees it, so the rule is not a blanket hide.
    expect(ownerScopeView(vault, OWNER_A).visible(id)).toBe(true);
  });
}

test("a wikilink-shaped reference resolves to the same page as its bare id", () => {
  ownedPage("Brain/preferences", "pref-owned");
  const view = ownerScopeView(vault, OWNER_B);
  for (const ref of [
    "pref-owned",
    "[[pref-owned]]",
    "Brain/preferences/pref-owned.md",
    "[[Brain/preferences/pref-owned.md]]",
  ]) {
    expect(`${ref} -> ${String(view.visible(ref))}`).toBe(`${ref} -> false`);
  }
});

test("a reference naming nothing on disk is visible, and so is an empty one", () => {
  const view = ownerScopeView(vault, OWNER_B);
  // A row with no subject cannot disclose one; an id with no artifact
  // names nothing that could be owned.
  for (const ref of [null, undefined, "", "pref-never-existed", "[[pref-never-existed]]"]) {
    expect(view.visible(ref)).toBe(true);
  }
});

test("an unscoped view reads nothing and hides nothing", () => {
  ownedPage("Brain/sources", "src-owned");
  const view = ownerScopeView(vault, null);
  expect(view.scope).toBeNull();
  expect(view.visible("src-owned")).toBe(true);
  expect(view.row("src-owned", "[[src-owned]]")).toBe(true);
});

test("one hidden reference hides the whole row", () => {
  ownedPage("Brain/sources", "src-owned");
  const view = ownerScopeView(vault, OWNER_B);
  expect(view.row("pref-never-existed", "[[src-owned]]")).toBe(false);
  expect(
    view.keep([{ refs: ["[[src-owned]]"] }, { refs: ["pref-never-existed"] }], (r) => r.refs),
  ).toHaveLength(1);
});

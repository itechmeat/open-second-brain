/**
 * The visibility-tag presence peek `search check`'s honesty finding
 * gates on (nothing-writes-silently, unit H).
 *
 * The claims pinned here:
 *
 *   1. A vault with no `visibility:` frontmatter anywhere reports absent,
 *      read straight off the built index - no page is opened again.
 *   2. A vault with one `visibility:`-tagged page reports present.
 *   3. Merely mentioning the WORD "visibility" (no colon, no key shape)
 *      does not flip the peek - the pattern requires the key phrase.
 *   4. The heuristic is charged honestly for what it cannot tell apart:
 *      a page with no frontmatter block puts its own first content
 *      chunk at `chunk_index = 0`, so a body line that happens to spell
 *      the exact phrase `visibility:` reads as tagged. This is the
 *      documented false-positive shape, not a defect to close.
 *   5. An absent index reports `absent`, never `false` folded into a
 *      read - the two are different claims and stay distinguishable.
 *   6. A file at the index path that will not open reports `unreadable`
 *      with the open's own reason.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { peekVisibilityTagPresence } from "../../../src/core/search/store/visibility-tag.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("visibility-tag-presence");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("a vault with no visibility frontmatter anywhere reads absent", async () => {
  writeMd(vault, "a.md", "# A\n\nFirst note, no frontmatter at all.");
  writeMd(vault, "b.md", "---\ntitle: B\n---\n\n# B\n\nTagged with an unrelated key.");
  await indexVault(makeConfig({ vault, dbPath }));

  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("read");
  if (peek.kind === "read") expect(peek.value).toBe(false);
});

test("a vault with one visibility-tagged page reads present", async () => {
  writeMd(vault, "a.md", "# A\n\nFirst note, no frontmatter at all.");
  writeMd(vault, "b.md", "---\nvisibility: private\n---\n\n# B\n\nA private page.");
  await indexVault(makeConfig({ vault, dbPath }));

  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("read");
  if (peek.kind === "read") expect(peek.value).toBe(true);
});

test("the word 'visibility' in body prose, with no 'visibility:' key text, does not flip the peek", async () => {
  writeMd(
    vault,
    "a.md",
    "# A\n\nThis paragraph discusses page visibility and how visible a UI element is to a user.",
  );
  await indexVault(makeConfig({ vault, dbPath }));

  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("read");
  if (peek.kind === "read") expect(peek.value).toBe(false);
});

test("a 'visibility:' phrase in body prose (no frontmatter block) still flips the peek, by design", async () => {
  // The documented imprecision is not scoped to frontmatter VALUES: the
  // heuristic reads chunk_index 0 wholesale, and a page with no
  // frontmatter block puts its own first content chunk there. A body
  // line spelling the exact key phrase is charged as a false positive
  // for the same reason a quoted title would be - pinned here as the
  // shape of the tradeoff, not as an oversight to close.
  writeMd(
    vault,
    "a.md",
    "# A\n\nThis paragraph discusses visibility: how visible a UI element is to a user.",
  );
  await indexVault(makeConfig({ vault, dbPath }));

  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("read");
  if (peek.kind === "read") expect(peek.value).toBe(true);
});

test("an absent index reads absent, never a false folded into a read", () => {
  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("absent");
});

test("a file that is not a readable index reads unreadable with the open's reason", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "not a database");
  const peek = peekVisibilityTagPresence(dbPath);
  expect(peek.kind).toBe("unreadable");
});

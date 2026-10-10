import { test, expect } from "bun:test";
import { join } from "node:path";

import { admitToIndex } from "../../../src/core/vault-scope/index-admission.ts";
import { walkVault } from "../../../src/core/search/walker.ts";
import { createTempVault, writeMd, makeConfig } from "../../helpers/search-fixtures.ts";

test("defaults to admit for ordinary vault content", () => {
  expect(admitToIndex("notes/a.md").admit).toBe(true);
  expect(admitToIndex("Concept.md").admit).toBe(true);
});

test("admits existing Brain content (regression: only the lane is excluded)", () => {
  expect(admitToIndex("Brain/preferences/pref-x.md").admit).toBe(true);
  expect(admitToIndex("Brain/sources/src-y.md").admit).toBe(true);
  expect(admitToIndex("Brain/pinned.md").admit).toBe(true);
});

test("excludes the exact-state lane directory and its files", () => {
  expect(admitToIndex("Brain/state").admit).toBe(false);
  expect(admitToIndex("Brain/state/deploy-target.md").admit).toBe(false);
});

test("does not exclude siblings that merely share the lane name prefix", () => {
  expect(admitToIndex("Brain/stateful/x.md").admit).toBe(true);
  expect(admitToIndex("Brain/state-notes.md").admit).toBe(true);
});

test("excludes the write-approval review lane (reason review-pending)", () => {
  expect(admitToIndex("Brain/pending").admit).toBe(false);
  expect(admitToIndex("Brain/pending").reason).toBe("review-pending");
  expect(admitToIndex("Brain/pending/sig-2026-10-10-x.md").admit).toBe(false);
  expect(admitToIndex("Brain/pending/notes/note-2026-10-10-a.md").admit).toBe(false);
  expect(admitToIndex("Brain/pending/ingest/ing-2026-10-10-a.md").admit).toBe(false);
});

test("admits the review lane's name-prefix neighbours (pathCovers boundary)", () => {
  expect(admitToIndex("Brain/pendingfoo/x.md").admit).toBe(true);
  expect(admitToIndex("Brain/pending-notes.md").admit).toBe(true);
});

test("walker does not index Brain/pending but does index Brain/pendingfoo", () => {
  const v = createTempVault("pending-admission");
  try {
    writeMd(v.vault, "Brain/pending/sig-2026-10-10-staged.md", "staged signal");
    writeMd(v.vault, "Brain/pending/notes/note-2026-10-10-x.md", "staged note");
    writeMd(v.vault, "Brain/pendingfoo/x.md", "ordinary note");
    writeMd(v.vault, "Brain/active.md", "digest");
    const cfg = makeConfig({ vault: v.vault, dbPath: join(v.vault, "x.sqlite") });
    const yielded: string[] = [];
    for (const f of walkVault(cfg)) yielded.push(f.relPath);
    expect(yielded.toSorted()).toEqual(["Brain/active.md", "Brain/pendingfoo/x.md"]);
  } finally {
    v.cleanup();
  }
});

import { test, expect } from "bun:test";

import { admitToIndex } from "../../../src/core/vault-scope/index-admission.ts";

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

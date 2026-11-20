/**
 * The quote check on a switched machine whose legacy `Brain/` tree is
 * still on disk: the store holds the operator's standing rules and every
 * other `Brain/` page there, so a legacy file edited after the switch is
 * a stale copy. Before the fix a quote of it was checked against that
 * stale file; it now reads `unavailable` (reported `note-unavailable`,
 * never an all-clear), while a user note outside `Brain/` still reads.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evidenceFor } from "../../hooks/answer-quote-check.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

test("a legacy Brain/ file on a switched machine is not quote evidence", () => {
  env = makeStoreEnv("osb-quote-stale-");
  switchDevice(env.storeRoot);
  writeFileSync(join(env.vault, "Brain", "standing-rules.md"), "Stale text after the switch.\n");
  mkdirSync(join(env.vault, "notes"), { recursive: true });
  writeFileSync(join(env.vault, "notes", "otters.md"), "Feed the otters.\n");

  expect(evidenceFor(env.vault, { at: 0, path: "Brain/standing-rules.md" })).toEqual({
    kind: "unavailable",
  });
  // A name that starts with `..` is a page inside `Brain/`, not a parent step.
  writeFileSync(join(env.vault, "Brain", "..rules.md"), "Stale dotted page.\n");
  expect(evidenceFor(env.vault, { at: 0, path: "Brain/..rules.md" })).toEqual({
    kind: "unavailable",
  });
  expect(evidenceFor(env.vault, { at: 0, path: "notes/otters.md" })).toEqual({
    kind: "text",
    text: "Feed the otters.\n",
    truncated: false,
  });
});

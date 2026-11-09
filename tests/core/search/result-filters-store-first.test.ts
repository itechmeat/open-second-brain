/**
 * On a switched machine the reach filter reads a memory page from the
 * store, even while a stale legacy file of it is still in the vault: a
 * rule the store holds as private reads as reserved, whatever the old
 * file says.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import {
  isPathReadableAtReach,
  storedMemoryPageText,
} from "../../../src/core/search/result-filters.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { switchDevice } from "../brain/fixtures/memory-twins.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

/**
 * A confirmed rule `slug` in the store's `partition`, plus a stale public
 * legacy file of it in the vault. Returns the page's vault-relative path.
 */
function ruleWithStaleFile(e: StoreEnv, partition: "shared" | "private", slug: string): string {
  appendRecord(openStore({ root: e.storeRoot, device: "dev-a" }), {
    partition,
    stream: "events",
    kind: "preference-set",
    agent: "t",
    body: {
      authority: "agent",
      preference: `pref-${slug}`,
      fields: { principle: `The ${slug} rule.`, status: "confirmed", topic: slug },
    },
  });
  const rel = `Brain/preferences/pref-${slug}.md`;
  mkdirSync(join(e.vault, "Brain", "preferences"), { recursive: true });
  writeFileSync(
    join(e.vault, rel),
    `---\nid: pref-${slug}\nstatus: confirmed\n---\nThe ${slug} rule.\n`,
  );
  return rel;
}

test("a private store rule is withheld at remote reach although its old file is public", () => {
  env = makeStoreEnv("osb-filters-store-first-", { dualWrite: false });
  switchDevice(env);
  const hidden = ruleWithStaleFile(env, "private", "hidden");
  const open = ruleWithStaleFile(env, "shared", "open");
  expect(isPathReadableAtReach(env.vault, hidden, TRANSPORT_REACH.remote, new Map())).toBe(false);
  // The control: the same setup with the record in `shared` is readable,
  // so the private rule is withheld for its partition, not because the
  // lookup missed and the filter failed closed.
  expect(isPathReadableAtReach(env.vault, open, TRANSPORT_REACH.remote, new Map())).toBe(true);
});

test("the text of a stored memory page is read from the store, with no file behind it", () => {
  env = makeStoreEnv("osb-filters-store-text-", { dualWrite: false });
  switchDevice(env);
  appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
    partition: "shared",
    stream: "events",
    kind: "preference-set",
    agent: "t",
    body: {
      authority: "agent",
      preference: "pref-open",
      fields: { principle: "An open rule.", status: "confirmed", topic: "open" },
    },
  });
  const text = storedMemoryPageText(new Map(), env.vault, "Brain/preferences/pref-open.md");
  expect(text).toContain("An open rule.");
  expect(storedMemoryPageText(new Map(), env.vault, "Notes/other.md")).toBeNull();
});

/**
 * `storeStatusLine`, the store line of `o2b status`: an unusable store
 * names its reason, a block with no reason is never "unusable: undefined".
 */
import { expect, test } from "bun:test";

import { storeStatusLine } from "../../src/cli/store-path.ts";

test("names the state of the store at its root", () => {
  const root = { path: "/s" };
  expect(storeStatusLine({ root, error: "broken", initialized: false })).toBe(
    "store_root: /s (unusable: broken)",
  );
  expect(storeStatusLine({ root, error: null, initialized: true, store_id: "st-1" })).toBe(
    "store_root: /s (store st-1)",
  );
  expect(storeStatusLine({ root, initialized: false })).toBe("store_root: /s (not created)");
});

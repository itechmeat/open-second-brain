/**
 * The schema pack's store fields round-trip the rendered entries exactly:
 * an entry the general YAML parser would read otherwise (a ` #` inside
 * it) comes back from the store as the pack's own line parser reads it.
 */
import { afterEach, expect, test } from "bun:test";

import {
  storeSchemaFields,
  writeSchemaPackToStore,
} from "../../../src/core/brain/schema-pack-store.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("an entry holding a comment marker is stored as rendered", () => {
  env = makeStoreEnv("osb-schema-roundtrip-", { legacyTree: false, configureVault: false });
  writeSchemaPackToStore(
    { vault: null, authority: "human", agent: "@t" },
    "schema:\n  expert_routing:\n    - review=docs #style\n  link_types:\n    - cites\n",
  );
  expect(storeSchemaFields()).toEqual({
    expert_routing: ["review=docs #style"],
    link_types: ["cites"],
  });
});

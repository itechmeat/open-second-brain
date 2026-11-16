/**
 * The schema pack's store fields round-trip the rendered entries exactly:
 * an entry the general YAML parser would read otherwise (a ` #` inside
 * it) comes back from the store as the pack's own line parser reads it.
 */
import { afterEach, expect, test } from "bun:test";

import {
  SCHEMA_PACK_FIELDS,
  storeSchemaFields,
  writeSchemaPackToStore,
} from "../../../src/core/brain/schema-pack-store.ts";
import { parseSchemaPack, renderSchemaBlock } from "../../../src/core/brain/schema-pack.ts";
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
    "schema:\n  {}\n",
    { fields: {}, decidedBy: {} },
  );
  expect(storeSchemaFields()).toEqual({
    expert_routing: ["review=docs #style"],
    link_types: ["cites"],
  });
});

test("the pack fields the store renders and attests are the fields the pack parser reads", () => {
  const entries: Record<string, string> = {
    preference_types: "taste",
    signal_types: "hint",
    page_types: "paper",
    log_event_kinds: "audit",
    aliases: "paper=article",
    prefixes: "paper=pa",
    link_types: "cites",
    extractable: "paper",
    expert_routing: "paper=reviewer",
    labels: "paper=reading",
    link_constraints: "cites=paper->paper",
    attributes: "paper.year=Publication year",
    frontmatter_tiers: "paper.year=user",
  };
  const text = [
    "schema:",
    ...Object.entries(entries).flatMap(([field, entry]) => [`  ${field}:`, `    - ${entry}`]),
  ].join("\n");
  const rendered = renderSchemaBlock(parseSchemaPack(`${text}\n`));
  const fields = [...rendered.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  expect(fields.toSorted()).toEqual([...SCHEMA_PACK_FIELDS].toSorted());
  expect(Object.keys(entries).toSorted()).toEqual([...SCHEMA_PACK_FIELDS].toSorted());
});

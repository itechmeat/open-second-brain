/**
 * The counterparty brief on a machine switched to the brain store (task
 * 2.10, design D14 item 1): the preference facts come from the store's
 * fold, not from files, the same lifecycle filter drops superseded and
 * tombstoned preferences, and building the brief writes nothing under
 * `<vault>/Brain/`. The unswitched cases live in `counterparty-brief.test.ts`.
 *
 * The entity's reserved-token gate reads the entity's lane record there,
 * since a switched machine holds the entity as store records only.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { buildCounterpartyBrief } from "../../../src/core/brain/counterparty-brief.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import { writePreferencePageText } from "../../../src/core/brain/preference-page-write.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { brainTreeDigest, switchDevice } from "./store-only/fixtures.ts";

const NOW = new Date("2026-06-01T12:00:00Z");
const PROMPT = "meet Ada Lovelace to prepare the review";

let env: StoreEnv;
let vault: string;

beforeEach(() => {
  // A bare vault (no Brain/ tree), switched: the store is the only memory.
  env = makeStoreEnv("osb-brief-store-only-", { legacyTree: false });
  vault = env.vault;
  switchDevice(env.storeRoot);
  upsertEntity(vault, { category: "people", name: "Ada Lovelace", agent: "t", now: NOW });
});

afterEach(() => env.cleanup());

/** A preference written through the store, as every switched writer does. */
function storePref(slug: string, body: string, createdAt: string, extra: string[] = []): void {
  writePreferencePageText(
    vault,
    slug,
    [
      "---",
      `id: pref-${slug}`,
      "topic: project notes",
      `principle: ${slug}`,
      "tier: core",
      `created_at: ${createdAt}`,
      ...extra,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

function brief() {
  const result = buildCounterpartyBrief(vault, { text: PROMPT, triggers: ["meet"], now: NOW });
  if (!("items" in result)) throw new Error(`expected a brief, got ${JSON.stringify(result)}`);
  return result;
}

describe("counterparty brief on a switched machine", () => {
  test("a preference held only as store records surfaces as a dated fact", () => {
    storePref("reviewed", "Ada Lovelace reviewed the draft", "2026-05-03T00:00:00Z");
    const before = brainTreeDigest(vault);
    const items = brief().items;
    expect(items.map((i) => [i.sourceRel, i.date])).toEqual([
      ["Brain/preferences/pref-reviewed.md", "2026-05-03"],
    ]);
    expect(brainTreeDigest(vault)).toBe(before);
    expect(existsSync(join(vault, "Brain"))).toBe(false);
  });

  test("superseded and tombstoned store preferences contribute no item", () => {
    storePref("superseded", "Ada Lovelace reviewed the draft", "2026-05-01T00:00:00Z", [
      "superseded_by: pref-new",
    ]);
    storePref("tombstoned", "Ada Lovelace reviewed the draft", "2026-05-02T00:00:00Z", [
      "_status: tombstoned",
    ]);
    storePref("live", "Ada Lovelace signed off", "2026-05-04T00:00:00Z");
    expect(brief().items.map((i) => i.sourceRel)).toEqual(["Brain/preferences/pref-live.md"]);
  });

  test("an entity the store holds in private never matches, token or not", () => {
    // Private by the operation's verdict alone: no visibility token on the page.
    withOperationPrivacy(true, () =>
      upsertEntity(vault, { category: "people", name: "Grace Hopper", agent: "t", now: NOW }),
    );
    const result = buildCounterpartyBrief(vault, {
      text: "meet Grace Hopper about the compiler",
      triggers: ["meet"],
      now: NOW,
    });
    expect(result).toEqual({ abstain: "no_match" });
  });
});

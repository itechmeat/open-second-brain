/**
 * Outbound surfaces on a store-only machine (task 2.10): a preference the
 * store holds in its `private` partition is withheld from everything that
 * leaves the machine even when its fields carry no visibility marker (the
 * operation that wrote it was judged private), as
 * `store-record-visibility.ts` withholds it at remote reach: the
 * counterparty brief, the preference export and the explorer denials.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildCounterpartyBrief,
  type CounterpartyBrief,
} from "../../../../src/core/brain/counterparty-brief.ts";
import { upsertEntity } from "../../../../src/core/brain/entities/registry.ts";
import { collectPreferenceRows } from "../../../../src/core/brain/export.ts";
import { collectExplorerDenials } from "../../../../src/core/brain/explorer.ts";
import { writePreferencePageText } from "../../../../src/core/brain/preference-page-write.ts";
import { withOperationPrivacy } from "../../../../src/core/store/operation-scope.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const NOW = new Date("2026-06-01T12:00:00Z");

/** A preference page as its writer renders it, with a body naming the person. */
function page(slug: string, body: string): string {
  return [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    `topic: ${slug}`,
    `principle: ${slug} principle`,
    "_status: confirmed",
    "created_at: 2026-05-01T00:00:00Z",
    "unconfirmed_until: 2026-05-30T00:00:00Z",
    "_evidenced_by: []",
    `tags: [brain, brain/preference, brain/topic/${slug}]`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function switchedWithPreferences(): StoreEnv {
  const e = makeStoreEnv("osb-private-outbound-", { dualWrite: false });
  env = e;
  switchDevice(e.storeRoot);
  upsertEntity(e.vault, { category: "people", name: "Ada Lovelace", agent: "t", now: NOW });
  writePreferencePageText(e.vault, "kept", page("kept", "Ada Lovelace reviewed the draft"));
  // A private operation: the record lands in `private`, with no marker field.
  withOperationPrivacy(true, () =>
    writePreferencePageText(e.vault, "hidden", page("hidden", "Ada Lovelace shared a secret")),
  );
  const held = partitionRecords(e.storeRoot, "private").map((r) => JSON.stringify(r.body));
  expect(held.some((body) => body.includes("pref-hidden"))).toBe(true);
  return e;
}

describe("a private-partition preference once switched", () => {
  test("never reaches the counterparty brief", () => {
    switchedWithPreferences();
    const brief = buildCounterpartyBrief(env!.vault, {
      text: "meet Ada Lovelace to prepare the review",
      triggers: ["meet"],
      now: NOW,
    }) as CounterpartyBrief;
    expect(brief).toEqual(expect.objectContaining({ items: expect.anything() }));
    expect(brief.items.map((i) => i.sourceRel)).toEqual(["Brain/preferences/pref-kept.md"]);
  });

  test("is denied by the preference export and the explorer", () => {
    switchedWithPreferences();
    const rows = collectPreferenceRows(env!.vault);
    expect(rows.failures).toEqual([]);
    expect(rows.denied.map((d) => d.id)).toEqual(["pref-hidden"]);
    expect(collectExplorerDenials(env!.vault).map((d) => d.id)).toEqual(["pref-hidden"]);
  });
});

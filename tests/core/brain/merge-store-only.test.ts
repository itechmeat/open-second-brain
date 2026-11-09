/**
 * `mergePreferences` on a machine switched to the brain store (task 2.10,
 * design D14 item 1): both sides are read from the store's fold, the keep
 * absorbs the drop's evidence and counters, the drop is retired through
 * records, the per-preference merge audit row is a store ledger row, and
 * no byte is written under the vault. The unswitched
 * cases live in `merge.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import {
  loadPreference,
  preferencePresence,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { ledgerRows, switchDevice } from "./store-only/fixtures.ts";

const NOW = new Date("2026-05-18T10:00:00Z");

let env: StoreEnv;

beforeEach(() => {
  // A vault that still holds a legacy Brain/ tree, switched: the strict case.
  env = makeStoreEnv("osb-merge-store-only-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

function pref(slug: string, signal: string): WritePreferenceInput {
  return {
    slug,
    topic: "commits",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [signal],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 0,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.8,
    pinned: false,
  };
}

/** Keep and drop, their counters folded from 2 and 3 apply-evidence events. */
function seedPair(): void {
  writePreference(env.vault, pref("keep", "[[sig-2026-05-01-keep]]"));
  writePreference(env.vault, pref("drop", "[[sig-2026-05-01-drop]]"));
  for (const [id, times] of [
    ["pref-keep", 2],
    ["pref-drop", 3],
  ] as const) {
    for (let i = 0; i < times; i++) {
      appendApplyEvidence(env.vault, {
        pref_id: id,
        artifact: `[[${id}-${i}]]`,
        result: "applied",
        agent: "t",
      });
    }
  }
}

describe("mergePreferences on a switched machine", () => {
  test("merges through the store's records and writes no byte under the vault", () => {
    seedPair();
    const before = digestVaultTree(env.vault);
    const auditBefore = ledgerRows(env.storeRoot, "private", "preference-audit").length;

    const plan = mergePreferences(env.vault, "pref-keep", "pref-drop", { now: NOW });
    // Both sides were read from the fold.
    expect(plan.applied_sum).toBe(5);
    // No page is written once switched: the plan names the retired record.
    expect(plan.retired_path).toBe("ret-drop");

    expect(digestVaultTree(env.vault)).toBe(before);
    expect(preferencePresence(env.vault, "drop")).toBe("retired");
    expect(preferencePresence(env.vault, "keep")).toBe("active");
    expect(loadPreference(env.vault, "keep")?.evidenced_by.toSorted()).toEqual([
      "[[sig-2026-05-01-drop]]",
      "[[sig-2026-05-01-keep]]",
    ]);
    // The merge audit row: audit rows go to private on a machine that holds
    // it (`auditRowRecord`), whatever the pair's own partition.
    const audit = ledgerRows(env.storeRoot, "private", "preference-audit").slice(auditBefore);
    expect(audit).toContainEqual(expect.objectContaining({ pref_id: "pref-keep", op: "merge" }));
  });

  // A switched machine folds the counters from evidence records, so the
  // merge carries the drop's evidence onto the keep.
  test("the keep carries the drop's counters after the merge, as on the legacy layout", () => {
    seedPair();
    mergePreferences(env.vault, "pref-keep", "pref-drop", { now: NOW });
    expect(loadPreference(env.vault, "keep")?.applied_count).toBe(5);
  });
});

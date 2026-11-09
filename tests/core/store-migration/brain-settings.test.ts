/**
 * `_brain.yaml` in the store (design D14 item 3): a census that every key
 * the Brain config validator reads is classified once, and the import that
 * writes shared keys as settings records and reports device keys.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PERMISSIONS_DOCUMENT_SETTING } from "../../../src/core/brain/permissions/document.ts";
import { brainConfigKnownKeys } from "../../../src/core/brain/policy/validate.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { SETTING_SET_KIND, SETTING_UNSET_KIND } from "../../../src/core/store/constants.ts";
import { foldSettings, settingValue } from "../../../src/core/store/fold-settings.ts";
import {
  BRAIN_YAML_KEYS,
  importBrainSettings,
} from "../../../src/core/store-migration/brain-settings.ts";
import { heldRecords } from "../../../src/core/store-migration/journal.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

const known = brainConfigKnownKeys();

describe("_brain.yaml key census", () => {
  test("every key the validator reads is classified", () => {
    expect([...known.topLevel].filter((key) => !(key in BRAIN_YAML_KEYS))).toEqual([]);
  });

  test("the table names no key the validator does not read", () => {
    expect(Object.keys(BRAIN_YAML_KEYS).filter((key) => !known.topLevel.has(key))).toEqual([]);
    for (const [block, rule] of Object.entries(BRAIN_YAML_KEYS)) {
      for (const field of Object.keys(rule.fields ?? {})) {
        expect([block, known.subKeys.get(block)?.has(field)]).toEqual([block, true]);
      }
    }
  });
});

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench("osb-brain-settings-");
  bench.fx.write(
    "Brain/_brain.yaml",
    [
      "schema_version: 1",
      "primary_agent: claude",
      "dream:",
      "  candidate_threshold: 4",
      "  unconfirmed_window_days: 14",
      "decision_model:",
      "  enabled: false",
      "snapshots:",
      "  retention_count: 9",
      "hygiene:",
      "  dedup_threshold: 0.9",
      "  resolver_cmd: ./resolve.sh",
      "future_block:",
      "  thing: 1",
      "",
    ].join("\n"),
  );
});
afterEach(() => bench.cleanup());

describe("importBrainSettings", () => {
  test("changed shared keys become human settings records once; device keys are reported", () => {
    const store = bench.store();
    const first = importBrainSettings(bench.vault, store, "test");
    expect(first.written.toSorted()).toEqual([
      "brain.decision_model.enabled",
      "brain.dream.candidate_threshold",
      "brain.hygiene.dedup_threshold",
      "brain.primary_agent",
    ]);
    // Equal to the shipped default: user config only when changed.
    expect(first.defaults).toEqual(["dream.unconfirmed_window_days"]);
    expect(first.device.map((d) => d.line).toSorted()).toEqual([
      'brain_hygiene_resolver_cmd: "./resolve.sh"',
      "brain_snapshots_retention_count: 9",
    ]);
    expect(first.unknown).toEqual(["future_block.thing"]);
    const fold = foldSettings(heldRecords(store));
    expect(settingValue(fold, "brain.dream.candidate_threshold")).toBe(4);
    expect(settingValue(fold, "brain.primary_agent")).toBe("claude");
    const seeded = heldRecords(store).filter((r) => r.kind === "setting-set");
    expect(seeded.every((r) => r.body["authority"] === "human")).toBe(true);

    const again = importBrainSettings(bench.vault, store, "test");
    expect(again.written).toEqual([]);
    expect(again.unchanged).toHaveLength(4);
  });

  test("a value the store already holds is never overwritten by a stale file", () => {
    const store = bench.store();
    importBrainSettings(bench.vault, store, "test");
    // After the first switch the user changes one setting and unsets
    // another in the store; the synced file keeps the old values.
    const edit = (kind: string, body: Record<string, unknown>) =>
      appendRecord(store, {
        partition: "shared",
        stream: "settings",
        kind,
        agent: "human",
        body: { authority: "human", ...body },
      });
    edit(SETTING_SET_KIND, { key: "brain.dream.candidate_threshold", value: 7 });
    edit(SETTING_UNSET_KIND, { key: "brain.primary_agent" });

    // A later machine (or a resumed run) imports the same file.
    const later = importBrainSettings(bench.vault, store, "test");
    expect(later.written).toEqual([]);
    const fold = foldSettings(heldRecords(store));
    expect(settingValue(fold, "brain.dream.candidate_threshold")).toBe(7);
    expect(fold.settings.get("brain.primary_agent")?.removed).toBe(true);
  });

  test("_permissions.yaml becomes the operator's permissions.document setting, once", () => {
    const text = "version: 1\ndefault_action: deny\nagents:\n  claude:\n    write: allow\n";
    bench.fx.write("Brain/_permissions.yaml", text);
    const store = bench.store();
    const first = importBrainSettings(bench.vault, store, "test");
    expect(first.written).toContain(PERMISSIONS_DOCUMENT_SETTING);
    const record = heldRecords(store).find(
      (r) => r.kind === SETTING_SET_KIND && r.body["key"] === PERMISSIONS_DOCUMENT_SETTING,
    );
    expect(record?.body["authority"]).toBe("human");
    expect(record?.body["value"]).toBe(text);

    // A later run never overwrites what the store holds (the operator may
    // have edited the setting since).
    bench.fx.write("Brain/_permissions.yaml", "version: 1\ndefault_action: allow\n");
    const again = importBrainSettings(bench.vault, store, "test");
    expect(again.written).not.toContain(PERMISSIONS_DOCUMENT_SETTING);
    expect(again.unchanged).toContain(PERMISSIONS_DOCUMENT_SETTING);
    expect(settingValue(foldSettings(heldRecords(store)), PERMISSIONS_DOCUMENT_SETTING)).toBe(text);
  });
});

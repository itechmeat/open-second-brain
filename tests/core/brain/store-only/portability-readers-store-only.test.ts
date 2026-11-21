/**
 * Readers of preferences, retired rules and signals on a switched vault
 * with no `Brain/` tree: page dedup candidates, the semantics backfill
 * plan, the sources dashboard and knowledge-pack list, conflicts, owner
 * blocks and uninstall. Each listed `Brain/preferences`, `Brain/retired`
 * or `Brain/inbox/**` with `readdirSync`, so each answered empty (or
 * removed nothing) once the rules lived in the store.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { findDuplicateCandidates } from "../../../../src/core/brain/page-dedup.ts";
import { brainDirs, preferencePath } from "../../../../src/core/brain/paths.ts";
import {
  installKnowledgePack,
  listInstalledKnowledgePacks,
  previewKnowledgePack,
  readKnowledgePack,
  sealKnowledgePack,
  selectKnowledgePack,
  uninstallKnowledgePack,
} from "../../../../src/core/brain/portability/knowledge-pack.ts";
import { writeOkfBundle } from "../../../../src/core/brain/portability/okf.ts";
import { aggregateSources } from "../../../../src/core/brain/portability/sources.ts";
import {
  loadPreference,
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../../src/core/brain/preference.ts";
import { planSemanticsBackfill } from "../../../../src/core/brain/semantics-backfill.ts";
import { writeSignal } from "../../../../src/core/brain/signal.ts";
import { BRAIN_RETIRED_REASON } from "../../../../src/core/brain/types.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SIGNAL_STATE_KIND } from "../../../../src/core/store/fold-signals.ts";
import { readStoreEntities } from "../../../../src/core/store/read/store-entities.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

function switchedEnv(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix, { legacyTree: false, dualWrite: false });
  expect(existsSync(join(e.vault, "Brain"))).toBe(false);
  return e;
}

const pref = (slug: string, over: Partial<WritePreferenceInput> = {}): WritePreferenceInput => ({
  slug,
  topic: "writing",
  principle: `Principle for ${slug}`,
  created_at: "2026-11-01T00:00:00Z",
  unconfirmed_until: "2026-11-08T00:00:00Z",
  status: "confirmed",
  confirmed_at: "2026-11-02T00:00:00Z",
  evidenced_by: [],
  ...over,
});

test("page dedup finds duplicate preferences held in the store", () => {
  env = switchedEnv("osb-page-dedup-store-");
  writePreference(env.vault, pref("first", { principle: "Same rule" }));
  writePreference(env.vault, pref("second", { principle: "Same rule" }));
  writePreference(env.vault, pref("other", { principle: "Another rule" }));

  const report = findDuplicateCandidates(env.vault);
  expect(report.scanned).toBe(3);
  expect(report.candidates.map((c) => [c.canonical.id, c.secondaries.map((s) => s.id)])).toEqual([
    ["pref-first", ["pref-second"]],
  ]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("the semantics backfill plan reads retired and active rules from the store", () => {
  env = switchedEnv("osb-semantics-store-");
  const written = writePreference(env.vault, pref("old"));
  moveToRetired(env.vault, written.path, BRAIN_RETIRED_REASON.rebutted, {
    now: new Date("2026-11-03T00:00:00Z"),
    retired_by: "[[Brain/log/2026-11-03]]",
  });
  writePreference(env.vault, pref("new", { supersedes: "[[ret-old]]" }));

  const plan = planSemanticsBackfill(env.vault);
  expect(plan.proposals.map((p) => [p.source_id, p.target_id, p.value])).toEqual([
    ["ret-old", "pref-new", "[[pref-new]]"],
  ]);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

test("the sources dashboard counts the store's signals", () => {
  env = switchedEnv("osb-sources-store-");
  for (const slug of ["alpha", "beta"]) {
    writeSignal(env.vault, {
      topic: slug,
      signal: "positive",
      agent: "claude",
      principle: `Principle of ${slug}`,
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug,
    });
  }

  const report = aggregateSources(env.vault);
  expect(report.sources).toEqual([
    {
      agent: "claude",
      source_type: "live",
      active: 2,
      processed: 0,
      archived: 0,
      distinct_topics: 2,
    },
  ]);
  expect(report.total_active).toBe(2);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
});

/** A pack built on an unswitched vault next door, installed into `vault`. */
function installTeamPack(e: StoreEnv, vault: string): ReturnType<typeof readKnowledgePack> {
  const src = mkdtempSync(join(e.parent, "src-"));
  mkdirSync(brainDirs(src).preferences, { recursive: true });
  mkdirSync(brainDirs(src).log, { recursive: true });
  writePreference(src, pref("team-rule", { topic: "team" }));
  expect(existsSync(preferencePath(src, "team-rule"))).toBe(true);
  const selected = selectKnowledgePack(src, ["topic:team"]);
  const packDir = join(e.parent, "pack");
  const sealed = sealKnowledgePack({
    name: "team-rules",
    version: "1.0.0",
    selection: selected.selection,
    okfManifest: selected.okfManifest,
    pageFiles: selected.pageFiles,
    preferences: selected.preferences,
    now: new Date("2026-11-01T00:00:00Z"),
  });
  writeOkfBundle(packDir, { manifest: selected.okfManifest, files: sealed.files });
  rmSync(src, { recursive: true, force: true });

  const pack = readKnowledgePack(packDir);
  const installed = installKnowledgePack(vault, pack, { now: new Date("2026-11-02T00:00:00Z") });
  expect(installed.preferences.installed).toEqual(["pref-team-rule"]);
  expect(loadPreference(vault, "team-rule")).not.toBeNull();

  return pack;
}

test("knowledge packs: owner block, list, conflicts and uninstall read the store", () => {
  env = switchedEnv("osb-kpack-store-");
  const { vault } = env;

  // An owner-scoped rule of the switched vault is never packed.
  writePreference(vault, pref("owned", { topic: "secret", owner: "agent:someone" }));
  writePreference(vault, pref("plain", { topic: "secret" }));
  const owned = selectKnowledgePack(vault, ["topic:secret"], {});
  expect(owned.blocked).toEqual([{ kind: "preference", id: "pref-owned", reason: "owner" }]);
  expect(owned.preferences.map((p) => p.id)).toEqual(["pref-plain"]);

  const pack = installTeamPack(env, vault);

  const listed = listInstalledKnowledgePacks(vault);
  expect(listed.map((p) => [p.name, p.entries.map((e) => [e.kind, e.id])])).toEqual([
    ["team-rules", [["preference", "pref-team-rule"]]],
  ]);

  expect(previewKnowledgePack(vault, pack).conflicts).toContainEqual({
    kind: "preference",
    id: "pref-team-rule",
    reason: "id_exists",
    detail: "Brain/preferences/pref-team-rule.md",
  });

  const done = uninstallKnowledgePack(vault, "team-rules", {
    confirm: true,
    now: new Date("2026-11-03T00:00:00Z"),
  });
  expect(done.deleted).toEqual(["Brain/preferences/pref-team-rule.md"]);
  expect(loadPreference(vault, "team-rule")).toBeNull();
  expect(listInstalledKnowledgePacks(vault)).toEqual([]);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

test("a knowledge pack uninstall removes no rule while the fold it judged may miss a record", () => {
  env = switchedEnv("osb-kpack-store-gap-");
  const { vault } = env;
  installTeamPack(env, vault);

  // A peer's events shard, read once, then gone: whatever it held is
  // unknown to this read.
  const peerShard = appendRecord(openStore({ root: env.storeRoot, device: "dev-b" }), {
    partition: "shared",
    stream: "events",
    kind: SIGNAL_STATE_KIND,
    agent: "u",
    body: { authority: "human", signal: "sig-elsewhere", fields: { topic: "elsewhere" } },
  }).path;
  readStoreEntities();
  rmSync(peerShard);

  const done = uninstallKnowledgePack(vault, "team-rules", {
    confirm: true,
    now: new Date("2026-11-03T00:00:00Z"),
  });
  expect(done.deleted).toEqual([]);
  expect(done.refused).toEqual(["Brain/preferences/pref-team-rule.md"]);
  expect(loadPreference(vault, "team-rule")).not.toBeNull();
});

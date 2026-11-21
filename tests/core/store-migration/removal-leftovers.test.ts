/**
 * What a removal of the legacy tree says it did, and the device-local
 * folder a second machine keeps after the removal on the first one synced
 * the tree away: the vault's sync never carried that machine's own search
 * index and caches, so the deletion did not reach them either.
 *
 *  - The report names what it deleted as rebuildable, with the size, and
 *    says everything else was moved; a long list is a count and its first
 *    few entries.
 *  - On the second machine the doctor names the leftover folder with its
 *    size and the command that clears it, and that command (the removal)
 *    clears it although the cohort no longer matters: the tree is gone.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { LEGACY_LOCAL_FILES_LEFT_CODE } from "../../../src/core/brain/doctor/migration-check.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { readMigrationBackup } from "../../../src/core/store-migration/backup.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { MIGRATION_STREAM } from "../../../src/core/store-migration/migration-records.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore, removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import {
  LEGACY_ARCHIVE_DIR,
  readRemovalInProgress,
  removeLegacyTree,
} from "../../../src/core/store-migration/removal.ts";
import {
  removedLines,
  runRemoveLegacy,
  summariseList,
} from "../../../src/cli/brain/verbs/migrate-store-forms.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function retire(machine: Machine, device: string): void {
  appendRecord(machine.store(), {
    partition: "shared",
    stream: "settings",
    kind: "device-retire",
    agent: "t",
    body: { authority: "human", device },
  });
}

/**
 * The sync deletes on `machine` what it carried: Brain/ and every synced
 * file of .open-second-brain/. What it never carried stays: this machine's
 * search index and its inject cache.
 */
function syncDeletesTree(machine: Machine): void {
  rmSync(join(machine.vault, "Brain"), { recursive: true, force: true });
  const local = join(machine.vault, ".open-second-brain");
  for (const name of readdirSync(local))
    rmSync(join(local, name), { recursive: true, force: true });
  writeFileSync(join(local, "brain.sqlite"), Buffer.alloc(300_000, 1));
  mkdirSync(join(local, "inject-cache"), { recursive: true });
  writeFileSync(join(local, "inject-cache", "digest.json"), "{}\n");
}

/** The latest `legacy-tree-removed` record `machine` itself wrote. */
function ownRemovalRecord(machine: Machine) {
  return machine
    .records()
    .findLast((r) => r.kind === "legacy-tree-removed" && r.device === machine.name);
}

/** Two switched machines; dev-a removed the legacy tree, and the deletion reached dev-b by sync. */
function treeLeftOnBoth(retiredBy: "hand" | "silence" = "hand"): { a: Machine; b: Machine } {
  fleet = makeFleet(["dev-a", "dev-b"]);
  const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
  fleet.syncStore("dev-a", "dev-b");
  b.use();
  expect(migrateStore(b.vault, FAST).ok).toBe(true);
  fleet.syncStore("dev-b", "dev-a");
  a.use();
  // dev-c, the fixture's legacy writer, last wrote on 2026-09-01.
  if (retiredBy === "hand") retire(a, "dev-c");
  else setSilenceDays(a, 10);
  const removed = removeLegacy(a.vault);
  if (!removed.removed) throw new Error(`not removed on dev-a: ${removed.reason}`);
  fleet.syncStore("dev-a", "dev-b");
  // The sync deletes on dev-b what it carried: Brain/ and every synced
  // file of .open-second-brain/. What it never carried stays: this
  // machine's search index and its inject cache.
  rmSync(join(b.vault, "Brain"), { recursive: true, force: true });
  const local = join(b.vault, ".open-second-brain");
  for (const name of readdirSync(local))
    rmSync(join(local, name), { recursive: true, force: true });
  writeFileSync(join(local, "brain.sqlite"), Buffer.alloc(300_000, 1));
  mkdirSync(join(local, "inject-cache"), { recursive: true });
  writeFileSync(join(local, "inject-cache", "digest.json"), "{}\n");
  b.use();
  return { a, b };
}

describe("the report of a removal", () => {
  test("names what it deleted as rebuildable, with the size, and says the rest was moved", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    setSilenceDays(a, 0);
    const removed = removeLegacy(a.vault, { force: true });
    if (!removed.removed) throw new Error("not removed");

    expect(removed.skipped_sizes.map((s) => s.path).toSorted()).toEqual(
      [...removed.skipped].toSorted(),
    );
    expect(removed.skipped_bytes).toBe(removed.skipped_sizes.reduce((n, s) => n + s.bytes, 0));
    const text = removedLines(removed).join("\n");
    expect(text).not.toContain("nothing was deleted");
    expect(text).toContain(`Deleted ${removed.skipped.length} rebuildable file(s)`);
    expect(text).toContain(".open-second-brain/brain.sqlite (");
    expect(text).toContain("Everything else was moved into the archive, not deleted.");
  });

  test("a long list is its count and the first few entries", () => {
    const pages = Array.from({ length: 400 }, (_, i) => `Brain/log/day-${i}.md`);
    expect(summariseList(pages)).toBe(
      "Brain/log/day-0.md, Brain/log/day-1.md, Brain/log/day-2.md, Brain/log/day-3.md, " +
        "Brain/log/day-4.md and 395 more",
    );
    expect(summariseList(["a", "b"])).toBe("a, b");
  });
});

describe("a machine whose tree left by sync", () => {
  test("the doctor names the leftover device-local folder, its size and the command", () => {
    const { b } = treeLeftOnBoth();

    const found = (runDoctor(b.vault).uncertain ?? []).find(
      (u) => u.code === LEGACY_LOCAL_FILES_LEFT_CODE,
    );
    expect(found?.message).toContain(".open-second-brain/brain.sqlite (300 KB)");
    expect(found?.message).toContain(".open-second-brain/inject-cache");
    expect(found?.message).toContain("o2b brain migrate-store --remove-legacy");
    // A caller below local reach gets the count and the size, no names.
    const withheld = (runDoctor(b.vault, { withholdsPrivate: true }).uncertain ?? []).find(
      (u) => u.code === LEGACY_LOCAL_FILES_LEFT_CODE,
    );
    expect(withheld?.message).toContain("2 entries");
    expect(withheld?.message).not.toContain("brain.sqlite");
    expect(withheld?.message).not.toContain("inject-cache");
    expect(withheld?.path).toBeUndefined();
    // Advice only: nothing was removed by the doctor.
    expect(existsSync(join(b.vault, ".open-second-brain", "brain.sqlite"))).toBe(true);
  });

  test("the removal clears it, the cohort notwithstanding, and the doctor is silent after", () => {
    const { b } = treeLeftOnBoth();
    // A cohort device still pending would keep a tree in place; this vault
    // has none left to keep.
    setSilenceDays(b, 0);

    const removed = removeLegacy(b.vault);
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    expect(removed.tree_already_left).toBe(true);
    expect(removed.moved).toEqual([".open-second-brain"]);
    expect(removed.skipped).toContain(".open-second-brain/brain.sqlite");
    expect(existsSync(join(b.vault, ".open-second-brain"))).toBe(false);
    expect(removedLines(removed)[0]).toContain("The legacy tree had already left the vault");
    // The cohort as it stands, on this machine too: both switched, the
    // one retired by hand named as such (it used to read "switched: dev-a").
    const text = removedLines(removed).join("\n");
    expect(text).toContain("switched: dev-a, dev-b");
    expect(text).toContain("retired by hand: dev-c");
    expect((runDoctor(b.vault).uncertain ?? []).map((u) => u.code)).not.toContain(
      LEGACY_LOCAL_FILES_LEFT_CODE,
    );
  });

  test("a later machine names the devices retired by silence, as the machine that removed the tree did", () => {
    const { a, b } = treeLeftOnBoth("silence");
    const first = a.records().find((r) => r.kind === "legacy-tree-removed");
    const silent = (first?.body["retired_by_silence"] ?? []) as ReadonlyArray<{ device: string }>;
    expect(silent.map((d) => d.device)).toEqual(["dev-c"]);

    const removed = removeLegacy(b.vault);
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    expect(removed.tree_already_left).toBe(true);
    expect(removed.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
    expect(removed.silence_threshold_days).toBe(10);
    const text = removedLines(removed).join("\n");
    expect(text).toContain("switched: dev-a, dev-b");
    expect(text).toContain("retired by silence (no evidence of life for more than 10 days");
    expect(text).toContain("dev-c (last evidence 2026-09-01)");
    expect(text).not.toContain("retired by hand");
  });
  test("with nothing of the tree left, the removal succeeds and names the cohort as a removal does", () => {
    const { b } = treeLeftOnBoth("silence");
    // The deletion took this machine's leftover folder too (rsync --delete).
    rmSync(join(b.vault, ".open-second-brain"), { recursive: true, force: true });

    const result = removeLegacy(b.vault);
    if (result.removed || result.reason !== "no-legacy-tree") {
      throw new Error(`expected no legacy tree on dev-b, got ${JSON.stringify(result)}`);
    }
    expect(result.switched).toEqual(["dev-a", "dev-b"]);
    expect(result.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
    expect(result.silence_threshold_days).toBe(10);

    const chunks: string[] = [];
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      chunks.push(c);
      return true;
    };
    let code: number;
    try {
      code = runRemoveLegacy(b.vault, process.env["OPEN_SECOND_BRAIN_CONFIG"]!, false, false);
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    }
    const text = chunks.join("");
    expect(code).toBe(0);
    expect(text).not.toContain("stays in the vault");
    expect(text).toContain("The legacy tree is not in this vault");
    expect(text).toContain("switched: dev-a, dev-b");
    expect(text).toContain("retired by silence (no evidence of life for more than 10 days");
    expect(text).toContain("dev-c (last evidence 2026-09-01)");
  });

  test("a device a forced removal left behind is never named retired by hand afterwards", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // dev-c, the fixture's legacy writer, is pending: the rule is off.
    setSilenceDays(a, 0);
    const forced = removeLegacy(a.vault, { force: true });
    if (!forced.removed) throw new Error(`not removed: ${forced.reason}`);
    expect(forced.stopped).toContain("dev-c");

    const again = removeLegacy(a.vault);
    if (again.removed || again.reason !== "no-legacy-tree") {
      throw new Error(`expected no legacy tree, got ${JSON.stringify(again)}`);
    }
    expect(again.retired).not.toContain("dev-c");
    expect(again.switched).toEqual(["dev-a"]);
  });

  test("a cleanup never takes another vault's identity or its silence verdict", () => {
    const { a, b } = treeLeftOnBoth("silence");
    const vaultId = a.records().find((r) => r.kind === "legacy-tree-removed")?.body["vault_id"];
    expect(typeof vaultId).toBe("string");
    // One store serves every vault on a machine: dev-b later switched on
    // another vault, whose removal retired dev-z by silence.
    b.use();
    for (const [kind, body] of [
      ["device-switched", { authority: "human", vault_id: "vault-elsewhere", device: "dev-b" }],
      [
        "legacy-tree-removed",
        {
          authority: "human",
          vault_id: "vault-elsewhere",
          device: "dev-b",
          forced: false,
          stopped: [],
          retired_by_silence: [{ device: "dev-z", last_evidence: "2026-08-01T00:00:00Z" }],
          silence_threshold_days: 5,
          as_of: "2026-11-01T00:00:00Z",
        },
      ],
    ] as const) {
      appendRecord(b.store(), {
        partition: "shared",
        stream: MIGRATION_STREAM,
        kind,
        agent: "t",
        body: { ...body },
      });
    }

    const removed = removeLegacy(b.vault);
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    // The id is this vault's, from the backup this machine took of it.
    expect(ownRemovalRecord(b)?.body["vault_id"]).toBe(vaultId);
    expect(removed.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
  });

  test("a cleanup whose backup is of another vault records no vault identity", () => {
    const { b } = treeLeftOnBoth("silence");
    const backup = readMigrationBackup(migrationDir(b.store()));
    if (backup === null) throw new Error("dev-b took no migration backup");
    const manifest = join(backup.dir, "manifest.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    const elsewhere = join(fleet!.parent, "another-vault");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify({ ...parsed, vault: { vault_id: "vault-elsewhere", path: elsewhere } }),
    );

    const removed = removeLegacy(b.vault);
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    expect(ownRemovalRecord(b)?.body["vault_id"]).toBeNull();
  });

  test("the verdict of the removal that moved the tree outlives a cleanup that did not see it", () => {
    fleet = makeFleet(["dev-a", "dev-b", "dev-e"]);
    const [a, b, e] = [fleet.machine("dev-a"), fleet.machine("dev-b"), fleet.machine("dev-e")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    for (const later of [b, e]) {
      fleet.syncVaultFile("dev-a", later.name, "Brain/vault-id.json");
      fleet.syncStore("dev-a", later.name);
      later.use();
      expect(migrateStore(later.vault, FAST).ok).toBe(true);
      fleet.syncStore(later.name, "dev-a");
    }
    a.use();
    setSilenceDays(a, 10);
    const first = removeLegacy(a.vault);
    if (!first.removed) throw new Error(`not removed on dev-a: ${first.reason}`);
    expect(first.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
    // The tree's deletion reaches both machines; dev-a's record reaches
    // only dev-e before dev-b cleans up.
    fleet.syncStore("dev-a", "dev-e");
    syncDeletesTree(b);
    syncDeletesTree(e);

    b.use();
    const cleanup = removeLegacy(b.vault);
    if (!cleanup.removed) throw new Error(`not removed on dev-b: ${cleanup.reason}`);
    expect(cleanup.retired_by_silence).toEqual([]);
    expect(ownRemovalRecord(b)?.body["tree_already_left"]).toBe(true);
    // dev-b's later cleanup record reaches dev-e too (its own shards only:
    // dev-b's copy of dev-a's shards is older than dev-e's).
    fleet.syncStore("dev-b", "dev-e", (rel) => rel.split(/[\\/]/).includes("dev-b"));

    e.use();
    const held = e.records().filter((r) => r.kind === "legacy-tree-removed");
    expect(held.map((r) => r.device).toSorted()).toEqual(["dev-a", "dev-b"]);
    const removed = removeLegacy(e.vault);
    if (!removed.removed) throw new Error(`not removed on dev-e: ${removed.reason}`);
    expect(removed.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
    expect(removed.silence_threshold_days).toBe(10);
  });
  test("an empty silence verdict of the removal that moved the tree stays its verdict", () => {
    // dev-a retires dev-c by hand and removes the tree: nobody was retired
    // by silence, and its record says so with an empty list.
    const { a, b } = treeLeftOnBoth("hand");
    const first = ownRemovalRecord(a);
    expect(first?.body["retired_by_silence"]).toEqual([]);
    const threshold = first?.body["silence_threshold_days"];
    const asOf = first?.body["as_of"];
    // dev-c writes again after its retirement, then falls silent: today's
    // read calls it silent, but that is not why the tree left.
    const later = Date.now() + 86_400_000;
    appendRecord(
      openStore({ root: b.storeRoot, device: "dev-c" }),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "back" } },
      { now: () => later },
    );
    // The store moves on: dev-b writes two months later, so the silence
    // rule's reference date is past dev-c's last record.
    const today = later + 60 * 86_400_000;
    appendRecord(
      b.store(),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "on" } },
      { now: () => today },
    );
    setSilenceDays(b, 10);

    const removed = removeLegacy(b.vault, { now: new Date(today) });
    if (!removed.removed) throw new Error(`not removed on dev-b: ${removed.reason}`);
    expect(removed.tree_already_left).toBe(true);
    expect(removed.retired_by_silence).toEqual([]);
    expect(removed.silence_threshold_days).toBe(threshold as number);
    expect(removed.as_of).toBe(asOf as string);
  });
  test("a cleanup interrupted after its journal is still a cleanup when it is retried", () => {
    const { b } = treeLeftOnBoth("silence");
    const first = new Date("2026-11-19T10:00:00.000Z");
    const archive = join(
      b.store().deviceStateDir,
      LEGACY_ARCHIVE_DIR,
      first.toISOString().replace(/[:.]/g, "-"),
    );
    // The leftovers cannot move: something already sits at their archive place.
    mkdirSync(join(archive, ".open-second-brain", "blocker"), { recursive: true });
    expect(() => removeLegacyTree(b.vault, b.store(), { agent: "t", now: first })).toThrow();
    expect(readRemovalInProgress(b.store())?.tree_already_left).toBe(true);

    rmSync(join(archive, ".open-second-brain"), { recursive: true, force: true });
    const done = removeLegacyTree(b.vault, b.store(), {
      agent: "t",
      now: new Date("2026-11-19T11:00:00.000Z"),
    });
    if (!done.removed) throw new Error(`not removed on dev-b: ${done.reason}`);
    expect(done.tree_already_left).toBe(true);
    expect(done.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
    expect(ownRemovalRecord(b)?.body["tree_already_left"]).toBe(true);
    expect(readRemovalInProgress(b.store())).toBeNull();
  });
});

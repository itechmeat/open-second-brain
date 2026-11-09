/**
 * Removal of the legacy tree (task 2.5) and the two doctor findings of
 * the transition (task 2.12): the cohort gate closed and open, `--force`
 * with its report, a cohort device offline for months that keeps the gate
 * closed, the dated device-local archive, the doctor naming devices still
 * on the legacy layout, and a legacy directory that comes back.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  LEGACY_DEVICES_PENDING_CODE,
  LEGACY_TREE_REAPPEARED_CODE,
  MIGRATION_DONE_TWICE_CODE,
} from "../../../src/core/brain/doctor/migration-check.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { planMigrationDryRun } from "../../../src/core/store-migration/dry-run.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import {
  holdMigrationGate,
  migrationGatePath,
  readMigrationGate,
} from "../../../src/core/migration-gate.ts";
import { migrateStore, removeLegacy, rollback } from "../../../src/core/store-migration/outcome.ts";
import { MigrationGateBusyError } from "../../../src/core/store-migration/quiesce.ts";
import {
  LEGACY_ARCHIVE_DIR,
  readRemovalInProgress,
  removeLegacyTree,
} from "../../../src/core/store-migration/removal.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import {
  readRemovalMarker,
  sameVaultPath,
} from "../../../src/core/store-migration/removal-marker.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";

const FAST = { settleMs: 0 } as const;

/** Whether this host lets the test create a symlink (Windows needs a privilege). */
const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "osb-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const RACER = join(import.meta.dir, "fixtures", "removal-racer.ts");
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

function doctorWarningCodes(vault: string): string[] {
  return runDoctor(vault).warnings.map((w) => w.code);
}

describe("removing the legacy tree", () => {
  test("the gate stays closed while cohort devices are on the legacy layout, and doctor names them", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // The fixture's legacy shards name dev-b and dev-c, which never migrated.
    const blocked = removeLegacy(a.vault);
    expect(blocked).toEqual({
      removed: false,
      reason: "cohort-pending",
      pending: ["dev-b", "dev-c"],
    });
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);

    const result = runDoctor(a.vault);
    const pending = (result.uncertain ?? []).find((u) => u.code === LEGACY_DEVICES_PENDING_CODE);
    expect(pending?.message).toContain("dev-b, dev-c still write the legacy Brain/ tree");
    expect(result.warnings.map((w) => w.code)).not.toContain(LEGACY_DEVICES_PENDING_CODE);
  });

  test("doctor also names a device that writes legacy log shards but is in no cohort", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // dev-d joined after the cohort was recorded and still writes the tree.
    writeFileSync(
      join(a.vault, "Brain", "log", "2026-11-03.dev-d.jsonl"),
      `${JSON.stringify({ ts: "2026-11-03T10:00:00Z", event_type: "note", text: "late" })}\n`,
    );
    const pending = (runDoctor(a.vault).uncertain ?? []).find(
      (u) => u.code === LEGACY_DEVICES_PENDING_CODE,
    );
    expect(pending?.message).toContain("dev-d");
  });

  test("a cohort device offline for more than 30 days keeps the gate closed", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // dev-c's shard is 60 days old: off the 30-day roster, still in the cohort.
    const devices = planMigrationDryRun(a.vault).devices;
    expect(devices.cohort.map((d) => d.device)).toContain("dev-c");
    expect(devices.roster).not.toContain("dev-c");
    retire(a, "dev-b");
    expect(removeLegacy(a.vault)).toEqual({
      removed: false,
      reason: "cohort-pending",
      pending: ["dev-c"],
    });
  });

  test("a retired device that writes again is back in the cohort until it is retired again", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    retire(a, "dev-b");
    retire(a, "dev-c");
    // dev-b, retired, writes a record afterwards (on its own clock, later).
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    appendRecord(
      b.store(),
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "back" } },
      { now: () => Date.now() + 60_000 },
    );
    fleet.syncStore("dev-b", "dev-a");
    a.use();
    expect(removeLegacy(a.vault)).toEqual({
      removed: false,
      reason: "cohort-pending",
      pending: ["dev-b"],
    });
    // Retired again, after that write: out of the cohort, the gate opens.
    appendRecord(
      a.store(),
      {
        partition: "shared",
        stream: "settings",
        kind: "device-retire",
        agent: "t",
        body: { authority: "human", device: "dev-b" },
      },
      { now: () => Date.now() + 120_000 },
    );
    expect(removeLegacy(a.vault).removed).toBe(true);
  });

  test("the gate opens once every cohort device switched or retired; the tree goes to a dated archive", () => {
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
    retire(a, "dev-c");

    const removed = removeLegacy(a.vault);
    if (!removed.removed) throw new Error(`not removed: ${removed.reason}`);
    expect(removed.forced).toBe(false);
    expect(removed.stopped).toEqual([]);
    expect(removed.moved).toEqual([".open-second-brain", "Brain"]);
    expect(existsSync(join(a.vault, "Brain"))).toBe(false);
    expect(existsSync(join(a.vault, ".open-second-brain"))).toBe(false);
    expect(existsSync(join(removed.archive, "Brain", "inbox", "2026-11-01-tabs.md"))).toBe(true);
    expect(removed.archive).toContain("legacy-archive");
    // Rebuildable files are not archived: the index and the log day pages.
    expect(removed.skipped).toContain(".open-second-brain/brain.sqlite");
    expect(removed.skipped).toContain("Brain/log/2026-11-01.dev-a.md");
    expect(existsSync(join(removed.archive, ".open-second-brain", "brain.sqlite"))).toBe(false);
    expect(existsSync(join(removed.archive, ".open-second-brain", "secrets", "keyfile"))).toBe(
      true,
    );
    expect(doctorWarningCodes(a.vault)).not.toContain(LEGACY_TREE_REAPPEARED_CODE);

    // An agent following stale instructions writes the legacy layout again.
    mkdirSync(join(a.vault, "Brain", "preferences"), { recursive: true });
    writeFileSync(
      join(a.vault, "Brain", "preferences", "pref-stale.md"),
      '---\nid: pref-stale\nagent: "@stale-agent"\n---\n',
    );
    const result = runDoctor(a.vault);
    const back = result.warnings.find((w) => w.code === LEGACY_TREE_REAPPEARED_CODE);
    expect(back?.message).toContain("@stale-agent");
  });

  test("--force removes the tree and names the devices that stop reaching the store", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const removed = removeLegacy(a.vault, { force: true });
    if (!removed.removed) throw new Error("not removed");
    expect(removed.forced).toBe(true);
    expect(removed.stopped).toEqual(["dev-b", "dev-c"]);
    expect(readdirSync(removed.archive).toSorted()).toEqual([".open-second-brain", "Brain"]);
    expect(a.records().some((r) => r.kind === "legacy-tree-removed")).toBe(true);
  });

  test("a removal interrupted after its first move is finished into the same archive", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const first = new Date("2026-11-09T10:00:00.000Z");
    const archive = join(
      a.store().deviceStateDir,
      LEGACY_ARCHIVE_DIR,
      first.toISOString().replace(/[:.]/g, "-"),
    );
    // `Brain` cannot move: something already sits at its archive place.
    mkdirSync(join(archive, "Brain", "blocker"), { recursive: true });
    expect(() =>
      removeLegacyTree(a.vault, a.store(), { agent: "t", force: true, now: first }),
    ).toThrow();
    expect(existsSync(join(a.vault, ".open-second-brain"))).toBe(false);
    expect(readRemovalInProgress(a.store())?.archive).toBe(archive);
    // Half removed: a rollback would rebuild half a tree.
    expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);

    rmSync(join(archive, "Brain"), { recursive: true, force: true });
    const done = removeLegacyTree(a.vault, a.store(), {
      agent: "t",
      force: true,
      now: new Date("2026-11-10T10:00:00.000Z"),
    });
    if (!done.removed) throw new Error("not removed");
    expect(done.archive).toBe(archive);
    expect(done.moved).toEqual([".open-second-brain", "Brain"]);
    expect(readRemovalInProgress(a.store())).toBeNull();
    expect(a.records().filter((r) => r.kind === "legacy-tree-removed")).toHaveLength(1);
  });

  test("holds the migration gate, and never takes it from a live run", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // This process stands in for a live run holding the gate.
    holdMigrationGate(a.vault, "other-run");
    expect(() => removeLegacy(a.vault, { force: true })).toThrow(MigrationGateBusyError);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
    expect(readMigrationGate()?.run_id).toBe("other-run");
  });

  test("never replaces another vault's unfinished removal journal", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const journal = join(migrationDir(a.store()), "removal.json");
    const other = { vault: join(fleet.parent, "other-vault"), at: "x", archive: "y" };
    writeFileSync(journal, `${JSON.stringify(other)}\n`);
    expect(() => removeLegacy(a.vault, { force: true })).toThrow(/unfinished/);
    expect(readRemovalInProgress(a.store())?.vault).toBe(other.vault);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
  });

  test("never lifts the gate an interrupted migration of the vault still holds", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const gate = { vault: a.vault, run_id: "migrate-interrupted", since: "", pid: 0 };
    writeFileSync(migrationGatePath(), JSON.stringify(gate));
    expect(() => removeLegacy(a.vault, { force: true })).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe("migrate-interrupted");
  });
});

const PRIVATE_PAGE = "Brain/inbox/2026-11-08-secret.md";
const PRIVATE_SIGNAL =
  "---\nid: sig-secret\ntopic: secret\nprinciple: secret\nvisibility: private\n---\nRaw.\n";

/**
 * dev-a switched alone, every other cohort device retired, and the private
 * partition taken off this machine (it now holds only shared). Returns a
 * function that brings the partition back.
 */
function switchedWithoutPrivate(): { a: Machine; restorePrivate: () => void } {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  retire(a, "dev-b");
  retire(a, "dev-c");
  const aside = join(fleet.parent, "private-aside");
  moveNeverHeld(a.storeRoot, aside);
  return { a, restorePrivate: () => renameSync(aside, join(a.storeRoot, "private")) };
}

describe("a removal while a settings shard cannot be read", () => {
  test.skipIf(!CAN_SYMLINK)(
    "refuses: a cohort record in that shard may name a device still on the legacy layout",
    () => {
      fleet = makeFleet(["dev-a"]);
      const a = fleet.machine("dev-a");
      a.use();
      expect(runMigration(a.vault, FAST).ok).toBe(true);
      retire(a, "dev-b");
      retire(a, "dev-c");
      // A peer's cohort record names a device that never wrote a legacy shard.
      appendRecord(openStore({ root: a.storeRoot, device: "dev-p" }), {
        partition: "shared",
        stream: "settings",
        kind: "migration-cohort",
        agent: "t",
        body: { authority: "human", vault_id: null, devices: ["dev-q"] },
      });
      const kept = removeLegacy(a.vault);
      expect(kept).toMatchObject({ removed: false, reason: "cohort-pending", pending: ["dev-q"] });
      // The peer's shard turns into something the reader refuses (a link).
      const peer = join(a.storeRoot, "shared", "settings", "dev-p");
      for (const name of readdirSync(peer)) {
        renameSync(join(peer, name), join(a.storeRoot, `moved-${name}`));
        symlinkSync(join(a.storeRoot, `moved-${name}`), join(peer, name));
      }
      expect(() => removeLegacy(a.vault)).toThrow(/cannot be read/);
      expect(existsSync(join(a.vault, "Brain"))).toBe(true);
    },
  );
});

/** dev-a switched, dev-b and dev-c retired, and dev-p's cohort names dev-q. */
function withPeerCohort(): { a: Machine; shard: string } {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  retire(a, "dev-b");
  retire(a, "dev-c");
  const peer = openStore({ root: a.storeRoot, device: "dev-p" });
  appendRecord(peer, {
    partition: "shared",
    stream: "settings",
    kind: "migration-cohort",
    agent: "t",
    body: { authority: "human", vault_id: null, devices: ["dev-q"] },
  });
  // A later line of the same shard stays readable.
  appendRecord(peer, {
    partition: "shared",
    stream: "settings",
    kind: "setting-set",
    agent: "t",
    body: { authority: "human", key: "view.language", value: "en" },
  });
  const dir = join(a.storeRoot, "shared", "settings", "dev-p");
  const [name] = readdirSync(dir);
  return { a, shard: join(dir, name!) };
}

describe("a removal while a settings shard is read only in part", () => {
  test("a corrupt cohort line refuses without --force, and --force removes the tree", () => {
    const { a, shard } = withPeerCohort();
    const lines = readFileSync(shard, "utf8").split("\n");
    expect(lines[0]).toContain("migration-cohort");
    // One byte flipped inside the line: it no longer parses, nor is it a cut-short line.
    lines[0] = lines[0]!.replace('"kind":', '"kind";');
    writeFileSync(shard, lines.join("\n"));
    expect(() => removeLegacy(a.vault)).toThrow(/cannot be read in full/);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
    expect(removeLegacy(a.vault, { force: true })).toMatchObject({ removed: true, forced: true });
  });

  test("a cohort record whose blob has not arrived refuses without --force", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    retire(a, "dev-b");
    retire(a, "dev-c");
    // A cohort long enough to go to a blob; the blob has not arrived here.
    const devices = Array.from({ length: 900 }, (_, i) => `dev-q${String(i).padStart(3, "0")}`);
    appendRecord(openStore({ root: a.storeRoot, device: "dev-p" }), {
      partition: "shared",
      stream: "settings",
      kind: "migration-cohort",
      agent: "t",
      body: { authority: "human", vault_id: null, devices, note: "x".repeat(20_000) },
    });
    rmSync(join(a.storeRoot, "shared", "blobs"), { recursive: true, force: true });
    expect(() => removeLegacy(a.vault)).toThrow(/cannot be read in full/);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
  });

  test("a line cut short by a crash and closed by the next append does not refuse", () => {
    const { a, shard } = withPeerCohort();
    // Rewrite dev-p's shard: a torn fragment, then the next record whole.
    const lines = readFileSync(shard, "utf8").split("\n");
    writeFileSync(shard, `${lines[1]!.slice(0, 40)}\n${lines[1]}\n`);
    // dev-p's cohort record is gone with the rewrite; nothing else is pending.
    expect(removeLegacy(a.vault)).toMatchObject({ removed: true, forced: false });
  });
});

describe("a removal with late items held back for a partition this machine lacks", () => {
  test("refuses, even with --force, names the count and the partition, and moves nothing", () => {
    const { a, restorePrivate } = switchedWithoutPrivate();
    a.write(PRIVATE_PAGE, PRIVATE_SIGNAL);
    for (const force of [false, true]) {
      expect(removeLegacy(a.vault, { force })).toEqual({
        removed: false,
        reason: "held-back",
        pending: [],
        held_back: 1,
        missing: ["private"],
      });
      expect(existsSync(join(a.vault, ...PRIVATE_PAGE.split("/")))).toBe(true);
      expect(readRemovalMarker(a.store(), a.vault)).toBeNull();
      expect(a.records().some((r) => r.kind === "legacy-tree-removed")).toBe(false);
    }

    restorePrivate();
    const removed = removeLegacy(a.vault);
    if (!removed.removed) throw new Error(`not removed: ${removed.reason}`);
    expect(a.byKey().has(PRIVATE_PAGE)).toBe(true);
  });

  test("an item the archive import holds back puts the tree back into the vault", () => {
    const { a } = switchedWithoutPrivate();
    // A removal interrupted after it moved Brain/, and sync delivered a
    // private page into the tree just before that move.
    const archive = join(a.store().deviceStateDir, LEGACY_ARCHIVE_DIR, "2026-11-08T10-00-00-000Z");
    mkdirSync(archive, { recursive: true });
    renameSync(join(a.vault, "Brain"), join(archive, "Brain"));
    writeFileSync(join(archive, ...PRIVATE_PAGE.split("/")), PRIVATE_SIGNAL);
    writeFileSync(
      join(migrationDir(a.store()), "removal.json"),
      `${JSON.stringify({ vault: a.vault, at: "2026-11-08T10:00:00.000Z", archive })}\n`,
    );

    const result = removeLegacy(a.vault);
    expect(result).toEqual({
      removed: false,
      reason: "held-back",
      pending: [],
      held_back: 1,
      missing: ["private"],
    });
    expect(existsSync(join(a.vault, ...PRIVATE_PAGE.split("/")))).toBe(true);
    expect(existsSync(join(a.vault, ".open-second-brain"))).toBe(true);
    expect(readRemovalInProgress(a.store())).toBeNull();
    expect(readRemovalMarker(a.store(), a.vault)).toBeNull();
    expect(a.records().some((r) => r.kind === "legacy-tree-removed")).toBe(false);
  });
});

describe("a legacy writer still appending into the moved tree", () => {
  test("the removal puts the tree back and records nothing", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // A removal interrupted after it moved Brain/, with one late page in it.
    const archive = join(a.store().deviceStateDir, LEGACY_ARCHIVE_DIR, "2026-11-08T10-00-00-000Z");
    mkdirSync(archive, { recursive: true });
    renameSync(join(a.vault, "Brain"), join(archive, "Brain"));
    const page = (n: number): string => join(archive, "Brain", "inbox", `2026-11-08-late-${n}.md`);
    const signal = (n: number): string =>
      `---\nid: sig-late-${n}\ntopic: late-${n}\nprinciple: late ${n}\n---\nRaw.\n`;
    writeFileSync(page(0), signal(0));
    writeFileSync(
      join(migrationDir(a.store()), "removal.json"),
      `${JSON.stringify({ vault: a.vault, at: "2026-11-08T10:00:00.000Z", archive })}\n`,
    );
    // Every import of an archived item is followed by one more written
    // through a handle opened before the move: the import never settles.
    let written = 0;
    const archiveImportHooks = {
      afterItemAppended: (): void => {
        written += 1;
        writeFileSync(page(written), signal(written));
      },
    };

    expect(() =>
      removeLegacyTree(a.vault, a.store(), { agent: "t", force: true, archiveImportHooks }),
    ).toThrow(/kept changing .* put back/);
    expect(existsSync(join(a.vault, "Brain", "inbox", `2026-11-08-late-${written}.md`))).toBe(true);
    expect(readRemovalInProgress(a.store())).toBeNull();
    expect(readRemovalMarker(a.store(), a.vault)).toBeNull();
    expect(a.records().some((r) => r.kind === "legacy-tree-removed")).toBe(false);
  });
});

/** Wait, with a hard budget, until every path exists. */
async function waitForFiles(paths: ReadonlyArray<string>, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!paths.every((p) => existsSync(p))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${paths.join(", ")}`);
    await Bun.sleep(5);
  }
}

describe("two removals at once", () => {
  test("exactly one proceeds, and the marker names the archive that holds the tree", async () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const go = join(fleet.parent, "race-go");
    const outs = [join(fleet.parent, "race-1.json"), join(fleet.parent, "race-2.json")];
    const exits = outs.map((out) => {
      const child = spawn(process.execPath, [RACER, a.vault, go, out], {
        env: { ...process.env },
        stdio: "ignore",
      });
      return new Promise<number | null>((done) => child.on("exit", done));
    });
    await waitForFiles(
      outs.map((o) => `${o}.ready`),
      30_000,
    );
    writeFileSync(go, "go");
    expect(await Promise.all(exits)).toEqual([0, 0]);

    const results = outs.map((o) => JSON.parse(readFileSync(o, "utf8")) as Record<string, unknown>);
    const winners = results.filter((r) => r["removed"] === true);
    expect(winners).toHaveLength(1);
    // The loser was refused at the gate, or came after and found no tree.
    const loser = results.find((r) => r["removed"] !== true)!;
    if (loser["error"] !== undefined) expect(loser["error"]).toBe("MigrationGateBusyError");
    else expect(loser["removed"]).toBe(false);

    const archive = winners[0]!["archive"] as string;
    expect(readdirSync(archive).toSorted()).toEqual([".open-second-brain", "Brain"]);
    expect(existsSync(join(archive, "Brain", "inbox", "2026-11-01-tabs.md"))).toBe(true);
    expect(readRemovalMarker(a.store(), a.vault)?.archive).toBe(archive);
    expect(readRemovalInProgress(a.store())).toBeNull();
    expect(a.records().filter((r) => r.kind === "legacy-tree-removed")).toHaveLength(1);
    expect(existsSync(join(a.vault, "Brain"))).toBe(false);
  }, 60_000);
});

describe("two first machines", () => {
  test("two devices that both ran the first migration are named by doctor", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    // One vault with its identity marker on both devices (a vault without
    // one would get a marker from each run, and the two runs would name
    // two vaults). Both migrate before either completion record has synced.
    writeVaultIdentity(a.vault);
    fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
    a.use();
    expect(runMigration(a.vault, FAST).role).toBe("first");
    b.use();
    expect(runMigration(b.vault, FAST).role).toBe("first");
    fleet.syncStore("dev-b", "dev-a");
    a.use();
    const warning = runDoctor(a.vault).warnings.find((w) => w.code === MIGRATION_DONE_TWICE_CODE);
    expect(warning?.message).toContain("dev-a and dev-b");
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    expect(runDoctor(b.vault).warnings.map((w) => w.code)).toContain(MIGRATION_DONE_TWICE_CODE);
  });

  test("a first migration that was rolled back is no second first machine", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).role).toBe("first");
    rollback(a.vault);
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    expect(runDoctor(b.vault).warnings.map((w) => w.code)).not.toContain(MIGRATION_DONE_TWICE_CODE);
  });
});

describe("sameVaultPath", () => {
  test("folds case on Windows only", () => {
    expect(sameVaultPath("C:\\Vault", "c:\\vault", "win32")).toBe(true);
    expect(sameVaultPath("C:\\Vault", "C:\\Other", "win32")).toBe(false);
    expect(sameVaultPath("/home/u/Vault", "/home/u/vault", "linux")).toBe(false);
    expect(sameVaultPath("/home/u/vault/", "/home/u/vault", "linux")).toBe(true);
  });
});

/** Dev-a switched, every legacy cohort device retired: the removal may run. */
function switchedAlone(): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  retire(a, "dev-b");
  retire(a, "dev-c");
  // This machine reads its shards, as any reader would.
  expect(a.records().length).toBeGreaterThan(0);
  return a;
}

describe("a removal while a data shard of the store cannot be seen", () => {
  test("an imported record's shard gone since this machine read it refuses, even with --force", () => {
    const a = switchedAlone();
    const dir = join(a.storeRoot, "shared", "events", "dev-a");
    const [name] = readdirSync(dir);
    const shard = join(dir, name!);
    const bytes = readFileSync(shard);
    rmSync(shard);
    for (const force of [false, true]) {
      expect(() => removeLegacy(a.vault, { force })).toThrow(/shared\/events\/dev-a\//);
      expect(existsSync(join(a.vault, "Brain"))).toBe(true);
      expect(readRemovalMarker(a.store(), a.vault)).toBeNull();
    }
    writeFileSync(shard, bytes);
    expect(removeLegacy(a.vault)).toMatchObject({ removed: true, forced: false });
  });

  test("a corrupt line in the middle of an events shard refuses without --force", () => {
    const a = switchedAlone();
    const peer = openStore({ root: a.storeRoot, device: "dev-p" });
    let shard = "";
    for (const text of ["peer one", "peer two"]) {
      shard = appendRecord(peer, {
        partition: "shared",
        stream: "events",
        kind: "log-event",
        agent: "t",
        body: { timestamp: "2026-11-08T10:00:00Z", event_type: "note", body: { text } },
      }).path;
    }
    writeFileSync(shard, readFileSync(shard, "utf8").replace("peer one", "peer 0ne"));
    expect(() => removeLegacy(a.vault)).toThrow(/cannot be read in full/);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
    expect(removeLegacy(a.vault, { force: true })).toMatchObject({ removed: true, forced: true });
  });
});

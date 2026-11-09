/**
 * `--rollback` (task 2.6): migrate, write new records after the switch,
 * receive a remote record from before the switch late, roll back, and
 * find every one of them in the legacy tree exactly once and in fold
 * order; kinds with no legacy form stay in the store and are reported; a
 * resumed rollback duplicates nothing; the device is no longer switched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { compareRecords } from "../../../src/core/store/envelope.ts";
import { parseFrontmatterText } from "../../../src/core/vault.ts";
import { migrationAvailability } from "../../../src/core/store/migration-availability.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { readMigrationGate } from "../../../src/core/migration-gate.ts";
import {
  isDeviceSwitched,
  LEGACY_TREE_REMOVED_KIND,
  MIGRATION_STREAM,
} from "../../../src/core/store-migration/migration-records.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { readVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { readVaultBindings } from "../../../src/core/vault-adapter/vault-binding.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";

const FAST = { settleMs: 0 } as const;
const KILL_CHILD = join(import.meta.dir, "fixtures", "kill-child.ts");
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

function logEvent(store: StoreHandle, text: string, at: number): string {
  return appendRecord(
    store,
    {
      partition: "shared",
      stream: "log",
      kind: "log-event",
      agent: "t",
      body: { timestamp: new Date(at).toISOString(), event_type: "note", body: { text } },
    },
    { now: () => at },
  ).record.id;
}

/**
 * An instant after a switch `runMigration` has just stamped with the real
 * clock, and well inside the store's clock-drift bound, so the scenario
 * holds on any date the suite runs.
 */
function afterTheSwitch(): number {
  return Date.now() + 60_000;
}

/** Records written after the switch, the way the store-only writers write them. */
function writeAfterSwitch(a: Machine, at: number): void {
  const store = a.store();
  const now = { now: () => at };
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: {
        id: "sig-after",
        path: "Brain/inbox/2026-11-08-after.md",
        staged: false,
        frontmatter: { id: "sig-after", topic: "after", principle: "Written after the switch" },
        raw: "After.",
      },
    },
    now,
  );
  logEvent(store, "note after the switch", at + 1);
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "events",
      kind: "preference-set",
      agent: "t",
      body: {
        authority: "human",
        preference: "pref-open",
        fields: { principle: "Open rule, edited" },
      },
    },
    now,
  );
  appendRecord(
    store,
    {
      partition: "private",
      stream: "events",
      kind: "pinned-set",
      agent: "t",
      body: { authority: "agent", content: "Pinned after the switch." },
    },
    now,
  );
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "events",
      kind: "lane-entry",
      agent: "t",
      body: {
        authority: "agent",
        lane: "obligations",
        entry: "obl-new",
        fields: { title: "New obligation" },
        text: "Owed after the switch.",
      },
    },
    now,
  );
  appendRecord(
    store,
    {
      partition: "shared",
      stream: "topics",
      kind: "topic-create",
      agent: "t",
      body: { authority: "agent", title: "A topic" },
    },
    now,
  );
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Every legacy log shard of dev-a, whatever day the test runs on. */
function logText(vault: string): string {
  const dir = join(vault, "Brain", "log");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((name) => name.endsWith(".dev-a.jsonl"))
    .toSorted()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("");
}

describe("rollback", () => {
  test("a signal forgotten after the switch does not come back with the legacy tree", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const page = join(a.vault, "Brain", "inbox", "2026-11-01-tabs.md");
    expect(existsSync(page)).toBe(true);
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const capture = a
      .records()
      .find((r) => r.kind === "signal" && r.body["path"] === "Brain/inbox/2026-11-01-tabs.md")!;
    appendRecord(
      a.store(),
      {
        partition: "shared",
        stream: "events",
        kind: "signal-removed",
        agent: "t",
        body: { authority: "human", signal: String(capture.body["id"]) },
      },
      { now: () => afterTheSwitch() },
    );
    rollback(a.vault);
    expect(existsSync(page)).toBe(false);
    // Only that signal: the other signal pages are back.
    for (const rel of ["inbox/processed/2026-10-01-old.md", "pending/2026-11-02-staged.md"]) {
      expect(existsSync(join(a.vault, "Brain", ...rel.split("/")))).toBe(true);
    }
  });

  test("a preference's prose survives migrate then rollback byte for byte in its body", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const path = join(a.vault, "Brain", "preferences", "pref-open.md");
    const [, bodyBefore] = parseFrontmatterText(readFileSync(path, "utf8"));
    expect(bodyBefore.trim()).not.toBe("");
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    writeAfterSwitch(a, afterTheSwitch());
    // The page is gone from the vault (as after a removal), so the body
    // can only come back from the store's `text` field.
    rmSync(path);
    rollback(a.vault);
    const [meta, bodyAfter] = parseFrontmatterText(readFileSync(path, "utf8"));
    expect(bodyAfter).toBe(bodyBefore);
    expect(meta["text"]).toBeUndefined();
    expect(meta["principle"]).toBe("Open rule, edited");
  });

  test("puts post-switch and late remote records back once, in fold order", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    // B, still on the old release, wrote a record before A switched (the
    // switch is stamped with the real clock, so "before" is the real past)...
    b.use();
    logEvent(b.store(), "remote note before the switch", Date.now() - 3_600_000);

    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    writeAfterSwitch(a, afterTheSwitch());
    // ...and its shard reaches A only now.
    fleet.syncStore("dev-b", "dev-a");

    expect(readVaultBindings().map((v) => v.device)).toEqual(["dev-a"]);
    const result = rollback(a.vault);
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(false);
    // The vault is a legacy vault again: no store binding is left for it.
    expect(readVaultBindings()).toEqual([]);
    expect(result.unswitched).not.toBe("");

    const byId = new Map(a.records().map((r) => [r.id, r]));
    const replayed = result.replayed.map((id) => byId.get(id)!);
    // The migration's own snapshot event was logged after the snapshot it
    // records, so it is absent from the restored tree and written back too.
    const ours = replayed.filter((r) => r.body["event_type"] !== "snapshot");
    expect(replayed.length - ours.length).toBe(1);
    expect(ours.map((r) => r.kind)).toEqual([
      "log-event",
      "signal",
      "log-event",
      "preference-set",
      "pinned-set",
      "lane-entry",
    ]);
    expect([...replayed].toSorted(compareRecords).map((r) => r.id)).toEqual([...result.replayed]);

    expect(readFileSync(join(a.vault, "Brain", "inbox", "2026-11-08-after.md"), "utf8")).toContain(
      "Written after the switch",
    );
    const log = logText(a.vault);
    expect(count(log, "note after the switch")).toBe(1);
    expect(count(log, "remote note before the switch")).toBe(1);
    expect(readFileSync(join(a.vault, "Brain", "preferences", "pref-open.md"), "utf8")).toContain(
      "Open rule, edited",
    );
    expect(readFileSync(join(a.vault, "Brain", "pinned.md"), "utf8")).toBe(
      "Pinned after the switch.\n",
    );
    expect(readFileSync(join(a.vault, "Brain", "obligations", "obl-new.md"), "utf8")).toContain(
      "Owed after the switch.",
    );
    // The secrets backup is back where it was.
    expect(existsSync(join(a.vault, ".open-second-brain", "secrets", "keyfile"))).toBe(true);
    // Kinds with no legacy form stay in the store and are named.
    expect(result.no_legacy_form["topic-create"]).toBe(1);
    // The machine is on the legacy layout again: the migration is offered.
    expect(migrationAvailability({ vault: a.vault }).available).toBe(true);
  });

  test("a rollback killed half way keeps the gate and a resumed rollback duplicates nothing", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    writeAfterSwitch(a, afterTheSwitch());

    // A real kill after the second replayed record: no `finally` releases
    // the gate and the rollback journal keeps what was replayed.
    const child = Bun.spawnSync([process.execPath, "run", KILL_CHILD, "rollback", a.vault, "2"], {
      env: { ...process.env },
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(child.success).toBe(false);
    expect(child.exitCode).not.toBe(3);
    if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
    a.use();
    expect(readMigrationGate()?.run_id).toMatch(/^rollback-/);
    // Half way: still switched, the restored tree is not finished yet.
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(true);

    // The two records replayed before the kill are journaled; the resumed
    // run replays exactly the rest, none of those two again.
    const journal = join(migrationDir(a.store()), "rollback-journal.jsonl");
    // A log row journals a start line before its write; the ids alone are
    // the records written.
    const beforeKill = readFileSync(journal, "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("start "));
    expect(beforeKill).toHaveLength(2);
    const resumed = rollback(a.vault);
    expect(resumed.replayed.length).toBeGreaterThan(0);
    expect(resumed.replayed.filter((id) => beforeKill.includes(id))).toEqual([]);
    expect(count(logText(a.vault), "note after the switch")).toBe(1);
    expect(
      count(
        readFileSync(join(a.vault, "Brain", "inbox", "2026-11-08-after.md"), "utf8"),
        "id: sig-after",
      ),
    ).toBe(1);
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(false);
    expect(readMigrationGate()).toBeNull();
  });

  test("a migration after a rollback is first again and records its own cut", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const before = runMigration(a.vault, FAST);
    expect(before.role).toBe("first");
    rollback(a.vault);
    const again = runMigration(a.vault, FAST);
    expect(again.role).toBe("first");
    expect(again.migration_done).not.toBeNull();
    expect(again.migration_done).not.toBe(before.migration_done);
  });

  test("a finished rollback run again is refused and loses no later legacy write", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    rollback(a.vault);
    // Back on the legacy layout, the machine writes the legacy tree.
    const later = join(a.vault, "Brain", "log", "2026-11-09.dev-a.jsonl");
    const before = existsSync(later) ? readFileSync(later, "utf8") : "";
    appendFileSync(later, "{}\n");
    expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);
    expect(readFileSync(later, "utf8")).toBe(`${before}{}\n`);
  });

  test("a removal another device recorded refuses the rollback before sync deletes the tree", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    appendRecord(a.store(), {
      partition: "shared",
      stream: MIGRATION_STREAM,
      kind: LEGACY_TREE_REMOVED_KIND,
      agent: "t",
      body: {
        authority: "human",
        vault_id: readVaultIdentity(a.vault)?.vault_id ?? null,
        device: "dev-b",
      },
    });
    expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(true);
  });

  test("a signal consumed after the switch comes back consumed, not in the inbox", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const inbox = join(a.vault, "Brain", "inbox", "2026-11-01-tabs.md");
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const capture = a
      .records()
      .find((r) => r.kind === "signal" && r.body["path"] === "Brain/inbox/2026-11-01-tabs.md")!;
    appendRecord(
      a.store(),
      {
        partition: "shared",
        stream: "events",
        kind: "signal-state",
        agent: "t",
        body: {
          authority: "agent",
          signal: String(capture.body["id"]),
          state: "consumed",
          fields: { consumed_by: "dream" },
        },
      },
      { now: () => afterTheSwitch() },
    );
    const result = rollback(a.vault);
    expect(existsSync(inbox)).toBe(false);
    const processed = join(a.vault, "Brain", "inbox", "processed", "2026-11-01-tabs.md");
    expect(parseFrontmatterText(readFileSync(processed, "utf8"))[0]["consumed_by"]).toBe("dream");
    expect(result.no_legacy_form["signal-state"]).toBeUndefined();
  });

  test("ledger rows written after the switch are counted, by ledger, as kept in the store", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    for (const n of [1, 2]) {
      appendRecord(a.store(), {
        partition: "shared",
        stream: "ledgers",
        ledger: "idempotency",
        kind: "ledger-row",
        agent: "t",
        body: { row: { key: `k${n}` } },
      });
    }
    const result = rollback(a.vault);
    expect(result.ledger_rows_kept).toEqual({ idempotency: 2 });
  });
});

/** Every file below `dir` with its content, relative and POSIX-separated. */
function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isFile()) out[name.split(sep).join("/")] = readFileSync(path, "utf8");
  }
  return out;
}

describe("a rollback while a store shard cannot be seen", () => {
  /**
   * Dev-a switched; a peer's events shard holds two records written after
   * the switch, and this machine has read it. Returns the shard.
   */
  function peerShard(a: Machine): string {
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const peer = openStore({ root: a.storeRoot, device: "dev-b" });
    const at = afterTheSwitch();
    let path = "";
    for (const [n, text] of [
      [0, "peer note one"],
      [1, "peer note two"],
    ] as const) {
      path = appendRecord(
        peer,
        {
          partition: "shared",
          stream: "events",
          kind: "log-event",
          agent: "t",
          body: { timestamp: new Date(at + n).toISOString(), event_type: "note", body: { text } },
        },
        { now: () => at + n },
      ).path;
    }
    // This machine reads the shard, as any reader would.
    expect(a.records().some((r) => r.body["body"] !== undefined)).toBe(true);
    return path;
  }

  const cases: ReadonlyArray<{
    name: string;
    skip: boolean;
    hide: (shard: string) => () => void;
  }> = [
    {
      name: "unreadable",
      skip: CHMOD_CANNOT_DENY,
      hide: (shard) => {
        chmodSync(shard, 0o000);
        return () => chmodSync(shard, 0o600);
      },
    },
    {
      name: "gone since this machine read it",
      skip: false,
      hide: (shard) => {
        const bytes = readFileSync(shard);
        rmSync(shard);
        return () => writeFileSync(shard, bytes);
      },
    },
    {
      name: "read only in part (a corrupt middle line)",
      skip: false,
      hide: (shard) => {
        const text = readFileSync(shard, "utf8");
        writeFileSync(shard, text.replace("peer note one", "peer note 0ne"));
        return () => writeFileSync(shard, text);
      },
    },
  ];

  for (const { name, skip, hide } of cases) {
    test.skipIf(skip)(`${name}: refused, nothing touched, the switch kept`, () => {
      fleet = makeFleet(["dev-a"]);
      const a = fleet.machine("dev-a");
      a.use();
      const shard = peerShard(a);
      const brain = join(a.vault, "Brain");
      const before = treeOf(brain);
      const restore = hide(shard);
      try {
        expect(() => rollback(a.vault)).toThrow(RollbackRefusedError);
        expect(() => rollback(a.vault)).toThrow(/shared\/events\/dev-b\//);
        expect(treeOf(brain)).toEqual(before);
        expect(isDeviceSwitched(a.store(), "dev-a")).toBe(true);
        expect(readVaultBindings().map((v) => v.device)).toEqual(["dev-a"]);
      } finally {
        restore();
      }
      // Once the shard reads again, the rollback writes both records back.
      rollback(a.vault);
      const log = logText(a.vault);
      expect(count(log, "peer note one")).toBe(1);
      expect(count(log, "peer note two")).toBe(1);
      expect(isDeviceSwitched(a.store(), "dev-a")).toBe(false);
    });
  }
});

/**
 * `o2b search check --integrity` (what-the-index-already-knew, unit K,
 * reader-side half).
 *
 * The write-open integrity gate closes the corruption hole for anyone who
 * runs an index command. It closes nothing for a PURE reader: no write
 * open ever happens, no `PRAGMA quick_check` ever runs, and the fault key
 * the read open refuses on is therefore never written. Since the index
 * file lives inside the vault and vaults are replicated between machines,
 * that reader is a real person with a real rotting index.
 *
 * This flag is the operator-run scan that closes it. It is opt-in because
 * the scan is linear in the size of the index (~22 ms per megabyte, so
 * half a minute on a large one) and `search check` is advertised as a
 * cheap pre-flight in onboarding, in the semantic-search hint and in two
 * registered diagnostic exits.
 *
 * Three states must stay distinguishable, and the file asserts each:
 * NEVER CHECKED (no completed scan has ever run here), CLEAN (the last
 * completed scan passed) and FAULTY. The absence of a fault is not a
 * pass, and this verb must never report it as one.
 *
 * Nothing here reaches the network: the config switches semantic search
 * off, so no provider is constructed and no ping is sent.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { Store } from "../../src/core/search/store.ts";
import {
  INTEGRITY_CHECKED_AT_STATE_KEY,
  INTEGRITY_FAULT_STATE_KEY,
} from "../../src/core/search/store/state.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

/** The registered exit a structural fault names. */
const INDEX_CORRUPT_CODE = "search-index-corrupt";

let vault: string;
let dbPath: string;
let configPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("search-check-integrity");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  configPath = join(vault, "cli-config.yaml");
});

afterEach(() => {
  cleanup();
});

/** A config that keeps `indexCheck` entirely offline. */
async function writeConfig(): Promise<void> {
  await Bun.write(
    configPath,
    [`vault: "${vault}"`, "search_semantic_enabled: false", ""].join("\n"),
  );
}

/** A vault whose index has data pages past its middle. */
function seedVault(notes: number): void {
  for (let i = 0; i < notes; i++) {
    const body = `The quick brown fox jumps over the lazy dog number ${i}. `.repeat(40);
    writeMd(vault, `Notes/note-${i}.md`, `# Note ${i}\n\n${body}`);
  }
}

/**
 * Overwrite whole pages in the middle of the index file with garbage. The
 * header, the schema and the small metadata tables live on the first pages
 * and stay intact, so the file remains fully parseable - which is exactly
 * the state the store used to keep answering questions from.
 */
function corruptMiddlePages(path: string, pages: number): void {
  const size = statSync(path).size;
  const pageSize = readPageSize(path);
  corruptPagesAt(path, Math.floor(size / 2 / pageSize) * pageSize, pages);
}

/**
 * Overwrite the b-tree root page of one named table, located through
 * `sqlite_master` rather than guessed at. Page 1 carries the file header
 * and the schema, so the file still opens and still lists its tables -
 * only reads of THAT table raise. Deterministic, unlike relying on where
 * the middle of a particular fixture happens to fall.
 */
function corruptTableRoot(path: string, table: string): void {
  const db = new Database(path);
  let rootPage: number;
  try {
    rootPage =
      db
        .query<{ rootpage: number }, [string]>("SELECT rootpage FROM sqlite_master WHERE name = ?")
        .get(table)?.rootpage ?? 0;
  } finally {
    db.close();
  }
  expect(`${table} has a root page: ${rootPage > 1}`).toBe(`${table} has a root page: true`);
  const pageSize = readPageSize(path);
  corruptPagesAt(path, (rootPage - 1) * pageSize, 1);
}

function readPageSize(path: string): number {
  const db = new Database(path);
  try {
    return (db.query<{ page_size: number }, []>("PRAGMA page_size").get() as { page_size: number })
      .page_size;
  } finally {
    db.close();
  }
}

function corruptPagesAt(path: string, offset: number, pages: number): void {
  const pageSize = readPageSize(path);
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(pageSize * pages, 0xa5), 0, pageSize * pages, offset);
  } finally {
    closeSync(fd);
  }
}

/** Forget that any full scan ever ran here, without touching the fault key. */
function forgetCheckStamp(path: string): void {
  const db = new Database(path);
  db.run("DELETE FROM index_state WHERE key = ?", [INTEGRITY_CHECKED_AT_STATE_KEY]);
  db.close();
}

/** One `index_state` cell, read without opening a `Store`. */
function readState(path: string, key: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?").get(key)
        ?.value ?? null
    );
  } finally {
    db.close();
  }
}

/** Run the verb, returning the parsed `--json` payload. */
async function checkJson(...extra: ReadonlyArray<string>): Promise<Record<string, unknown>> {
  const r = await runCli(
    [
      "search",
      "check",
      "--vault",
      vault,
      "--db",
      dbPath,
      "--config",
      configPath,
      "--json",
      ...extra,
    ],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  return { ...(JSON.parse(r.stdout) as Record<string, unknown>), _returncode: r.returncode };
}

/** The `integrity` sub-object of a `--integrity` payload. */
function integrityOf(payload: Record<string, unknown>): Record<string, unknown> {
  const block = payload["integrity"];
  expect(typeof block).toBe("object");
  return block as Record<string, unknown>;
}

test("a store that has never been checked reads as never checked, not as healthy", async () => {
  await writeConfig();
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));
  // The index run itself scanned a fresh, healthy file. Forget that, so
  // this is the pure reader's store: present, fine, never verified.
  forgetCheckStamp(dbPath);
  expect(readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY)).toBeNull();

  const payload = await checkJson("--integrity");
  const integrity = integrityOf(payload);

  expect(integrity["scanned"]).toBe(true);
  // What the store knew BEFORE this run: nothing.
  expect(integrity["previously_checked_at"]).toBeNull();
  expect(integrity["verdict"]).toBe("ok");
  expect(payload["_returncode"]).toBe(0);

  // ...and now it knows, which is the whole point: the reader's store has
  // a completed scan recorded against it for the first time.
  expect(readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY)).toBe(integrity["checked_at"] as string);
});

test("a clean store reports a pass, the time it spent, and records the completed scan", async () => {
  await writeConfig();
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));
  const before = readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY);
  expect(before).toBeTruthy();

  const payload = await checkJson("--integrity");
  const integrity = integrityOf(payload);

  expect(integrity["scanned"]).toBe(true);
  expect(integrity["verdict"]).toBe("ok");
  expect(integrity["previously_checked_at"]).toBe(before);
  expect(integrity["fault"]).toBeUndefined();
  expect(integrity["next_command"]).toBeUndefined();
  expect(typeof integrity["elapsed_ms"]).toBe("number");
  expect(payload["_returncode"]).toBe(0);

  // The interval gate is bypassed on demand: a scan that ran inside the
  // 24-hour window still ran, and still re-stamped.
  expect(readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY)).not.toBe(before);
  expect(readState(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeNull();
});

test("a corrupt-but-parseable store is condemned and names its registered exit", async () => {
  await writeConfig();
  seedVault(60);
  await indexVault(makeConfig({ vault, dbPath }));
  corruptMiddlePages(dbPath, 4);

  // The fixture's point: nothing about this file LOOKS wrong, and the
  // interval gate would skip the scan for another day.
  const probe = new Database(dbPath);
  expect(
    probe.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get()?.n,
  ).toBeGreaterThan(0);
  probe.close();

  const payload = await checkJson("--integrity");
  const integrity = integrityOf(payload);

  expect(integrity["scanned"]).toBe(true);
  expect(integrity["verdict"]).toBe("faulty");
  expect(typeof integrity["fault"]).toBe("string");
  expect((integrity["fault"] as string).length).toBeGreaterThan(0);
  expect(integrity["next_command"]).toBe(DIAGNOSTIC_SIGNALS.get(INDEX_CORRUPT_CODE)!.nextCommand);
  expect(payload["_returncode"]).toBe(1);

  // The verdict lands in the SAME cell the write-open gate writes, so the
  // read path now refuses instead of answering from a malformed file -
  // which is the protection a pure reader never used to get.
  expect(readState(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeTruthy();
  await expect(Store.open(makeConfig({ vault, dbPath }), { mode: "read" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
});

test("a store this verb condemned is refused by a WRITE open, not only by a read", async () => {
  await writeConfig();
  seedVault(60);
  await indexVault(makeConfig({ vault, dbPath }));
  corruptMiddlePages(dbPath, 4);

  const integrity = integrityOf(await checkJson("--integrity"));
  expect(integrity["verdict"]).toBe("faulty");
  expect(readState(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeTruthy();

  // A completed scan stamps `integrity_checked_at` whether it passed or
  // failed, so the write path's 24-hour interval now covers the whole next
  // day. The recorded fault must be honoured regardless of that interval:
  // running this diagnostic on a damaged index must not open a window in
  // which the indexer writes into the file the verb just condemned.
  expect(readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY)).toBe(integrity["checked_at"] as string);
  await expect(Store.open(makeConfig({ vault, dbPath }), { mode: "write" })).rejects.toMatchObject({
    code: "INDEX_UNREADABLE",
  });
});

test("the registered exit exists and names a rebuild, not an incremental update", () => {
  const signal = DIAGNOSTIC_SIGNALS.get(INDEX_CORRUPT_CODE);
  expect(signal).toBeDefined();
  // `o2b search index` is incremental and would leave the damaged pages
  // exactly where they are; only a rebuild replaces the file.
  expect(signal!.nextCommand).toBe("o2b search reindex");
  expect(signal!.autoRepairable).toBe(false);
});

test("the human surface names the scan, its cost and its verdict", async () => {
  await writeConfig();
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));

  const r = await runCli(
    ["search", "check", "--vault", vault, "--db", dbPath, "--config", configPath, "--integrity"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(r.returncode).toBe(0);
  expect(r.stdout).toContain("integrity:");
  expect(r.stdout).toContain("ok");
  // The operator is told what the command is about to spend BEFORE it
  // spends it, on stderr so the machine stream stays a payload.
  expect(r.stderr).toContain("integrity scan");
});

test("without --integrity the verb spends nothing and emits the bytes it always did", async () => {
  await writeConfig();
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));
  forgetCheckStamp(dbPath);

  const plainBefore = await runCli(
    ["search", "check", "--vault", vault, "--db", dbPath, "--config", configPath, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(plainBefore.returncode).toBe(0);
  const payload = JSON.parse(plainBefore.stdout) as Record<string, unknown>;
  // Byte-identity when absent, asserted as the exact key sequence the
  // report carried before this flag existed - NOT a sorted set. Sorting
  // the keys discards the one property the bytes actually have: a
  // reordered emission would serialize different bytes and a set
  // comparison would call it identical.
  expect(Object.keys(payload)).toEqual([
    "vault_readable",
    "index_dir_writable",
    "sqlite_ok",
    "fts5_ok",
    "vec_extension",
    "embedding_key_resolved",
    "provider_reachable",
    "provider_reason",
    "warnings",
    "fatal",
    "recommendations",
  ]);
  // The flag-less run touched no `index_state` cell: a store nobody
  // checked stays a store nobody checked.
  expect(readState(dbPath, INTEGRITY_CHECKED_AT_STATE_KEY)).toBeNull();

  // ...and a scan in between does not leak into the flag-less bytes.
  await checkJson("--integrity");
  const plainAfter = await runCli(
    ["search", "check", "--vault", vault, "--db", dbPath, "--config", configPath, "--json"],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
  expect(plainAfter.stdout).toBe(plainBefore.stdout);
});

test("a passing scan clears a stale fault the operator has already repaired", async () => {
  await writeConfig();
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));

  const stamper = new Database(dbPath);
  stamper.run("INSERT INTO index_state(key, value, updated_at) VALUES (?,?,?)", [
    INTEGRITY_FAULT_STATE_KEY,
    "stale fault from a previous generation",
    new Date().toISOString(),
  ]);
  stamper.close();

  const integrity = integrityOf(await checkJson("--integrity"));
  expect(integrity["verdict"]).toBe("ok");
  expect(readState(dbPath, INTEGRITY_FAULT_STATE_KEY)).toBeNull();
});

test("a store with no index file reports that the scan could not run", async () => {
  await writeConfig();
  writeMd(vault, "Notes/foo.md", "# Foo\n\nfox");

  const payload = await checkJson("--integrity");
  const integrity = integrityOf(payload);

  // Not a pass and not a fault: the check did not run, and says so.
  expect(integrity["scanned"]).toBe(false);
  expect(integrity["verdict"]).toBe("not-run");
  expect(integrity["next_command"]).toBe(
    DIAGNOSTIC_SIGNALS.get("search-index-missing")!.nextCommand,
  );
});

test("a well-formed sqlite file that is not a search index is never reported as healthy", async () => {
  await writeConfig();
  // `PRAGMA quick_check` passes this file happily: it is a perfectly
  // valid database. It is just not this tool's index, and a pass over it
  // would be the misleading verdict the whole unit exists to prevent.
  mkdirSync(dirname(dbPath), { recursive: true });
  const foreign = new Database(dbPath);
  foreign.exec("CREATE TABLE unrelated(id INTEGER PRIMARY KEY, note TEXT)");
  foreign.run("INSERT INTO unrelated(note) VALUES ('not an index')");
  foreign.close();

  const integrity = integrityOf(await checkJson("--integrity"));
  expect(integrity["scanned"]).toBe(false);
  expect(integrity["verdict"]).toBe("not-run");
  expect(integrity["next_command"]).toBe(DIAGNOSTIC_SIGNALS.get(INDEX_CORRUPT_CODE)!.nextCommand);
});

test("damage that reaches the metadata is still reported as a fault, not as an unknown", async () => {
  await writeConfig();
  // The damaged pages take `index_state` with them, so the verb cannot
  // read what this file said about its own last check. The scan still
  // completed and still condemned the file, and THAT is the finding -
  // "we could not tell" would send the operator nowhere.
  seedVault(4);
  await indexVault(makeConfig({ vault, dbPath }));
  corruptTableRoot(dbPath, "index_state");

  const integrity = integrityOf(await checkJson("--integrity"));
  expect(integrity["verdict"]).toBe("faulty");
  expect(integrity["next_command"]).toBe(DIAGNOSTIC_SIGNALS.get(INDEX_CORRUPT_CODE)!.nextCommand);
  // "Never checked" is not claimed over a cell that could not be read.
  expect(integrity["previously_checked_at"]).toBeUndefined();
  expect(typeof integrity["previous_check_unreadable"]).toBe("string");
});

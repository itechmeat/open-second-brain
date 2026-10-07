/**
 * A run that adds, updates and deletes no document skips the link and
 * alias resolution passes: they are a pure function of the documents and
 * their links, which did not change, and rewriting every link row on every
 * run is what made frequent background runs write to disk for nothing.
 * The relation-constraint pass still runs (it reads, and writes only
 * changed flags), so a schema-pack edit alone still takes effect.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  LAST_INDEXED_AT_STATE_KEY,
  LINK_RESOLUTION_PENDING_STATE_KEY,
} from "../../../src/core/search/store/state.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("indexer-noop"));
  // `[[grey-heron]]` resolves only through the frontmatter alias, in the
  // alias pass that resets and re-sets it each run - the link a skip must
  // not lose. `[[notes/pond.md]]` resolves by exact path.
  writeMd(vault, "notes/birds/heron.md", "---\naliases: [grey-heron]\n---\n# Heron\n\nA wader.\n");
  writeMd(
    vault,
    "notes/river.md",
    "# River\n\nHome of the [[grey-heron]] and [[notes/pond.md]].\n",
  );
  writeMd(vault, "notes/pond.md", "# Pond\n\nStill water.\n");
});

afterEach(() => cleanup());

function linkTargets(): Array<{ target_path: string; resolved: number }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ target_path: string; resolved: number }, []>(
        "SELECT target_path, target_document_id IS NOT NULL AS resolved FROM links " +
          "WHERE target_path IS NOT NULL ORDER BY target_path",
      )
      .all();
  } finally {
    db.close();
  }
}

function lastIndexedAt(): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?")
        .get(LAST_INDEXED_AT_STATE_KEY)?.value ?? null
    );
  } finally {
    db.close();
  }
}

test("a run with no document change skips link resolution and keeps every link resolved", async () => {
  const config = makeConfig({ vault, dbPath });
  const first = await indexVault(config);
  expect(first.linkResolutionSkipped).toBe(false);
  const before = linkTargets();
  expect(before.every((l) => l.resolved === 1)).toBe(true);
  const stampBefore = lastIndexedAt();

  await Bun.sleep(5);
  const second = await indexVault(config);
  expect(second.linkResolutionSkipped).toBe(true);
  expect(linkTargets()).toEqual(before);
  expect(lastIndexedAt()).not.toBe(stampBefore);
});

test("a changed note runs link resolution again and resolves a new link", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  writeMd(vault, "notes/lake.md", "# Lake\n\nWhere the [[grey-heron]] winters.\n");
  const stats = await indexVault(config);
  expect(stats.linkResolutionSkipped).toBe(false);
  expect(
    linkTargets()
      .filter((l) => l.target_path === "grey-heron")
      .every((l) => l.resolved === 1),
  ).toBe(true);
});

test("a deleted target is noticed: its links become unresolved", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  const { rmSync } = await import("node:fs");
  rmSync(`${vault}/notes/pond.md`);
  const stats = await indexVault(config);
  expect(stats.linkResolutionSkipped).toBe(false);
  expect(linkTargets().find((l) => l.target_path === "notes/pond.md")?.resolved).toBe(0);
});

test("a forced run never skips", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  expect((await indexVault(config, { force: true })).linkResolutionSkipped).toBe(false);
});

test("a run killed after writing documents but before resolving links is finished by the next run", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  // What a run killed mid-way leaves: documents committed, the alias
  // link not resolved yet, and the pending marker it set before writing.
  const db = new Database(dbPath);
  db.run("UPDATE links SET target_document_id = NULL WHERE target_path = 'grey-heron'");
  db.query("INSERT OR REPLACE INTO index_state(key, value, updated_at) VALUES (?, '1', ?)").run(
    LINK_RESOLUTION_PENDING_STATE_KEY,
    new Date().toISOString(),
  );
  db.close();

  const stats = await indexVault(config);
  expect(stats.linkResolutionSkipped).toBe(false);
  expect(linkTargets().find((l) => l.target_path === "grey-heron")?.resolved).toBe(1);
  // Resolved now, so the run after that may skip again.
  expect((await indexVault(config)).linkResolutionSkipped).toBe(true);
});

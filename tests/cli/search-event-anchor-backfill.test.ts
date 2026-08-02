/**
 * `o2b search event-anchor-backfill` (provenance at the boundary).
 *
 * The event-anchor phase run on its own. A schema bump migrates the
 * index in place and reindexes nothing, and the indexer resolves an
 * anchor only below its two content-identity fastpaths, so a document
 * carried over from a pre-anchor binary never gets one - and the column
 * now gates a hard `since` / `until` filter. This verb is the
 * operator-facing way to close that, and the index run is the surface
 * that tells an operator it is open.
 *
 * It follows the `vector-backfill` contract exactly: a `plan*` function
 * in core does the finding, dry-run is the DEFAULT, `--apply` is the
 * only mutating path, both report shapes exist, and the registered log
 * event's append failure surfaces on stderr instead of being swallowed.
 *
 * Nothing here reaches the network or an embedding provider: the anchor
 * is a pure function of a note's own frontmatter and body.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { DIAGNOSTIC_SIGNALS } from "../../src/core/brain/diagnostics.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

/** Root ignores the directory mode bits the unwritable-log test drives. */
const RUNNING_AS_ROOT = process.getuid?.() === 0;

/** The registered exit for an index holding unexamined documents. */
const PENDING_CODE = "event-anchors-pending";

/** The columns v11 adds; dropping them puts an index back at v10. */
const ANCHOR_COLUMNS = [
  "event_anchor_start_ms",
  "event_anchor_end_ms",
  "event_anchor_source",
  "event_anchor_examined",
];

let vault: string;
let dbPath: string;
let cleanup: () => void;
let configPath: string;

beforeEach(() => {
  const v = createTempVault("cli-event-anchor-backfill");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  configPath = join(vault, "cli-config.yaml");
});

afterEach(() => {
  cleanup();
});

/**
 * Build a real index, then put it back in the state the previous binary
 * left it and let the next run migrate it forward - the operator's
 * upgrade, performed for real rather than mocked.
 */
async function indexThenDowngrade(): Promise<void> {
  writeMd(vault, "notes/dated.md", "# Ledger\n\nThe reconciliation entry 2024-03-01 closed it.\n");
  writeMd(vault, "notes/plain.md", "# Ledger\n\nThe reconciliation entry ref-xy-1234 closed it.\n");
  const pinned = new Date("2026-07-01T00:00:00Z");
  for (const rel of ["notes/dated.md", "notes/plain.md"]) {
    utimesSync(join(vault, rel), pinned, pinned);
  }
  await Bun.write(configPath, [`vault: "${vault}"`, ""].join("\n"));
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });
  const db = new Database(dbPath);
  for (const col of ANCHOR_COLUMNS) db.run(`ALTER TABLE documents DROP COLUMN ${col}`);
  db.run("UPDATE index_state SET value = '10' WHERE key = 'schema_version'");
  db.close();
  // The write open migrates in place; every file takes the unchanged
  // fastpath, so no anchor is computed for any of them.
  await indexVault(config, { embeddings: false });
}

function cli(...args: string[]): Promise<Awaited<ReturnType<typeof runCli>>> {
  return runCli(["search", ...args, "--vault", vault, "--db", dbPath, "--config", configPath], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });
}

test("the pending state resolves a registered exit rather than a sentence", () => {
  const signal = DIAGNOSTIC_SIGNALS.get(PENDING_CODE);
  expect(signal).toBeDefined();
  expect(signal!.nextCommand).toBe("o2b search event-anchor-backfill --apply");
});

test("the dry run reports the gap on both streams and writes nothing", async () => {
  await indexThenDowngrade();

  const json = await cli("event-anchor-backfill", "--json");
  expect(json.returncode).toBe(0);
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expect(payload["dry_run"]).toBe(true);
  expect(payload["pending"]).toBe(2);
  expect(payload["examined"]).toBe(0);
  expect(payload["documents_total"]).toBe(2);
  // The registered exit travels on the machine stream as a field.
  expect(payload["next_command"]).toBe("o2b search event-anchor-backfill --apply");

  const human = await cli("event-anchor-backfill");
  expect(human.returncode).toBe(0);
  expect(human.stdout).toContain("dry-run");
  expect(human.stdout).toContain("next: o2b search event-anchor-backfill --apply");

  // Still pending: a dry run is a pure read.
  const again = await cli("event-anchor-backfill", "--json");
  expect(JSON.parse(again.stdout)["pending"]).toBe(2);
});

test("an index run over an upgraded vault names the backfill, not the query verb", async () => {
  await indexThenDowngrade();

  const human = await cli("index");
  expect(human.returncode).toBe(0);
  // The run genuinely covered every document - and would have claimed
  // the index was ready to query, sending the operator at the very
  // query the missing anchors answer wrongly.
  expect(human.stdout).toContain("2 document(s) indexed before anchors existed");
  expect(human.stdout).toContain("next: o2b search event-anchor-backfill --apply");
  expect(human.stdout).not.toContain("next: o2b search query");

  const json = await cli("index", "--json");
  const payload = JSON.parse(json.stdout) as Record<string, unknown>;
  expect((payload["stats"] as Record<string, unknown>)["event_anchors_pending"]).toBe(2);
  expect(payload["next_command"]).toBe("o2b search event-anchor-backfill --apply");
});

test("a vault with nothing pending is byte-identical to before the field existed", async () => {
  writeMd(vault, "notes/plain.md", "# Ledger\n\nThe reconciliation entry ref-xy-1234 closed it.\n");
  await Bun.write(configPath, [`vault: "${vault}"`, ""].join("\n"));

  const json = await cli("index", "--json");
  const stats = JSON.parse(json.stdout)["stats"] as Record<string, unknown>;
  expect(stats).not.toHaveProperty("event_anchors_pending");
  expect(JSON.parse(json.stdout)["next_command"]).toBe("o2b search query <text>");

  const human = await cli("index");
  expect(human.stdout).not.toContain("event anchors:");
});

test("--apply examines the pending documents and records a registered log event", async () => {
  await indexThenDowngrade();
  bootstrapBrain(vault, { configPath });

  const applied = await cli("event-anchor-backfill", "--apply", "--json");
  expect(applied.returncode).toBe(0);
  const payload = JSON.parse(applied.stdout) as Record<string, unknown>;
  expect(payload["dry_run"]).toBe(false);
  expect(payload["examined"]).toBe(2);
  // Only one of the two notes declares a date; the other is now KNOWN
  // to declare none rather than merely never looked at.
  expect(payload["anchored"]).toBe(1);
  // Nothing left to do, so no exit is named.
  expect(payload).not.toHaveProperty("next_command");

  const logDir = join(vault, "Brain", "log");
  const logged = readdirSync(logDir)
    .map((f) => readFileSync(join(logDir, f), "utf8"))
    .join("\n");
  expect(logged).toContain("event-anchor-backfill");

  // And the index run that follows is quiet again.
  const after = await cli("index");
  expect(after.stdout).not.toContain("event anchors:");
  expect(after.stdout).toContain("next: o2b search query");
});

test.skipIf(RUNNING_AS_ROOT)(
  "an unwritable Brain log surfaces on stderr rather than being swallowed",
  async () => {
    await indexThenDowngrade();
    bootstrapBrain(vault, { configPath });
    const logDir = join(vault, "Brain", "log");
    mkdirSync(logDir, { recursive: true });
    chmodSync(logDir, 0o500);
    try {
      const applied = await cli("event-anchor-backfill", "--apply");
      // The anchors were still written - telemetry never fails the
      // primary operation - but the operator is told the record did not
      // land, rather than the failure being swallowed.
      expect(applied.returncode).toBe(0);
      expect(applied.stderr).toContain("append event-anchor-backfill log failed");
    } finally {
      chmodSync(logDir, 0o700);
    }
  },
);

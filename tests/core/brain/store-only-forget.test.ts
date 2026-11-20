/**
 * Forgetting on a switched vault whose legacy `Brain/` tree was removed:
 * the forget plan and `delete_by_source` find the store records derived
 * from a source (a signal and a lane entry), the confirmed run writes the
 * store's own removal marks (`signal-removed`, `lane-entry-remove`), the
 * records are gone from every store read afterwards, and nothing is
 * written into the vault's `Brain/`.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildForgetPlan } from "../../../src/core/brain/governance/forget-plan.ts";
import { storeRecordPages } from "../../../src/core/brain/memory-pages.ts";
import { deleteBySource } from "../../../src/core/brain/source-cleanup.ts";
import { readLaneText } from "../../../src/core/store/lane-pages.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../store-migration/fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let bench: MigrationBench | null = null;
afterEach(() => {
  bench?.cleanup();
  bench = null;
});

const NOW = new Date("2026-11-20T12:00:00Z");
const SOURCE = "notes/leaked.md";

function switchedBench(): MigrationBench {
  const made = makeMigrationBench("osb-forget-store-");
  const { vault } = made;
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE), "# Leaked\n\nA secret the owner wants gone.\n");
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "sources", "leaked.md"),
    `---\nkind: brain-source\nsource_path: ${SOURCE}\n---\n\nSummary of the leaked note.\n`,
  );
  writeFileSync(
    join(vault, "Brain", "inbox", "2026-11-10-leaked.md"),
    `---\nid: sig-leaked\ntopic: leaked\nprinciple: Leaked rule\n_status: active\n` +
      `source_path: ${SOURCE}\n---\n`,
  );
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
  return made;
}

test("the forget plan names the store's lane entries and records", () => {
  bench = switchedBench();
  const plan = buildForgetPlan(bench.vault, { source: SOURCE });
  expect(plan.entries.map((e) => e.path)).toEqual([
    "Brain/inbox/2026-11-10-leaked.md",
    "Brain/sources/leaked.md",
  ]);
  expect(existsSync(join(bench.vault, "Brain"))).toBe(false);
});

test("a lane entry's plan id is the store page's, not a stale legacy file's", () => {
  bench = makeMigrationBench("osb-forget-id-");
  const { vault } = bench;
  mkdirSync(join(vault, "Brain", "sources"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "sources", "leaked.md"),
    `---\nid: source-current\nkind: brain-source\nsource_path: ${SOURCE}\n---\n\nSummary.\n`,
  );
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  // The legacy tree is still on disk, with a stale id the store does not hold.
  writeFileSync(
    join(vault, "Brain", "sources", "leaked.md"),
    `---\nid: source-old\nkind: brain-source\nsource_path: ${SOURCE}\n---\n\nStale.\n`,
  );
  const plan = buildForgetPlan(vault, { source: SOURCE });
  expect(plan.entries.map((e) => [e.path, e.id])).toEqual([
    ["Brain/sources/leaked.md", "source-current"],
  ]);
});

test("delete_by_source removes the derived store records and writes no Brain/", () => {
  bench = switchedBench();
  const { vault } = bench;
  const preview = deleteBySource(vault, SOURCE, { now: NOW });
  expect(preview.derived.map((e) => e.path)).toEqual([
    "Brain/inbox/2026-11-10-leaked.md",
    "Brain/sources/leaked.md",
  ]);

  const done = deleteBySource(vault, SOURCE, { confirm: true, now: NOW });
  expect(done.failed).toEqual([]);
  expect([...done.deleted].toSorted()).toEqual([
    "Brain/inbox/2026-11-10-leaked.md",
    "Brain/sources/leaked.md",
  ]);

  // The store's own removal marks, the ones its readers and the search
  // index honour.
  const kinds = bench.records().map((r) => r.kind);
  expect(kinds).toContain("signal-removed");
  expect(kinds).toContain("lane-entry-remove");

  // Gone from every store read.
  const pages = storeRecordPages(vault, { signalStates: "all" });
  expect(pages.some((p) => p.rel.includes("leaked"))).toBe(false);
  expect(readLaneText(vault, join(vault, "Brain", "sources", "leaked.md"))).toBeNull();
  expect(buildForgetPlan(vault, { source: SOURCE }).entries).toEqual([]);
  // The original note is the user's and stays without --include-originals.
  expect(existsSync(join(vault, SOURCE))).toBe(true);
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

/** Every `shared/events` shard file of the bench's store. */
function eventShards(made: MigrationBench): string[] {
  const shards: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) shards.push(path);
    }
  };
  walk(join(made.storeRoot, "shared", "events"));
  expect(shards.length).toBeGreaterThan(0);
  return shards;
}

test.skipIf(CHMOD_CANNOT_DENY)("the forget plan names the store shards it could not read", () => {
  bench = switchedBench();
  const shards = eventShards(bench);
  try {
    for (const shard of shards) chmodSync(shard, 0o000);
    const plan = buildForgetPlan(bench.vault, { source: SOURCE });
    expect(plan.audit.unreachable?.length ?? 0).toBeGreaterThan(0);
    expect(plan.audit.unreachable!.every((rel) => rel.startsWith("shared/"))).toBe(true);
  } finally {
    for (const shard of shards) chmodSync(shard, 0o644);
  }
});

test.skipIf(CHMOD_CANNOT_DENY)(
  "a confirmed forget over an unreadable shard names it and does not claim completion",
  async () => {
    bench = switchedBench();
    const shards = eventShards(bench);
    try {
      for (const shard of shards) chmodSync(shard, 0o000);
      // The records derived from the source sit in the unreadable shard:
      // the trace cannot see them, and the run must say so.
      const done = deleteBySource(bench.vault, SOURCE, { confirm: true, now: NOW });
      expect(done.failed).toEqual([]);
      expect(done.unreachable?.length ?? 0).toBeGreaterThan(0);
      expect(done.unreachable!.every((rel) => rel.startsWith("shared/"))).toBe(true);

      const cli = await runCli([
        "brain",
        "forget-source",
        SOURCE,
        "--vault",
        bench.vault,
        "--confirm",
        "--json",
      ]);
      expect(cli.returncode).toBe(1);
      const out = JSON.parse(cli.stdout) as { unreachable?: string[]; failed: unknown[] };
      expect(out.failed).toEqual([]);
      expect(out.unreachable?.length ?? 0).toBeGreaterThan(0);
    } finally {
      for (const shard of shards) chmodSync(shard, 0o644);
    }
    // Once the shard reads again, a confirmed run finds and removes what
    // the incomplete one could not, and reports a complete forget.
    const again = deleteBySource(bench.vault, SOURCE, { confirm: true, now: NOW });
    expect(again.unreachable).toBeUndefined();
    expect([...again.deleted].toSorted()).toEqual([
      "Brain/inbox/2026-11-10-leaked.md",
      "Brain/sources/leaked.md",
    ]);
  },
);

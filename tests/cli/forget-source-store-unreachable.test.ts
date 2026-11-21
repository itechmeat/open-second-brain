/**
 * `o2b brain forget-source` and `brain_delete_by_source` on a switched
 * vault (the vault's memory lives in the store) whose `events` shards
 * cannot be read: every surface that runs the plan names what it could
 * not read and never presents its count as final. The dry run, the
 * confirmed run, the text report, `--json` and the MCP tool share one
 * plan, so each is pinned here; the core plan itself is covered in
 * `tests/core/brain/store-only-forget.test.ts`.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { removeLegacy } from "../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../src/core/store-migration/migrate.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { CHMOD_CANNOT_DENY } from "../helpers/platform.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeMigrationBench,
  type MigrationBench,
} from "../core/store-migration/fixtures/migration-env.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS * 4);

const SOURCE = "notes/leaked.md";

let bench: MigrationBench | null = null;
let locked: string[] = [];
afterEach(() => {
  for (const shard of locked) chmodSync(shard, 0o644);
  locked = [];
  bench?.cleanup();
  bench = null;
});

/** A switched vault with a signal and a source page derived from SOURCE, its shards unreadable. */
function lockedSwitchedVault(): MigrationBench {
  const made = makeMigrationBench("osb-forget-unreach-");
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

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) locked.push(path);
    }
  };
  walk(join(made.storeRoot, "shared", "events"));
  expect(locked.length).toBeGreaterThan(0);
  for (const shard of locked) chmodSync(shard, 0o000);
  return made;
}

const UNREAD_LINE = /could not read shared\/\S+; records there were not traced/;

test.skipIf(CHMOD_CANNOT_DENY)(
  "the dry run names the unread shard and does not present its count as final",
  async () => {
    bench = lockedSwitchedVault();
    const text = await runCli(["brain", "forget-source", SOURCE, "--vault", bench.vault]);
    expect(text.stderr).toMatch(UNREAD_LINE);
    expect(text.stdout).not.toMatch(/\bcomplete\b/i);
    expect(text.stdout).toMatch(/incomplete|not complete|could not read/i);

    const json = await runCli(["brain", "forget-source", SOURCE, "--vault", bench.vault, "--json"]);
    const out = JSON.parse(json.stdout) as { unreachable?: string[]; complete?: boolean };
    expect(out.unreachable?.length ?? 0).toBeGreaterThan(0);
    expect(out.unreachable!.every((rel) => rel.startsWith("shared/"))).toBe(true);
    expect(out.complete).toBe(false);
  },
);

test.skipIf(CHMOD_CANNOT_DENY)(
  "the confirmed text run names the unread shard and exits non-zero",
  async () => {
    bench = lockedSwitchedVault();
    const text = await runCli([
      "brain",
      "forget-source",
      SOURCE,
      "--vault",
      bench.vault,
      "--confirm",
    ]);
    expect(text.returncode).toBe(1);
    expect(text.stderr).toMatch(UNREAD_LINE);
    expect(text.stdout).not.toMatch(/\bcomplete\b/i);

    const json = await runCli([
      "brain",
      "forget-source",
      SOURCE,
      "--vault",
      bench.vault,
      "--confirm",
      "--json",
    ]);
    expect(json.returncode).toBe(1);
    const out = JSON.parse(json.stdout) as { unreachable?: string[]; complete?: boolean };
    expect(out.unreachable?.length ?? 0).toBeGreaterThan(0);
    expect(out.complete).toBe(false);
  },
);

test.skipIf(CHMOD_CANNOT_DENY)(
  "brain_delete_by_source names the unread shard on the dry run and the confirmed run",
  async () => {
    bench = lockedSwitchedVault();
    const server = new MCPServer({
      vault: bench.vault,
      configPath: bench.env["OPEN_SECOND_BRAIN_CONFIG"]!,
    });
    // The dry run first, then the confirmed run, in that order.
    const dry = await server.callTool("brain_delete_by_source", { source_file: SOURCE });
    const done = await server.callTool("brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    for (const result of [dry, done]) {
      const out = result["structuredContent"] as { unreachable?: string[]; complete?: boolean };
      expect(out.unreachable?.length ?? 0).toBeGreaterThan(0);
      expect(out.unreachable!.every((rel) => rel.startsWith("shared/"))).toBe(true);
      expect(out.complete).toBe(false);
    }
  },
);

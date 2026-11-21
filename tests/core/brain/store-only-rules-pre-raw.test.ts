/**
 * A rules file with frontmatter that a release before the `raw` field
 * migrated is a `lane-entry` record of fields and text only, so the store
 * renders it with its YAML re-serialised (`'7'` as `7`, an empty value as
 * `""`). The original bytes are still on a machine that kept them: the
 * legacy tree while it is on disk, or the archive the tree's removal kept
 * in the device-local state. A reader serves those bytes when they parse
 * back to exactly the record's fields and text, so an entry the operator
 * changed since is never replaced by the old file.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readScopedRules } from "../../../src/core/brain/scoped-rules.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { readRemovalMarker } from "../../../src/core/store-migration/removal-marker.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
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

const PROJECT_RULE = "---\nscope: coding\nrevision: '7'\nnote:\n---\n\nRun the census.\n";
const IDENTITY = { project: "osb", harness: null, host: null } as const;

/** Write the entry again as a release before `raw` imported it: fields and text only. */
function dropRaw(b: MigrationBench, change: (body: Record<string, unknown>) => void = () => {}) {
  const record = b
    .records()
    .findLast((r) => r.kind === "lane-entry" && r.body["entry"] === "project/osb");
  expect(record).toBeDefined();
  expect(record!.body["raw"]).toBe(PROJECT_RULE);
  const { raw: _raw, ...body } = record!.body as Record<string, unknown>;
  change(body);
  appendRecord(b.store(), {
    partition: record!.partition,
    stream: "events",
    kind: "lane-entry",
    agent: record!.agent ?? "test",
    body,
  });
}

function migrated(): MigrationBench {
  const made = makeMigrationBench("osb-rules-pre-raw-");
  mkdirSync(join(made.vault, "Brain", "standing-rules", "project"), { recursive: true });
  writeFileSync(join(made.vault, "Brain", "standing-rules", "project", "osb.md"), PROJECT_RULE);
  expect(runMigration(made.vault, { settleMs: 0 }).ok).toBe(true);
  return made;
}

test("an entry migrated before raw reads back byte for byte from the kept archive", () => {
  bench = migrated();
  const { vault } = bench;
  dropRaw(bench);
  // While the tree is on disk, its unchanged file supplies the bytes.
  expect(readScopedRules(vault, IDENTITY).text).toContain("revision: '7'\nnote:\n");

  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  const text = readScopedRules(vault, IDENTITY).text;
  expect(text).toContain("revision: '7'\nnote:\n");
  expect(text).not.toContain('note: ""');

  // With no archive left, the rendering of the record is all there is.
  rmSync(readRemovalMarker(bench.store(), vault)!.archive, { recursive: true, force: true });
  expect(readScopedRules(vault, IDENTITY).text).toContain("revision: 7");
});

test("an entry changed since the migration never reads the old file's bytes", () => {
  bench = migrated();
  const { vault } = bench;
  dropRaw(bench, (body) => {
    body["text"] = "Run the census twice.";
  });
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  const text = readScopedRules(vault, IDENTITY).text;
  expect(text).toContain("Run the census twice.");
  expect(text).not.toContain("revision: '7'");
});

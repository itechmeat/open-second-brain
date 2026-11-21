/**
 * Doctor on a switched machine whose vault still holds the legacy tree it
 * imported (between the switch and `--remove-legacy`).
 *
 * The pass used to run every vault check there: it read the legacy log,
 * the legacy pages and their lanes, and judged them (a broken log chain, a
 * removed tool named in an old log page), which on a real vault took six
 * times the time and three times the memory of the same doctor after the
 * removal. Once the machine has switched, the tree is an archive the store
 * already holds: the pass reads the store and says what `--remove-legacy`
 * needs said about the tree, and nothing else about it.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { DreamRunSummary } from "../../../src/core/brain/dream.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { LEGACY_DEVICES_PENDING_CODE } from "../../../src/core/brain/doctor/migration-check.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { makeFleet, type Fleet } from "../store-migration/fixtures/fleet.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// A full migration and two doctor passes, seconds on a loaded machine.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

/** Every reported path, in any stream. */
function reportedPaths(result: ReturnType<typeof runDoctor>): string[] {
  return [...result.warnings, ...result.errors, ...(result.uncertain ?? [])]
    .map((issue) => issue.path ?? "")
    .filter((path) => path !== "");
}

test("the archived tree is not walked or judged; the store and the cohort still are", () => {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  const log = join(a.vault, "Brain", "log");
  mkdirSync(log, { recursive: true });
  // What the full pass judges in the tree: an old log page naming a removed
  // tool, and a legacy log shard with a line that is not a record.
  writeFileSync(join(log, "2026-05-25.md"), "# 2026-05-25\n\nCalled brain_digest for the week.\n");
  writeFileSync(join(log, "2026-05-26.dev-b.jsonl"), "not a record\n");
  // A store preference with a dead evidence link: a store finding.
  writePreference(a.vault, {
    slug: "archived-probe",
    topic: "archived-probe",
    principle: "rule",
    created_at: "2026-05-14T10:00:00Z",
    unconfirmed_until: "2026-05-28T10:00:00Z",
    status: "unconfirmed",
    evidenced_by: ["[[sig-never-existed]]"],
  });

  const result = runDoctor(a.vault);
  // Store records report under their page's path; nothing names the log.
  expect(reportedPaths(result).filter((path) => path.startsWith(log))).toEqual([]);
  expect(result.warnings.map((w) => w.code)).not.toContain("removed-tool-reference");
  expect(result.errors.map((e) => e.code)).not.toContain("log-malformed");
  // The store is still checked: the dead link of the stored preference.
  const broken = result.warnings.filter((w) => w.code === "broken-wikilink");
  expect(broken.map((w) => w.target)).toContain("sig-never-existed");
  // And the cohort, which `--remove-legacy` reads, is still reported.
  const pending = (result.uncertain ?? []).find((u) => u.code === LEGACY_DEVICES_PENDING_CODE);
  expect(pending?.message).toContain("dev-b still writes the legacy Brain/ tree");
});

/** A switched machine with its imported tree still in the vault. */
function archived(): string {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  return a.vault;
}

test("the archived pass counts the dream verification and the instruction ceiling as every pass does", () => {
  const vault = archived();
  writeFileSync(join(vault, "CLAUDE.md"), "x\n".repeat(300));
  const result = runDoctor(vault, {
    dreamSummary: {
      run_id: "dream-2026-05-25-000000",
      changed: false,
      new_unconfirmed: [],
      confirmed: ["pref-ghost"],
      retired: [],
      contradictions: [],
      moved_to_processed: [],
      suppressed: [],
      warnings: [],
      uncertain: [],
      quarantined: [],
    } as unknown as DreamRunSummary,
  });
  expect(result.verification_delta_summary?.missing_evidence).toBe(1);
  expect(result.trust_verdict).toBe("investigate");
  expect((result.instruction_file_warnings ?? []).map((w) => w.path)).toContain("CLAUDE.md");
});

test.skipIf(IS_WINDOWS)(
  "vault-side findings that still matter are kept; the tree's own are not",
  () => {
    const vault = archived();
    // A link under Brain/ that leaves the vault: a hazard to every reader
    // that still walks the tree (the late-write import, the removal) until
    // it leaves.
    mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
    symlinkSync("/", join(vault, "Brain", "notes", "escape"));
    // A sync conflict copy of a legacy log day: the archive's, kept aside by
    // the migration already.
    const log = join(vault, "Brain", "log");
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, "2026-05-25.sync-conflict-20260525-101010-ABCDEFG.md"), "# copy\n");
    const result = runDoctor(vault);
    const codes = [...result.errors, ...result.warnings, ...(result.uncertain ?? [])].map(
      (i) => i.code,
    );
    expect(codes).toContain("symlink-escape");
    expect(codes).not.toContain("sync-conflict-log");
  },
);

test("the archived pass still validates the settings in force", () => {
  const vault = archived();
  const config = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
  // Snapshot retention is a device-local setting of the machine config.
  appendFileSync(config, "brain_snapshots_retention_count: 0\n");
  const result = runDoctor(vault);
  expect(result.errors.map((e) => e.code)).toContain("config-invalid");
});

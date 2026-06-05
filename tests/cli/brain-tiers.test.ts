/**
 * `o2b brain tiers` CLI surface (t_3f92d3f1): check lists staged
 * identity-field hand-edits, restore --apply writes the expected
 * value back into the file, accept adopts the hand-edit as the new
 * snapshot baseline.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-tiers-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePref(id: string, body: string): void {
  writeFileSync(
    join(vault, "Brain", "preferences", "pref-spaces.md"),
    `---\nkind: brain-preference\nid: ${id}\ncreated_at: 2026-05-01T00:00:00Z\ntopic: style\n---\n\n${body}`,
  );
}

async function seedDrift(): Promise<void> {
  const config = resolveSearchConfig({ vault });
  writePref("pref-spaces", "Use spaces.\n");
  await indexVault(config);
  writePref("pref-tabs", "Use spaces everywhere.\n");
  await indexVault(config);
}

test("check lists drift; restore --apply writes the expected value back", async () => {
  await seedDrift();

  const check = await runCli(["brain", "tiers", "check", "--vault", vault, "--json"]);
  expect(check.returncode).toBe(0);
  const checked = JSON.parse(check.stdout) as {
    findings: Array<{ path: string; field: string; expected: string; actual: string }>;
  };
  expect(checked.findings).toHaveLength(1);
  expect(checked.findings[0]).toMatchObject({
    path: "Brain/preferences/pref-spaces.md",
    field: "id",
    expected: "pref-spaces",
    actual: "pref-tabs",
  });

  const dry = await runCli([
    "brain",
    "tiers",
    "restore",
    "Brain/preferences/pref-spaces.md",
    "--vault",
    vault,
  ]);
  expect(dry.returncode).toBe(0);
  expect(dry.stdout).toContain("would restore");
  expect(readFileSync(join(vault, "Brain", "preferences", "pref-spaces.md"), "utf8")).toContain(
    "pref-tabs",
  );

  const restore = await runCli([
    "brain",
    "tiers",
    "restore",
    "Brain/preferences/pref-spaces.md",
    "--apply",
    "--vault",
    vault,
    "--json",
  ]);
  expect(restore.returncode).toBe(0);
  const restored = readFileSync(join(vault, "Brain", "preferences", "pref-spaces.md"), "utf8");
  expect(restored).toContain("id: pref-spaces");
  expect(restored).toContain("Use spaces everywhere.");

  const after = await runCli(["brain", "tiers", "check", "--vault", vault, "--json"]);
  expect(JSON.parse(after.stdout).findings).toHaveLength(0);
});

test("accept adopts the hand-edit; later reindexes stay quiet", async () => {
  await seedDrift();

  const accept = await runCli([
    "brain",
    "tiers",
    "accept",
    "Brain/preferences/pref-spaces.md",
    "--vault",
    vault,
    "--json",
  ]);
  expect(accept.returncode).toBe(0);

  const check = await runCli(["brain", "tiers", "check", "--vault", vault, "--json"]);
  expect(JSON.parse(check.stdout).findings).toHaveLength(0);

  // The accepted value is the new baseline: a reindex of a further
  // body-only edit stages nothing.
  writePref("pref-tabs", "Use spaces everywhere, with feeling.\n");
  const stats = await indexVault(resolveSearchConfig({ vault }));
  expect(stats.tierDrift).toHaveLength(0);
});

test("restore without drift is an operational failure", async () => {
  writePref("pref-spaces", "Use spaces.\n");
  await indexVault(resolveSearchConfig({ vault }));
  const result = await runCli([
    "brain",
    "tiers",
    "restore",
    "Brain/preferences/pref-spaces.md",
    "--apply",
    "--vault",
    vault,
  ]);
  expect(result.returncode).toBe(1);
  expect(result.stderr).toContain("no open drift");
});

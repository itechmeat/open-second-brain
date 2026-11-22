/**
 * `o2b search status` about another index: the release step it prints
 * names that index, so a copied command acts on the file the report
 * names. The default index keeps the short command.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;
let vault: string;
let configPath: string;
let dbPath: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-parked-target-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "notes"), { recursive: true });
  configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  writeFileSync(join(vault, "notes", "a.md"), "# A\n\nbody\n");
  dbPath = join(vault, ".open-second-brain", "brain.sqlite");
  await runCli(["search", "index"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A parked index whose stored embeddings cannot be counted: a rebuild keeps it. */
function parkUnreadable(at: string): void {
  writeFileSync(at + ".bak", Buffer.from("not a database, only bytes. ".repeat(400)));
}

test("the release step of the default index names the plain command", async () => {
  parkUnreadable(dbPath);

  const out = await runCli(["search", "status"], { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } });

  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain("parked_indexes:");
  expect(out.stdout).toContain("release:");
  expect(out.stdout).toContain("o2b search set-aside bak --apply");
  expect(out.stdout).not.toContain("--db ");
  expect(out.stdout).not.toContain("--vault ");
});

test("the release step of another index names that index", async () => {
  const alternate = join(tmp, "alternate", "brain.sqlite");
  mkdirSync(join(tmp, "alternate"), { recursive: true });
  copyFileSync(dbPath, alternate);
  parkUnreadable(alternate);

  const out = await runCli(["search", "status", "--db", alternate], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });

  expect(out.returncode).toBe(0);
  expect(out.stdout).toContain(alternate);
  expect(out.stdout).toContain(`o2b search set-aside --db ${alternate} bak --apply`);
  expect(out.stdout).not.toContain("--vault ");
});

test("the rebuild of another index names that index in its end line", async () => {
  const alternate = join(tmp, "alternate", "brain.sqlite");
  mkdirSync(join(tmp, "alternate"), { recursive: true });
  copyFileSync(dbPath, alternate);
  parkUnreadable(alternate);

  const out = await runCli(["search", "reindex", "--db", alternate], {
    env: { OPEN_SECOND_BRAIN_CONFIG: configPath },
  });

  expect(out.returncode).toBe(0);
  expect(out.stderr).toContain("search index rebuilt:");
  expect(out.stderr).toContain(alternate + ".bak");
  expect(out.stderr).toContain(`o2b search set-aside --db ${alternate} bak --apply`);
});

test("the printed set-aside, run as printed, releases the parked index of another index", async () => {
  const alternate = join(tmp, "alternate", "brain.sqlite");
  mkdirSync(join(tmp, "alternate"), { recursive: true });
  copyFileSync(dbPath, alternate);
  parkUnreadable(alternate);
  const env = { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } };

  const before = await runCli(["search", "status", "--db", alternate], env);
  const printed = /o2b (search set-aside [^\n(;]*--apply)/u.exec(before.stdout)?.[1];
  expect(printed).toBeDefined();

  // The paths here hold no space, so the printed line splits into its argv.
  const moved = await runCli(printed!.split(" "), env);
  expect(moved.returncode).toBe(0);
  expect(existsSync(alternate + ".bak")).toBe(false);
  expect(readdirSync(join(tmp, "alternate", "set-aside")).length).toBe(1);
  // The default index's parked names were never touched.
  const after = await runCli(["search", "status", "--db", alternate], env);
  expect(after.stdout).not.toContain("release:");
});

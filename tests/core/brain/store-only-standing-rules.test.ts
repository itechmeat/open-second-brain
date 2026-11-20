/**
 * The operator's standing rules and scoped rules on a switched vault
 * whose legacy `Brain/` tree was removed: the migration imports them into
 * the `standing-rule` lane, and every reader (the SessionStart block, the
 * sub-agent carrier, `brain_context`) reads them back from there, byte for
 * byte as the files said, with no `Brain/` folder written.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderStandingBlock } from "../../../hooks/lib/standing-block.ts";
import { readScopedRules } from "../../../src/core/brain/scoped-rules.ts";
import { readStandingRules } from "../../../src/core/brain/standing-rules.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
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

/** No frontmatter, a rule line, CRLF ends, a `---` rule, trailing spaces, non-Latin text. */
const CONSTITUTION =
  "# House rules\r\n\r\n" +
  "1. Answer in full sentences.  \r\n" +
  "2. Never push without asking.\r\n\r\n" +
  "---\r\n\r\n" +
  "Отвечай по-русски, когда пишут по-русски.\r\n";

/** A scoped rule whose frontmatter carries a quoted number and an empty value. */
const PROJECT_RULE = "---\nscope: coding\nrevision: '7'\nnote:\n---\n\nRun the census.\n";
const HARNESS_RULE = "Prefer the CLI over the MCP tool when both exist.\n";

const IDENTITY = { project: "osb", harness: "claude-code", host: null } as const;

function migratedBench(): MigrationBench {
  const made = makeMigrationBench("osb-standing-store-");
  const brain = join(made.vault, "Brain");
  writeFileSync(join(brain, "standing-rules.md"), CONSTITUTION);
  writeFileSync(join(brain, "standing-rules", "project", "osb.md"), PROJECT_RULE);
  mkdirSync(join(brain, "standing-rules", "harness"), { recursive: true });
  writeFileSync(join(brain, "standing-rules", "harness", "claude-code.md"), HARNESS_RULE);
  return made;
}

test("standing and scoped rules read back whole from the store after the legacy tree is removed", () => {
  bench = migratedBench();
  const { vault } = bench;
  const before = readStandingRules(vault);
  const scopedBefore = readScopedRules(vault, IDENTITY);
  expect(before?.text).toBe(CONSTITUTION.trim());
  expect(scopedBefore.files.map((f) => f.key)).toEqual(["osb", "claude-code"]);

  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  expect(removeLegacy(vault, { force: true }).removed).toBe(true);
  expect(existsSync(join(vault, "Brain"))).toBe(false);

  const after = readStandingRules(vault);
  expect(after).not.toBeNull();
  expect(after!.text).toBe(before!.text);
  expect(after!.truncated).toBe(false);
  expect(readScopedRules(vault, IDENTITY).text).toBe(scopedBefore.text);

  // The SessionStart block (and the sub-agent carrier, which renders the
  // same block) carries the operator's text under the header.
  const block = renderStandingBlock(vault, 4000);
  expect(block).toContain("## Operator standing rules");
  expect(block).toContain(CONSTITUTION.trim());
  expect(block).not.toContain("UNAVAILABLE");

  // Reading wrote nothing back into the vault.
  expect(existsSync(join(vault, "Brain"))).toBe(false);
});

test("on a switched machine whose legacy tree is still there, the store is the truth", () => {
  bench = migratedBench();
  const { vault } = bench;
  expect(runMigration(vault, { settleMs: 0 }).ok).toBe(true);
  // A stale legacy file edited after the switch is not what is in force.
  writeFileSync(join(vault, "Brain", "standing-rules.md"), "Stale text after the switch.\n");
  rmSync(join(vault, "Brain", "standing-rules", "harness"), { recursive: true });
  expect(readStandingRules(vault)?.text).toBe(CONSTITUTION.trim());
  expect(readScopedRules(vault, IDENTITY).files.map((f) => f.key)).toEqual(["osb", "claude-code"]);
});

/**
 * The defect an owner check found on a copy of a real vault: while a store
 * migration of the vault held this machine's migration gate (a live holder,
 * the same vault path, the same state directory), `o2b brain note` wrote
 * `Brain/log/<day>.<device>.md` and its `.jsonl` into the legacy tree. The
 * note is a Brain log event, which the log appender writes on the audit
 * lane, and the gate was only asked on the content lane.
 *
 * Reproduced the way it was met: the CLI as a subprocess, and the MCP tool
 * through the server's dispatch.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";

import { holdMigrationGate, releaseMigrationGate } from "../../../src/core/migration-gate.ts";
import { MIGRATION_IN_PROGRESS_REFUSAL } from "../../../src/mcp/frozen-refusal.ts";
import { MCPServer } from "../../../src/mcp/server.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { treeSnapshot } from "../../helpers/vault-digest.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

// Tests here spawn the CLI; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const RUN = "migrate-20261119T120000000Z";

let bench: MigrationBench;
beforeEach(() => {
  bench = makeMigrationBench("osb-gate-note-");
  // This test process is the live holder of the gate for the vault.
  holdMigrationGate(bench.vault, RUN);
});
afterEach(() => {
  releaseMigrationGate(bench.vault, RUN);
  bench.cleanup();
});

test("o2b brain note is refused while a migration of the vault holds the gate", async () => {
  const before = treeSnapshot(bench.vault);
  const result = await runCli(
    [
      "brain",
      "note",
      "check-devbox gate probe during migration",
      "--agent",
      "check-devbox-agent",
      "--json",
      "--vault",
      bench.vault,
    ],
    { env: { ...bench.env }, subprocess: true },
  );
  expect(result.returncode).not.toBe(0);
  expect(result.stderr).toContain("store migration of this vault");
  expect(treeSnapshot(bench.vault)).toEqual(before);
});

test("the brain_note MCP tool is refused with the migration-in-progress error", async () => {
  const before = treeSnapshot(bench.vault);
  const server = new MCPServer({
    vault: bench.vault,
    configPath: join(bench.fx.parent, "config.yaml"),
  });
  const response = (await server.handleRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "brain_note", arguments: { text: "gate probe during migration" } },
  })) as { error?: { message: string; data?: Record<string, unknown> } };
  expect(response.error?.data?.["code"]).toBe(MIGRATION_IN_PROGRESS_REFUSAL);
  expect(treeSnapshot(bench.vault)).toEqual(before);
});

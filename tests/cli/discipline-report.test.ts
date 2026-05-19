/**
 * CLI tests for `o2b discipline report` (Task 2.12).
 *
 * Two cases per plan:
 *   1. Happy path — enabled config → exit 0, stdout contains "OSB discipline"
 *   2. Disabled config — enabled: false → exit 0, stderr contains "disabled"
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-discipline-cli-test-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("o2b discipline report", () => {
  test("happy path: enabled config → exit 0, stdout contains 'OSB discipline'", async () => {
    // Use block-style empty sequences — the custom _brain.yaml parser does not
    // handle inline `[]`; it would fall through to a literal string, causing
    // the validator to silently drop the discipline_report section.
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "discipline_report:",
        "  enabled: true",
        "  timezone: UTC",
        "  watched_paths:",
        "  known_agents:",
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCli(["discipline", "report", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("OSB discipline");
  });

  test("disabled config → exit 0, stderr contains 'disabled'", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      [
        "schema_version: 1",
        "discipline_report:",
        "  enabled: false",
        "  timezone: UTC",
        "  watched_paths:",
        "  known_agents:",
      ].join("\n") + "\n",
      "utf8",
    );

    const r = await runCli(["discipline", "report", "--vault", vault]);
    expect(r.returncode).toBe(0);
    expect(r.stderr).toContain("disabled");
  });
});

/**
 * `o2b doctor --readiness` exit codes (nothing-runs-unwatched, unit U12).
 *
 * The verb used to answer with two numbers for three findings. A probe
 * whose budget elapsed was counted as a failure and exited 1, so the same
 * healthy machine exited 0 when idle and 1 when loaded; classifying that
 * probe honestly as `unknown` then moved it into the other silence, and it
 * would have exited 0 - "everything checked out" - for a run that checked
 * nothing. Both readings are wrong, so a run that could not find out gets
 * its own number.
 *
 * That number is 6, the one `o2b search check` already spends on a probe
 * that did not complete, and the pin below is the same one that verb keeps
 * against `o2b install --check`: one number, one meaning across this CLI.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DOCTOR_EXIT, doctorExitCode } from "../../src/cli/main.ts";
import { SEARCH_CHECK_EXIT } from "../../src/cli/search/verbs/check.ts";
import { READINESS_STATUS, type ReadinessReport } from "../../src/core/doctor-readiness.ts";
import { manifestPath } from "../../src/core/install/manifest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-exit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A readiness report with the counts under test and one matching probe. */
function report(failed: number, unknown: number): ReadinessReport {
  return {
    probes: [
      {
        name: "unit_probe",
        status: failed > 0 ? READINESS_STATUS.fail : READINESS_STATUS.unknown,
        detail: "unit",
        durationMs: 1,
      },
    ],
    failed,
    unknown,
  };
}

describe("doctorExitCode", () => {
  test("a clean run exits 0 and a proved failure exits 1", () => {
    expect(doctorExitCode(0, null)).toBe(DOCTOR_EXIT.ok);
    expect(doctorExitCode(1, null)).toBe(DOCTOR_EXIT.failed);
    expect(doctorExitCode(0, report(1, 0))).toBe(DOCTOR_EXIT.failed);
  });

  test("a probe that did not complete is neither a pass nor a failure", () => {
    const code = doctorExitCode(0, report(0, 1));
    expect(code).toBe(DOCTOR_EXIT.probeIncomplete);
    expect(code).not.toBe(DOCTOR_EXIT.ok);
    expect(code).not.toBe(DOCTOR_EXIT.failed);
  });

  test("a proved failure outranks an unmeasured probe, so the specific code never masks it", () => {
    // Same precedence rule `exitCodeForCheck` follows: the more basic
    // finding keeps the generic code even when both are present.
    expect(doctorExitCode(1, report(0, 1))).toBe(DOCTOR_EXIT.failed);
    expect(doctorExitCode(0, report(1, 1))).toBe(DOCTOR_EXIT.failed);
  });

  test("the table is a table and agrees with the verb that set the precedent", () => {
    const codes = Object.values(DOCTOR_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
    // `o2b search check` already spends 6 on a probe that did not complete;
    // a script that learned the number there must not learn a second one.
    expect(DOCTOR_EXIT.probeIncomplete).toBe(SEARCH_CHECK_EXIT.probeIncomplete);
    expect(DOCTOR_EXIT.ok).toBe(SEARCH_CHECK_EXIT.ok);
  });
});

describe("o2b doctor --readiness end to end", () => {
  /**
   * Semantic search off and HOME pinned so the only probe with anything to
   * say about this machine is the installed-runtimes one, whose input this
   * test writes.
   */
  const env = () => ({
    OPEN_SECOND_BRAIN_CONFIG: "",
    XDG_CONFIG_HOME: "",
    VAULT_DIR: "",
    OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "false",
    HOME: tmp,
  });

  test("an install manifest that will not parse exits 6, not 0 and not 1", async () => {
    // The manifest exists, so "nothing is installed" is not the answer; it
    // is unreadable, so neither is "installed and healthy". The probe says
    // it could not measure, and the exit code says so too.
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    writeFileSync(manifestPath(tmp), "{ this is not json", "utf8");

    const r = await runCli(["doctor", "--vault", tmp, "--readiness"], { env: env() });
    expect(r.stdout).toContain("[UNKNOWN] installed_runtimes:");
    expect(r.returncode).toBe(DOCTOR_EXIT.probeIncomplete);
    expect(r.returncode).not.toBe(DOCTOR_EXIT.ok);
    expect(r.returncode).not.toBe(DOCTOR_EXIT.failed);
  });

  test("the same vault with a readable manifest exits 0, so 6 is earned and not ambient", async () => {
    const r = await runCli(["doctor", "--vault", tmp, "--readiness"], { env: env() });
    expect(r.returncode).toBe(DOCTOR_EXIT.ok);
  });

  test("--json carries the same three-way answer the exit code does", async () => {
    mkdirSync(join(tmp, ".open-second-brain"), { recursive: true });
    writeFileSync(manifestPath(tmp), "{ this is not json", "utf8");

    const r = await runCli(["doctor", "--vault", tmp, "--readiness", "--json"], { env: env() });
    expect(r.returncode).toBe(DOCTOR_EXIT.probeIncomplete);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.readiness_summary.unknown).toBe(1);
    expect(parsed.readiness_summary.failed).toBe(0);
    expect(
      parsed.readiness.some(
        (p: { name: string; status: string }) =>
          p.name === "installed_runtimes" && p.status === READINESS_STATUS.unknown,
      ),
    ).toBe(true);
  });
});

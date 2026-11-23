import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-discipline-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeBrainConfig(vault: string, enabled: boolean): void {
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    [
      "schema_version: 1",
      "discipline_report:",
      `  enabled: ${enabled}`,
      "  timezone: UTC",
      "  watched_paths:",
      "  known_agents:",
    ].join("\n") + "\n",
  );
}

describe("discipline doctor check", () => {
  test("reports through advice once per day and stays silent when disabled or unavailable", () => {
    const enabledVault = join(tmp, "enabled$draft");
    const disabledVault = join(tmp, "disabled");
    const unavailableVault = join(tmp, "unavailable");
    writeBrainConfig(enabledVault, true);
    writeBrainConfig(disabledVault, false);
    writeBrainConfig(unavailableVault, true);

    const source = `
      import { spyOn } from "bun:test";
      import * as report from "./src/core/discipline/report.ts";
      import { disciplineDoctorCheck } from "./src/core/brain/doctor/discipline-check.ts";
      const enabledVault = ${JSON.stringify(enabledVault)};
      const disabledVault = ${JSON.stringify(disabledVault)};
      const unavailableVault = ${JSON.stringify(unavailableVault)};
      const now = new Date("2026-10-15T12:00:00.000Z");
      const original = report.runDisciplineReport;
      let calls = 0;
      const spy = spyOn(report, "runDisciplineReport").mockImplementation((...args) => {
        calls += 1;
        const result = original(...args);
        if (args[0].vault === unavailableVault) throw new Error("report unavailable");
        return result;
      });
      const run = (vault, withholdsPrivate = false) => {
        const findings = { issues: [], uncertain: [] };
        disciplineDoctorCheck.run({ vault, now, dbPath: undefined, configPath: undefined, withholdsPrivate }, findings);
        return findings;
      };
      try {
        const first = run(enabledVault);
        const second = run(enabledVault);
        const restricted = run(enabledVault, true);
        const disabled = run(disabledVault);
        const unavailable = run(unavailableVault);
        process.stdout.write(JSON.stringify({ calls, first, second, restricted, disabled, unavailable }));
      } finally {
        spy.mockRestore();
      }
    `;
    const home = join(tmp, "home");
    mkdirSync(home);
    const result = Bun.spawnSync([process.execPath, "-e", source], {
      cwd: process.cwd(),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(tmp, "config"),
        XDG_DATA_HOME: join(tmp, "data"),
        XDG_CACHE_HOME: join(tmp, "cache"),
        XDG_STATE_HOME: join(tmp, "state"),
        CODEX_HOME: join(tmp, "codex"),
        CLAUDE_CONFIG_DIR: join(tmp, "claude"),
        GROK_HOME: join(tmp, "grok"),
        PI_HOME: join(tmp, "pi"),
        CURSOR_HOME: join(tmp, "cursor"),
        OPEN_SECOND_BRAIN_CONFIG: join(tmp, "config", "open-second-brain", "config.yaml"),
        OPEN_SECOND_BRAIN_STORE_ROOT: join(tmp, "store"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const resultData = JSON.parse(result.stdout.toString()) as {
      calls: number;
      first: { issues: unknown[]; uncertain: Array<{ code: string; message: string }> };
      second: { issues: unknown[]; uncertain: Array<{ code: string; message: string }> };
      restricted: { issues: unknown[]; uncertain: unknown[] };
      disabled: { issues: unknown[]; uncertain: unknown[] };
      unavailable: { issues: unknown[]; uncertain: unknown[] };
    };
    expect(resultData.calls).toBe(2);
    expect(resultData.first.issues).toEqual([]);
    expect(resultData.first.uncertain).toHaveLength(1);
    expect(resultData.first.uncertain[0]?.code).toMatch(/^discipline-(alert|info)$/u);
    expect(resultData.first.uncertain[0]?.message).toContain("o2b discipline report");
    expect(resultData.first.uncertain[0]?.message).toContain(`--vault '${enabledVault}'`);
    expect(resultData.second).toEqual(resultData.first);
    expect(resultData.restricted).toEqual({ issues: [], uncertain: [] });
    expect(resultData.disabled).toEqual({ issues: [], uncertain: [] });
    expect(resultData.unavailable).toEqual({ issues: [], uncertain: [] });
    expect(result.stderr.toString()).toBe("");
  });
});

describe("legacy discipline jobs check", () => {
  test("names the jobs file and ids locally and says nothing below local reach", async () => {
    const { legacyDisciplineJobsCheck } =
      await import("../../../../src/core/brain/doctor/discipline-check.ts");
    const jobsFile = join(tmp, "jobs.json");
    writeFileSync(jobsFile, JSON.stringify({ jobs: [{ id: "osb-discipline-report-a1" }] }));
    const previous = process.env["OSB_HERMES_JOBS"];
    process.env["OSB_HERMES_JOBS"] = jobsFile;
    try {
      const run = (withholdsPrivate: boolean) => {
        const findings = { warnings: [], errors: [], uncertain: [] as Array<{ code: string }> };
        legacyDisciplineJobsCheck.run(
          {
            vault: tmp,
            now: new Date(),
            dbPath: undefined,
            configPath: undefined,
            withholdsPrivate,
          },
          findings as never,
        );
        return findings.uncertain.map((entry) => entry.code);
      };
      expect(run(false)).toEqual(["discipline-legacy-jobs"]);
      expect(run(true)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["OSB_HERMES_JOBS"];
      else process.env["OSB_HERMES_JOBS"] = previous;
    }
  });
});

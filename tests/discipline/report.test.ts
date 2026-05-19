import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDisciplineReport } from "../../src/core/discipline/report.ts";

describe("runDisciplineReport", () => {
  test("end-to-end: empty log + active repo → alert text emitted", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-disc-e2e-vault-"));
    mkdirSync(join(vault, "Brain", "log"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ndiscipline_report:\n" +
      "  enabled: true\n  timezone: UTC\n" +
      "  watched_paths:\n    - " + vault + "/repo\n" +
      "  known_agents:\n    - '@claude-vps-agent'\n",
      "utf8",
    );

    const repo = join(vault, "repo");
    mkdirSync(repo);
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email t@t && git config user.name t", { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "hi\n");
    execSync("git add . && git commit -q -m c1", {
      cwd: repo,
      env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T10:00:00Z", GIT_AUTHOR_DATE: "2026-05-17T10:00:00Z" },
    });

    const res = runDisciplineReport({
      vault,
      now: new Date("2026-05-18T01:00:00Z"),
    });
    expect(res.status).toBe("alert");
    expect(res.text).toContain("Status: alert");
    expect(res.text).toContain("1 commits");
    rmSync(vault, { recursive: true });
  });

  test("disabled config → result.status='disabled', empty text", () => {
    const vault = mkdtempSync(join(tmpdir(), "o2b-disc-dis-"));
    mkdirSync(join(vault, "Brain"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\ndiscipline_report:\n  enabled: false\n  timezone: UTC\n  watched_paths: []\n  known_agents: []\n",
      "utf8",
    );
    const res = runDisciplineReport({ vault, now: new Date() });
    expect(res.status).toBe("disabled");
    expect(res.text).toBe("");
    rmSync(vault, { recursive: true });
  });
});

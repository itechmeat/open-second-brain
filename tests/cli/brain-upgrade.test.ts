/**
 * CLI tests for `o2b brain upgrade`.
 *
 * Forks the real `o2b` binary via `runCli`. Each test mutates a
 * freshly-bootstrapped vault to create a known drift (stale manual or
 * truncated `_brain.yaml`), then asserts the verb's exit code,
 * stdout shape, and (for `--apply`) post-state on disk.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdBrainUpgrade } from "../../src/cli/brain/verbs/upgrade.ts";
import * as upgradeModule from "../../src/core/brain/upgrade.ts";
import type { UpgradePlan } from "../../src/core/brain/upgrade.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;
let vault: string;
let config: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-upgrade-cli-"));
  vault = join(tmp, "vault");
  config = join(tmp, "config.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function bootstrap(): Promise<void> {
  const init = await runCli(["init", "--vault", vault, "--name", "Test"], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(init.returncode).toBe(0);
  const brainInit = await runCli(["brain", "init", "--vault", vault], {
    env: { OPEN_SECOND_BRAIN_CONFIG: config },
  });
  expect(brainInit.returncode).toBe(0);
}

describe("brain upgrade", () => {
  test("clean vault → dry-run reports up-to-date, exit 0", async () => {
    await bootstrap();
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("up to date");
  });

  test("--check on clean vault → exit 0", async () => {
    await bootstrap();
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--check"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
  });

  test("--check with pending updates → exit 2", async () => {
    await bootstrap();
    // Drift: stale operator copy of _BRAIN.md.
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--check"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(2);
    expect(r.stdout).toContain("Brain/_BRAIN.md");
  });

  test("--dry-run with pending updates → exit 0, shows the diff", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("update");
    expect(r.stdout).toContain("--- Brain/_BRAIN.md (live)");
    expect(r.stdout).toContain("+++ Brain/_BRAIN.md (release)");
  });

  test("--apply --yes rewrites pending files and creates upgrade-<ts> snapshot", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--apply", "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toMatch(/run_id: upgrade-/);
    expect(r.stdout).toContain("Brain/_BRAIN.md");
    // The snapshot line names the artifact vault-relative: the absolute
    // location is machine-derived (state the vault never supplied), and
    // the run id printed directly above already pins the file name.
    const runId = /run_id: (upgrade-\S+)/.exec(r.stdout)![1]!;
    expect(r.stdout).toContain(`snapshot: Brain/.snapshots/${runId}.tar.zst`);
    expect(r.stdout).not.toContain(tmp);
    // Post-apply: the file is now the canonical template body, not
    // the stale copy.
    const body = readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8");
    expect(body).not.toBe("stale\n");
    // A snapshot named upgrade-<ts> landed under .snapshots/.
    const snapEntries = require("node:fs").readdirSync(join(vault, "Brain", ".snapshots"));
    expect(snapEntries.some((n: string) => n.startsWith("upgrade-"))).toBe(true);
  });

  test("--apply in --json mode requires --yes (non-interactive guard)", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--apply", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("--yes");
  });

  test("--apply on clean vault → no snapshot, no log, exit 0", async () => {
    await bootstrap();
    const snapsBefore = existsSync(join(vault, "Brain", ".snapshots"))
      ? require("node:fs").readdirSync(join(vault, "Brain", ".snapshots")).length
      : 0;
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--apply", "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("nothing to do");
    const snapsAfter = existsSync(join(vault, "Brain", ".snapshots"))
      ? require("node:fs").readdirSync(join(vault, "Brain", ".snapshots")).length
      : 0;
    expect(snapsAfter).toBe(snapsBefore);
  });

  test("malformed _brain.yaml reports error in plan and refuses --apply", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "not: a valid: brain yaml\n");
    const dry = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(dry.returncode).toBe(0);
    expect(dry.stdout).toMatch(/ERROR/);

    const apply = await runCli(["brain", "upgrade", "--vault", vault, "--apply", "--yes"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(apply.returncode).toBe(1);
    expect(apply.stderr).toContain("upgrade aborted");
  });

  test("--dry-run and --apply are mutually exclusive", async () => {
    await bootstrap();
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run", "--apply"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(1);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("--json --dry-run emits structured plan", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const r = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    const payload = JSON.parse(r.stdout) as {
      pending: number;
      errors: number;
      files: Array<{ path: string; status: string }>;
    };
    expect(payload.pending).toBeGreaterThanOrEqual(1);
    expect(payload.files.some((f) => f.path === "Brain/_BRAIN.md" && f.status === "update")).toBe(
      true,
    );
  });

  test("--json --dry-run carries the plan digest (t_18fda844)", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const first = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(first.returncode).toBe(0);
    const payload = JSON.parse(first.stdout) as { digest: string };
    expect(payload.digest).toMatch(/^[0-9a-f]{64}$/);
    // The seal binds the plan, not the moment it was rendered.
    const second = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect((JSON.parse(second.stdout) as { digest: string }).digest).toBe(payload.digest);
  });

  test("a missing _BRAIN.md renders as an update from absent (text and JSON)", async () => {
    await bootstrap();
    rmSync(join(vault, "Brain", "_BRAIN.md"), { force: true });
    const text = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("Brain/_BRAIN.md: update (absent →");
    expect(text.stdout).toContain("+++ Brain/_BRAIN.md (release)");

    const json = await runCli(["brain", "upgrade", "--vault", vault, "--dry-run", "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(json.returncode).toBe(0);
    const payload = JSON.parse(json.stdout) as {
      files: Array<{ path: string; status: string; before_size: number; after_size: number }>;
    };
    const manual = payload.files.find((f) => f.path === "Brain/_BRAIN.md")!;
    expect(manual.status).toBe("update");
    expect(manual.before_size).toBe(0);
    expect(manual.after_size).toBeGreaterThan(0);
  });
});

describe("brain upgrade --apply applies the plan it printed", () => {
  let prevConfigEnv: string | undefined;
  beforeEach(() => {
    prevConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = config;
  });
  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
    else process.env["OPEN_SECOND_BRAIN_CONFIG"] = prevConfigEnv;
  });

  test("--apply --yes hands the shown plan to applyUpgrade, planning once", async () => {
    await bootstrap();
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "stale\n");
    const realPlan = upgradeModule.planUpgrade;
    const shown: UpgradePlan[] = [];
    const planSpy = spyOn(upgradeModule, "planUpgrade").mockImplementation((v) => {
      const plan = realPlan(v);
      shown.push(plan);
      return plan;
    });
    const applySpy = spyOn(upgradeModule, "applyUpgrade");
    const out = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const code = await cmdBrainUpgrade(["--vault", vault, "--apply", "--yes", "--json"]);
      out.mockRestore();
      expect(code).toBe(0);
      expect(shown).toHaveLength(1);
      expect(applySpy).toHaveBeenCalledTimes(1);
      expect(applySpy.mock.calls[0]![1]?.plan).toBe(shown[0]);
    } finally {
      out.mockRestore();
      planSpy.mockRestore();
      applySpy.mockRestore();
    }
    expect(readFileSync(join(vault, "Brain", "_BRAIN.md"), "utf8")).not.toBe("stale\n");
  });

  test("--apply --json reports a drift refusal as JSON with run_id and drifted", async () => {
    await bootstrap();
    const manual = join(vault, "Brain", "_BRAIN.md");
    writeFileSync(manual, "stale\n");
    const realPlan = upgradeModule.planUpgrade;
    // The hand edit lands between the plan and the apply.
    const planSpy = spyOn(upgradeModule, "planUpgrade").mockImplementation((v) => {
      const plan = realPlan(v);
      writeFileSync(manual, "hand edit\n");
      return plan;
    });
    const written: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = await cmdBrainUpgrade(["--vault", vault, "--apply", "--yes", "--json"]);
    } finally {
      out.mockRestore();
      planSpy.mockRestore();
    }
    expect(code).toBe(1);
    const payload = JSON.parse(written.join("")) as Record<string, unknown>;
    expect(payload["ok"]).toBe(false);
    expect(payload["error"]).toContain("Brain/_BRAIN.md");
    expect(payload["run_id"]).toBeNull();
    expect(payload["drifted"]).toEqual(["Brain/_BRAIN.md"]);
    expect(readFileSync(manual, "utf8")).toBe("hand edit\n");
  });
});

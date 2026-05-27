/**
 * CLI tests for `o2b brain upgrade`.
 *
 * Forks the real `o2b` binary via `runCli`. Each test mutates a
 * freshly-bootstrapped vault to create a known drift (stale manual or
 * truncated `_brain.yaml`), then asserts the verb's exit code,
 * stdout shape, and (for `--apply`) post-state on disk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});

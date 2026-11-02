/**
 * `o2b uninstall --target X` reverse instruction step, subprocess-level
 * tests (t_ba41a78a B3).
 *
 * Uninstall removes the LOCK-RECORDED usage block pair and nothing else:
 * the removal goes through the shared writer (operator bytes preserved,
 * the file itself never removed), a pair that is already gone is a named
 * skip, a pair nobody recorded is never touched on a guess, and a
 * successful removal clears the lock entry so it can never claim a pair
 * that is gone.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../../helpers/run-cli.ts";
import { auditWritebackContractFile } from "../../../src/core/brain/writeback-contract.ts";
import { DEFAULT_BEGIN_MARKER } from "../../../src/core/install/managed-block.ts";
import { instructionBlockLockPath } from "../../../src/core/install/instruction-block.ts";

function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-uninst-step-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-uninst-step-h-"));
  configPath = join(home, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});

afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function envBase(extra: Record<string, string> = {}) {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
    ...extra,
  };
}

const OPERATOR = "# operator notes that must survive uninstall\n";

describe("o2b uninstall --target X --apply: the reverse instruction step", () => {
  test("removes the lock-recorded pair, keeps operator bytes, and clears the lock", async () => {
    writeFileSync(join(vault, "AGENTS.md"), OPERATOR);
    const install = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(install.returncode).toBe(0);
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).toBe("conforming");

    const r = await runCli(["uninstall", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("removed instruction block: AGENTS.md");
    const out = readFileSync(join(vault, "AGENTS.md"), "utf8");
    expect(out.startsWith(OPERATOR)).toBe(true);
    expect(out).not.toContain(DEFAULT_BEGIN_MARKER);
    expect(auditWritebackContractFile(join(vault, "AGENTS.md")).finding).toBe("missing-block");
    // The lock entry is cleared; the lock file stays as machine state.
    expect(existsSync(instructionBlockLockPath(vault))).toBe(true);
    const lock = JSON.parse(readFileSync(instructionBlockLockPath(vault), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(lock.files["AGENTS.md"]).toBeUndefined();
  });

  test("is a named skip when the markers are already gone", async () => {
    writeFileSync(join(vault, "AGENTS.md"), OPERATOR);
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    // The operator removed the whole block by hand; the lock still
    // claims it.
    writeFileSync(join(vault, "AGENTS.md"), OPERATOR);
    const r = await runCli(["uninstall", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("skipped: instruction block");
    // The lock never claims a pair that is gone.
    const lock = JSON.parse(readFileSync(instructionBlockLockPath(vault), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(lock.files["AGENTS.md"]).toBeUndefined();
  });

  test("never touches a pair the lock does not record", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    // The lock is lost (or the block was adopted by hand): without a
    // record, the pair on disk is not proven ours, so uninstall leaves
    // it and says so.
    rmSync(instructionBlockLockPath(vault));
    const r = await runCli(["uninstall", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("no lock-recorded instruction block");
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toContain(DEFAULT_BEGIN_MARKER);
  });

  test("dry-run reports the planned removal and changes nothing", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const before = readFileSync(join(vault, "AGENTS.md"), "utf8");
    const r = await runCli(["uninstall", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).toContain("AGENTS.md");
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toBe(before);
  });

  test("a target with no precedence entry is a named skip with no file touched", async () => {
    // A hand-written block a copilot-cli operator keeps, installed with
    // the copilot-cli adapter so ITS uninstall succeeds.
    writeFileSync(
      join(vault, "AGENTS.md"),
      [OPERATOR, DEFAULT_BEGIN_MARKER, "hand-pasted body", ""].join("\n"),
    );
    const install = await runCli(["install", "--target", "copilot-cli", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(install.returncode).toBe(0);
    const r = await runCli(["uninstall", "--target", "copilot-cli", "--apply"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("reads no agent-instruction file");
    // The block nobody recorded survives uninstall untouched.
    expect(readFileSync(join(vault, "AGENTS.md"), "utf8")).toContain(DEFAULT_BEGIN_MARKER);
  });

  test("the JSON payload carries the instruction_block outcome", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const r = await runCli(["uninstall", "--target", "cursor", "--apply", "--json"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    // main.ts wraps a --json flag it does not own in its own envelope;
    // parse through that when present.
    const outer = JSON.parse(r.stdout) as { stdout?: string } & Record<string, unknown>;
    const payload = (typeof outer.stdout === "string" ? JSON.parse(outer.stdout) : outer) as {
      instruction_block: { file: string | null; removed: boolean; skipped_reason: string | null };
    };
    expect(payload.instruction_block.file).toBe("AGENTS.md");
    expect(payload.instruction_block.removed).toBe(true);
    expect(payload.instruction_block.skipped_reason).toBeNull();
  });
});

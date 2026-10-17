/**
 * `o2b install` CLI verb — subprocess-level tests.
 *
 * The adapter modules each have direct unit tests; here we verify
 * the verb wiring: detect-only printout, plan-only mode, --apply,
 * --check, --json, exit codes.
 */

import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";
import { INSTALL_EXIT, exitCodeForVerify } from "../../src/cli/install/install.ts";
import type { VerifyResult } from "../../src/core/install/types.ts";

// The install/uninstall adapters resolve the target home directory from the
// environment at module-load time, so they need a fresh child process per call
// to honor this test's per-case temp HOME (the in-process fast path shares one
// already-loaded module graph). Force the subprocess path for every call here.
function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

// Every case here therefore pays a cold process start, which does not fit
// bun's 5 s default on a machine doing other work.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-install-verb-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-install-verb-h-"));
  configPath = join(home, "config.yaml");
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

describe("o2b install — detect mode", () => {
  test("no args prints the table with no file writes", async () => {
    const r = await runCli(["install"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("detected runtimes");
    // No file should have been written
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("--json emits machine-readable payload", async () => {
    const r = await runCli(["install", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.targets)).toBe(true);
    expect(parsed.targets.length).toBeGreaterThan(0);
  });
});

describe("o2b install --target X (plan-only)", () => {
  test("prints plan without touching the file system", async () => {
    const r = await runCli(["install", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("plan");
    expect(r.stdout).toContain("json-merge");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("--target unknown exits 2", async () => {
    const r = await runCli(["install", "--target", "nope"], { env: envBase() });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown --target");
  });
});

describe("o2b install --target X --apply", () => {
  test.skipIf(process.stdin.isTTY)(
    "the interactive y/N prompt rides stderr, not stdout (upgrade/protect/doctor convention)",
    async () => {
      // Reach the interactive branch: fake a TTY on the test process's
      // stdin for one in-process run. The run's own stdin is NOT a TTY
      // (this test is skipped when it is), so it sits at EOF:
      // readSingleLine answers "" at once, the run cancels, and the
      // adapter never applies - nothing touches any real HOME.
      //
      // This is the suite's ONE prompt-consuming test: readSingleLine
      // answers off the shared process stdin, whose EOF fires once per
      // bun test process, so every other interactive-ladder assertion
      // rides here rather than in a second TTY-faked test.
      const stdin = process.stdin as unknown as { isTTY?: boolean };
      const saved = stdin.isTTY;
      Object.defineProperty(stdin, "isTTY", { value: true, configurable: true });
      try {
        const r = await baseRunCli(["install", "--target", "gemini-cli", "--apply"], {
          env: envBase(),
        });
        expect(r.returncode).toBe(0);
        expect(r.stdout).toContain("install cancelled");
        expect(r.stdout).not.toContain("Proceed? [y/N]");
        expect(r.stderr).toContain("Proceed? [y/N]");
        // M15: the consent-time plan renders beside the prompt on
        // stderr - stdout is the payload stream, and a plan prefixed
        // there corrupted e.g. `generic --out -` - and its header no
        // longer says dry-run while asking for apply consent.
        expect(r.stdout).not.toContain("dry-run");
        expect(r.stdout).not.toContain("— plan");
        expect(r.stderr).toContain("— plan");
        expect(r.stderr).toContain("nothing written until you confirm");
        expect(r.stderr).not.toContain("dry-run");
        expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(false);
      } finally {
        Object.defineProperty(stdin, "isTTY", { value: saved, configurable: true });
      }
    },
    5000,
  );

  test("writes the cursor config file", async () => {
    const r = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    const cfgPath = join(home, ".cursor", "mcp.json");
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeDefined();
  });

  test("user hand-edit + re-apply without --force exits 4", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const before = JSON.parse(readFileSync(cfgPath, "utf8"));
    before.mcpServers["open-second-brain"] = { command: "TAMPERED", args: [] };
    writeFileSync(cfgPath, JSON.stringify(before, null, 2) + "\n");
    // bump mtime well into the future
    const future = new Date(Date.now() + 3600 * 1000);
    utimesSync(cfgPath, future, future);

    const r = await runCli(["install", "--target", "cursor", "--apply", "--yes"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(4);
    expect(r.stderr).toContain("hand-edited");
  });

  test(
    "--apply in --json/non-TTY without --yes exits non-zero, names --yes, " +
      "and leaves ~/.gemini/settings.json byte-identical",
    async () => {
      const cfgPath = join(home, ".gemini", "settings.json");
      // A pre-existing file with operator content must survive untouched.
      const original = '{\n  "theme": "dark"\n}\n';
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, original);

      // Both non-interactive shapes refuse: an explicit --json call and a
      // bare call whose stdin is not a TTY (subprocess spawns never get one).
      // M4: the --json refusal is a JSON envelope on stdout carrying the
      // reserved `headless-refused` verdict, not bare stderr prose.
      const jsonRun = await runCli(["install", "--target", "gemini-cli", "--apply", "--json"], {
        env: envBase(),
      });
      expect(jsonRun.returncode).toBe(INSTALL_EXIT.consentRefused);
      const envelope = JSON.parse(jsonRun.stdout) as Record<string, unknown>;
      expect(envelope["consent"]).toBe("headless-refused");
      expect(envelope["written"]).toBe(false);
      expect(String(envelope["error"])).toContain("--yes");
      expect(readFileSync(cfgPath, "utf8")).toBe(original);

      const ttylessRun = await runCli(["install", "--target", "gemini-cli", "--apply"], {
        env: envBase(),
      });
      expect(ttylessRun.returncode).toBe(INSTALL_EXIT.consentRefused);
      expect(ttylessRun.stderr).toContain("--yes");
      // Nothing was written: the operator's file is byte-identical.
      expect(readFileSync(cfgPath, "utf8")).toBe(original);
    },
  );

  test("--apply --yes writes and the apply JSON carries the consent verdict", async () => {
    const r = await runCli(["install", "--target", "gemini-cli", "--apply", "--yes", "--json"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(true);
    const payload = JSON.parse(r.stdout) as Record<string, unknown>;
    // M3: the verdict is derived from what happened (a --yes consent),
    // in the one vocabulary every guarded lane records.
    expect(payload["consent"]).toBe("yes-flag");
  });

  test("--plan prints a unified diff of the settings file", async () => {
    const cfgPath = join(home, ".gemini", "settings.json");
    mkdirSync(dirname(cfgPath), { recursive: true });
    writeFileSync(cfgPath, '{\n  "theme": "dark"\n}\n');
    const r = await runCli(["install", "--target", "gemini-cli"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("---");
    expect(r.stdout).toContain("+++");
    expect(r.stdout).toContain("+ ");
    // The operator's own key survives in the merged preview.
    expect(r.stdout).toContain("theme");
  });

  test("a consent refusal keeps its own exit code, distinct from usage and drift", () => {
    expect(INSTALL_EXIT.consentRefused).toBe(6);
    const codes = Object.values(INSTALL_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("o2b install --target generic", () => {
  test("--out <path> writes the JSON payload to that path", async () => {
    const outPath = join(home, "snippet.json");
    const r = await runCli(
      ["install", "--target", "generic", "--apply", "--yes", "--out", outPath],
      {
        env: envBase(),
      },
    );
    expect(r.returncode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
  });

  test("--out - with --yes writes the snippet first on stdout, no plan header (M15)", async () => {
    // Non-TTY with --yes: no prompt, so the run needs no interactive
    // stdin - and the payload pin holds without one. The apply consent
    // was given, so nothing may prefix the snippet on stdout (the
    // plain-text receipt after it is the apply close's own channel).
    const r = await runCli(["install", "--target", "generic", "--apply", "--yes", "--out", "-"], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout.startsWith("{")).toBe(true);
    expect(r.stdout).not.toContain("dry-run");
    expect(r.stdout).not.toContain("— plan");
    expect(r.stdout).toContain('"open-second-brain"');
  });

  test("--format yaml emits YAML to stdout", async () => {
    const r = await runCli(
      ["install", "--target", "generic", "--apply", "--yes", "--out", "-", "--format", "yaml"],
      { env: envBase() },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("mcpServers:");
  });
});

describe("o2b install --check", () => {
  test("with no installs, exits 0 with 'not-installed' rows", async () => {
    const r = await runCli(["install", "--check"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("not-installed");
  });

  test("after install --apply, reports ok and exits 0", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
    // The `ok` is a configuration comparison, and says so: nothing here
    // spoke MCP to Cursor.
    expect(r.stdout).toContain("no MCP handshake attempted");
  });

  test("--check without configured vault exits 2 with vault-not-configured", async () => {
    // Pass an empty/unwritable config + no VAULT_DIR — every adapter would
    // otherwise silently report not-installed against a bogus path.
    const r = await runCli(["install", "--check"], { env: { VAULT_DIR: "" } });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("vault not configured");
  });

  test("after partial-key drift, exits 3", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete parsed.mcpServers["open-second-brain-writer"];
    writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + "\n");
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("drift");
  });

  test("after canonical payload drift, exits 3", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    parsed.mcpServers["open-second-brain"].command = "TAMPERED";
    writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + "\n");
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("canonical payload");
  });
});

function row(status: VerifyResult["status"], target = "unit"): VerifyResult {
  return { target, status, details: [`${target}: ${status}`], fix_hint: null };
}

describe("o2b install --check exit codes distinguish the verify states", () => {
  test("a runtime proved unreachable does not exit 0", () => {
    const code = exitCodeForVerify([row("mcp-unreachable")]);
    expect(code).toBe(INSTALL_EXIT.mcpUnreachable);
    expect(code).not.toBe(INSTALL_EXIT.ok);
  });

  test("unreachable and not-installed are different codes", () => {
    expect(exitCodeForVerify([row("not-installed")])).toBe(INSTALL_EXIT.ok);
    expect(exitCodeForVerify([row("mcp-unreachable")])).not.toBe(
      exitCodeForVerify([row("not-installed")]),
    );
  });

  test("ok alone is success, and drift keeps its historical code", () => {
    expect(exitCodeForVerify([row("ok")])).toBe(INSTALL_EXIT.ok);
    expect(exitCodeForVerify([row("drift")])).toBe(INSTALL_EXIT.drift);
    expect(INSTALL_EXIT.drift).toBe(3);
  });

  test("drift outranks unreachable: the config must be right before liveness means anything", () => {
    expect(exitCodeForVerify([row("mcp-unreachable", "a"), row("drift", "b")])).toBe(
      INSTALL_EXIT.drift,
    );
  });

  test("every exit code is distinct", () => {
    const codes = Object.values(INSTALL_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("o2b uninstall --target X", () => {
  test("dry-run prints what would be removed but does nothing", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const r = await runCli(["uninstall", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("dry-run");
    // file still has OSB keys
    const parsed = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
  });

  test("--apply removes OSB keys", async () => {
    await runCli(["install", "--target", "cursor", "--apply", "--yes"], { env: envBase() });
    const r = await runCli(["uninstall", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeUndefined();
  });

  test("--target unknown exits 2", async () => {
    const r = await runCli(["uninstall", "--target", "nope", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(2);
  });
});

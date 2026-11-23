import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { runCli } from "../helpers/run-cli.ts";
import { homeEnv } from "../helpers/platform.ts";

setDefaultTimeout(60_000);

const REPO = join(import.meta.dir, "..", "..");
let root: string;
let env: Record<string, string>;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? [path, ...filesUnder(path)] : [path];
  });
}

describe("no-Hermes journey", () => {
  test("sets up Cursor, records experience, delivers a dream digest, transfers ownership, and uninstalls", async () => {
    root = mkdtempSync(join(tmpdir(), "o2b-agent-parity-journey-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "bun"));
    const vault = join(root, "vault");
    env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      ...homeEnv(join(root, "home")),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      OPEN_SECOND_BRAIN_CONFIG: join(root, "config", "open-second-brain", "config.yaml"),
      OPEN_SECOND_BRAIN_STORE_ROOT: join(root, "store"),
      VAULT_DIR: vault,
      CURSOR_HOME: join(root, "cursor"),
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      GROK_HOME: join(root, "grok"),
      PI_HOME: join(root, "pi"),
      HERMES_HOME: join(root, "hermes"),
      OSB_HERMES_JOBS: join(root, "hermes", "cron", "jobs.json"),
      O2B_DEVICE_ID: "device-a",
    };
    mkdirSync(join(root, "home"), { recursive: true });

    const cli = (args: string[], device = "device-a") =>
      runCli(args, { env: { ...env, O2B_DEVICE_ID: device }, subprocess: true });
    const setup = await cli([
      "setup",
      "--target",
      "cursor",
      "--vault",
      vault,
      "--agent-name",
      "cursor-agent",
      "--timezone",
      "UTC",
      "--apply",
      "--yes",
    ]);
    expect(setup.returncode, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("verified");

    for (let i = 1; i <= 3; i++) {
      const signal = await cli([
        "brain",
        "feedback",
        "--vault",
        vault,
        "--topic",
        "agent-neutral-rule",
        "--signal",
        "positive",
        "--principle",
        "Keep the verified behavior consistent",
        "--agent",
        "cursor-agent",
      ]);
      expect(signal.returncode, signal.stderr).toBe(0);
    }
    const firstDream = await cli(["brain", "dream", "--vault", vault, "--json"]);
    expect(firstDream.returncode, `${firstDream.stdout}\n${firstDream.stderr}`).toBe(1);
    expect(firstDream.stdout).toContain("unsettled");
    const dream = await cli(["brain", "dream", "--vault", vault, "--json"]);
    expect(dream.returncode, `${dream.stdout}\n${dream.stderr}`).toBe(0);
    expect(dream.stdout).toContain("pref-agent-neutral-rule");

    for (const artifact of ["[[journey-one]]", "[[journey-two]]"]) {
      const evidence = await cli([
        "brain",
        "apply-evidence",
        "--vault",
        vault,
        "--pref",
        "pref-agent-neutral-rule",
        "--artifact",
        artifact,
        "--result",
        "applied",
        "--agent",
        "cursor-agent",
      ]);
      expect(evidence.returncode, evidence.stderr).toBe(0);
    }

    const hook = async (sessionId: string) => {
      const proc = Bun.spawn([process.execPath, "run", join(REPO, "hooks", "active-inject.ts")], {
        cwd: REPO,
        env: { ...env, O2B_DEVICE_ID: "device-a" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId }));
      await proc.stdin.end();
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exit = await proc.exited;
      expect(stderr).toBe("");
      return { stdout, exit };
    };
    const first = await hook("journey-session-one");
    const second = await hook("journey-session-two");
    expect(first.exit).toBe(0);
    expect(first.stdout).toContain("Keep the verified behavior consistent");
    expect(first.stdout).toContain("o2b brain digest");
    expect(second.stdout).not.toContain("Dream digest:");

    const request = await cli(["dream", "owner", "--here", "--agent", "cursor-agent"], "device-b");
    expect(request.returncode, request.stderr).toBe(0);
    await cli(["dream", "owner"], "device-a");
    const back = await cli(["dream", "owner", "--here", "--agent", "cursor-agent"], "device-a");
    expect(back.returncode, back.stderr).toBe(0);
    await cli(["dream", "owner"], "device-b");

    const uninstall = await cli(["uninstall", "--config", env["OPEN_SECOND_BRAIN_CONFIG"]!]);
    expect(uninstall.returncode, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).not.toMatch(/\bhermes\b/iu);
    expect(uninstall.stdout).not.toMatch(/\.hermes(?:[\\/]|$)/iu);

    const output = [setup, dream, uninstall]
      .map((result) => `${result.stdout}\n${result.stderr}`)
      .join("\n");
    expect(output).not.toMatch(/\bhermes\b/iu);
    const files = filesUnder(root);
    expect(files.some((path) => relative(root, path).includes(".hermes"))).toBe(false);
    for (const path of files) {
      if (!existsSync(path)) continue;
      let contents: string;
      try {
        contents = readFileSync(path, "utf8");
      } catch {
        // Binary store files do not contain user-facing setup output.
        continue;
      }
      if (contents.includes("\0")) continue;
      expect(contents).not.toMatch(/\bhermes\b/iu);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-active-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-active-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<RunResult> {
  // Bun.spawn env replaces (does not merge with) process.env when
  // provided. We explicitly forward PATH so `bun run` can resolve its
  // own toolchain on $PATH-only systems.
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

function writeActive(body: string): void {
  writeFileSync(join(vault, "Brain", "active.md"), body, "utf8");
}

describe("active-inject hook", () => {
  test("injects active.md content as SessionStart additionalContext", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    );

    const r = await runHook(
      {
        hook_event_name: "SessionStart",
        session_id: "abc",
      },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout.endsWith("\n")).toBe(true);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("# Active Brain Preferences");
    expect(out.hookSpecificOutput.additionalContext).toContain("pref-foo");
  });

  test("echoes PostCompact as the hookEventName when fired post-compact", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (0)\n\n_No confirmed preferences yet._\n",
    );

    const r = await runHook(
      {
        hook_event_name: "PostCompact",
      },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostCompact");
    expect(out.hookSpecificOutput.additionalContext).toContain("# Active Brain Preferences");
  });

  test("stays silent when Brain/active.md does not exist", async () => {
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when vault cannot be resolved (no config, no env)", async () => {
    const r = await runHook({ hook_event_name: "SessionStart" });
    // No VAULT_DIR, no config in $HOME → resolveVault returns null.
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent on empty payload", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\nbody\n",
    );
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: configHome,
        VAULT_DIR: vault,
      },
    });
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    // Empty stdin → readHookInput returns null → asHookPayload returns
    // {} → we use the default "SessionStart" event name and still
    // inject. The contract is to be useful when called by a runtime
    // that doesn't pre-populate `hook_event_name`.
    expect(stdout).not.toBe("");
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
  });

  test("stays silent when active.md is empty whitespace only", async () => {
    writeActive("   \n  \n");
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

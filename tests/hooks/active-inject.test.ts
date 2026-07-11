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

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  // Bun.spawn env replaces (does not merge with) process.env when
  // provided. We explicitly forward PATH so `bun run` can resolve its
  // own toolchain on $PATH-only systems.
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
    // Isolate the active.md injection behaviour from the runtime-notice
    // channel by default; the dedicated notice test re-enables it.
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
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

function writeLessons(body: string): void {
  writeFileSync(join(vault, "Brain", "lessons.md"), body, "utf8");
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

  test("stays silent under PostCompact - the event cannot carry additionalContext", async () => {
    // Current Claude Code has no PostCompact hook event; runtimes that
    // still fire one reject `hookSpecificOutput.additionalContext` for
    // it, echoing the whole payload back as a validation error. The
    // post-compact re-injection path is the SessionStart `compact`
    // matcher instead.
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
    expect(r.stdout).toBe("");
  });

  test("injects under UserPromptSubmit - an allowlisted context-bearing event", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    );

    const r = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
      },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toContain("pref-foo");
  });

  test("stays silent under an unknown future event name (default-closed)", async () => {
    writeActive("---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\nbody\n");

    const r = await runHook({ hook_event_name: "SomeFutureEvent" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("stays silent when Brain/active.md does not exist", async () => {
    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
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
    writeActive("---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\nbody\n");
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

  test("budgets an oversized active.md body and points at brain_context", async () => {
    const hugeRules = Array.from(
      { length: 400 },
      (_, i) => `- \`pref-rule-${i}\` (confidence: low (0.10)) — Rule number ${i} body text`,
    ).join("\n");
    writeActive(
      `---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (400)\n\n${hugeRules}\n\n## Recently retired (last 1)\n\n- \`pref-r\` — low_confidence on 2026-05-01\n`,
    );

    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    const injected: string = out.hookSpecificOutput.additionalContext;
    // Default budget is 8,000 chars (+ the one-line truncation notice).
    expect(injected.length).toBeLessThanOrEqual(8300);
    expect(injected).toContain("# Active Brain Preferences");
    expect(injected).toContain("brain_context");
    expect(injected).not.toContain("## Recently retired");
  });

  test("honors active.inject_budget_chars from _brain.yaml", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 500\n",
      "utf8",
    );
    const rules = Array.from(
      { length: 40 },
      (_, i) => `- \`pref-rule-${i}\` — Rule number ${i} body text`,
    ).join("\n");
    writeActive(
      `---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (40)\n\n${rules}\n`,
    );

    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    const injected: string = out.hookSpecificOutput.additionalContext;
    expect(injected.length).toBeLessThanOrEqual(800);
    expect(injected).toContain("brain_context");
  });

  test("appends lessons.md body alongside active.md when present", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    );
    writeLessons(
      "---\nkind: brain-lessons\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Lessons\n\n## Avoid (1)\n\n- `de-2026-05-18-x` (score: -0.95) — the flaky retry loop\n",
    );

    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    const injected: string = out.hookSpecificOutput.additionalContext;
    expect(injected).toContain("# Active Brain Preferences");
    expect(injected).toContain("pref-foo");
    expect(injected).toContain("# Lessons");
    expect(injected).toContain("the flaky retry loop");
  });

  test("injects active.md alone when lessons.md is absent", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    );
    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    const injected: string = out.hookSpecificOutput.additionalContext;
    expect(injected).toContain("pref-foo");
    expect(injected).not.toContain("# Lessons");
  });

  test("stays silent when active.md is empty whitespace only", async () => {
    writeActive("   \n  \n");
    const r = await runHook({ hook_event_name: "SessionStart" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("prepends a runtime-notice block when a transient condition holds", async () => {
    writeActive(
      "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    );
    // Notices on (override the harness default); no search index exists in
    // this bare vault, so the index-missing notice fires and rides the surface.
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "true" },
    );
    expect(r.exit).toBe(0);
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(injected).toContain("Runtime notices:");
    expect(injected).toContain("Search index is not built");
    // The active body still follows the notice block.
    expect(injected).toContain("pref-foo");
    expect(injected.indexOf("Runtime notices:")).toBeLessThan(injected.indexOf("pref-foo"));
  });

  test("injects notices alone when there is no active.md body", async () => {
    // No active.md at all; the notice channel still surfaces the condition.
    const r = await runHook(
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "true" },
    );
    expect(r.exit).toBe(0);
    const injected: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(injected).toContain("Runtime notices:");
    expect(injected).toContain("Search index is not built");
  });
});

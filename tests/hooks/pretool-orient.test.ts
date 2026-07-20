import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "pretool-orient.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-orient-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-orient-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(join(vault, "Brain", "note.md"), "# note\n");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
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
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

function ccPayload(toolName: string, toolInput: unknown, sessionId = "s1"): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: sessionId,
    cwd: vault,
    tool_use_id: "tu1",
    transcript_path: "/home/dev/.claude/projects/p/session.jsonl",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function auditRecords(): Array<Record<string, unknown>> {
  const dir = join(vault, ".open-second-brain", "hook-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
}

const ON = { OPEN_SECOND_BRAIN_HOOK_STRICT_ENABLED: "true" };

describe("pretool-orient hook", () => {
  test("flag off (default) is byte-identical: no stdout for a raw vault read", async () => {
    const r = await runHook(ccPayload("Read", { file_path: join(vault, "Brain", "note.md") }), {
      VAULT_DIR: vault,
    });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toHaveLength(0);
  });

  test("flag on: first raw vault read is denied with a redirect naming the search surface", async () => {
    const r = await runHook(ccPayload("Read", { file_path: join(vault, "Brain", "note.md") }), {
      ...ON,
      VAULT_DIR: vault,
    });
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain("search");
    const audit = auditRecords().find((rec) => rec["actor"] === "pretool-orient");
    expect(audit).toBeDefined();
    const details = (audit!["details"] ?? {}) as Record<string, unknown>;
    expect(details["decision"]).toBe("deny");
  });

  test("flag on: the second raw read downgrades to a soft nudge (allow + reason)", async () => {
    const payload = ccPayload("Read", { file_path: join(vault, "Brain", "note.md") });
    await runHook(payload, { ...ON, VAULT_DIR: vault }); // first: deny + blocked stamp
    const r = await runHook(payload, { ...ON, VAULT_DIR: vault });
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
  });

  test("flag on: a brain search refreshes orientation and then suppresses the block", async () => {
    const refresh = await runHook(
      ccPayload("mcp__plugin_x_open-second-brain__brain_search", { query: "receipts" }),
      { ...ON, VAULT_DIR: vault },
    );
    expect(refresh.stdout).toBe(""); // refresh emits nothing
    const r = await runHook(ccPayload("Read", { file_path: join(vault, "Brain", "note.md") }), {
      ...ON,
      VAULT_DIR: vault,
    });
    expect(r.stdout).toBe(""); // oriented -> allow, no deny
  });

  test("flag on: a read OUTSIDE the vault root is allowed (no stdout)", async () => {
    const r = await runHook(ccPayload("Read", { file_path: "/etc/hostname" }), {
      ...ON,
      VAULT_DIR: vault,
    });
    expect(r.stdout).toBe("");
  });

  test("flag on: a Write inside the vault is never blocked (no stdout)", async () => {
    const r = await runHook(ccPayload("Write", { file_path: join(vault, "Brain", "x.md") }), {
      ...ON,
      VAULT_DIR: vault,
    });
    expect(r.stdout).toBe("");
  });

  // --- fail-open paths, one test each ------------------------------------

  test("fail open: a non-Claude-Code harness never hard-blocks (no stdout)", async () => {
    const codexPayload = {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      transcript_path: "/home/dev/.codex/sessions/session.jsonl",
      tool_name: "Read",
      tool_input: { file_path: join(vault, "Brain", "note.md") },
    };
    const r = await runHook(codexPayload, { ...ON, VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("fail open: a malformed session-state file is treated as absent, no crash", async () => {
    const stateDir = join(vault, ".open-second-brain", "hook-state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "s1.json"), "{ corrupt json");
    const r = await runHook(ccPayload("Read", { file_path: join(vault, "Brain", "note.md") }), {
      ...ON,
      VAULT_DIR: vault,
    });
    expect(r.exit).toBe(0);
    // Malformed stamp reads as absent -> behaves like a first read -> deny,
    // without throwing.
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("fail open: an unreadable/empty stdin payload emits nothing", async () => {
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: configHome, ...ON, VAULT_DIR: vault },
    });
    await proc.stdin.end(); // empty stdin
    const stdout = await new Response(proc.stdout).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
  });

  test("fail open: an unresolvable vault emits nothing", async () => {
    const r = await runHook(ccPayload("Read", { file_path: join(vault, "Brain", "note.md") }), ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

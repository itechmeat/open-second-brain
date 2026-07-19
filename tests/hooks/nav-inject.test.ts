import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "nav-inject.ts");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-nav-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-nav-cfg-"));
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

describe("nav-inject hook", () => {
  test("flag off (default) is a silent no-op: no stdout, no audit", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "orient me", session_id: "s1" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toHaveLength(0);
  });

  test("flag on with no index suppresses (empty) and audits the decision", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "orient me", session_id: "s1" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_NAV_TIER_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    // A bare vault has no link graph, so nothing structural to map.
    expect(r.stdout).toBe("");
    const record = auditRecords().find((rec) => rec["actor"] === "nav-inject");
    expect(record).toBeDefined();
    const details = (record?.["details"] ?? {}) as Record<string, unknown>;
    expect(details["decision"]).toBe("suppress");
    expect(details["reason"]).toBe("empty");
  });

  test("flag on stays silent when the vault cannot be resolved", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "orient me", session_id: "s1" },
      { OPEN_SECOND_BRAIN_NAV_TIER_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

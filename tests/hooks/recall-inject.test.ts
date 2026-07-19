import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "recall-inject.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-recall-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-recall-cfg-"));
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

describe("recall-inject hook", () => {
  test("flag off (default) is a silent no-op: no stdout, no audit", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toHaveLength(0);
  });

  test("flag on stays fail-open and audits a decision on an empty vault", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "how do receipts work" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    // Nothing to recall in a bare vault, so the hook abstains and injects nothing.
    expect(r.stdout).toBe("");
    const records = auditRecords();
    expect(records.length).toBeGreaterThanOrEqual(1);
    const record = records.find((rec) => rec["actor"] === "recall-inject");
    expect(record).toBeDefined();
    const details = (record?.["details"] ?? {}) as Record<string, unknown>;
    expect(["inject", "abstain", "error"]).toContain(details["decision"] as string);
  });

  test("flag on stays silent when the vault cannot be resolved", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "receipts" },
      {
        OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true",
      },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("flag on abstains without stdout on an empty prompt", async () => {
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", prompt: "   " },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    const record = auditRecords().find((rec) => rec["actor"] === "recall-inject");
    const details = (record?.["details"] ?? {}) as Record<string, unknown>;
    expect(details["decision"]).toBe("abstain");
    expect(details["reason"]).toBe("empty_prompt");
  });
});

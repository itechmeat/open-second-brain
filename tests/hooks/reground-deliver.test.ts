/**
 * `reground-deliver` carrier (recall-injection-lifecycle, t_55ee804e):
 * hands out exactly one queued part of an oversized SessionStart payload
 * per PostToolUse or UserPromptSubmit event, under a try-once lock, and
 * stays silent everywhere else.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beginInjectionEpoch } from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";
import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "reground-deliver.ts",
);

const SESSION = "deliver-session-0001";
const EPOCH = "compact:1760000000000";
const REGROUND_ON = { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" };
const PART_2 =
  "[Open Second Brain context - part 2 of 3]\n\nsecond `pref-b`\n\n(continued in part 3 of 3)";
const PART_3 = "[Open Second Brain context - part 3 of 3]\n\nthird \u{1F600}";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-reground-deliver-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-reground-deliver-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
  readonly elapsedMs: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      VAULT_DIR: vault,
      ...env,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, exit, elapsedMs: Date.now() - started };
}

function seedQueue(): void {
  const ok = beginInjectionEpoch(vault, SESSION, {
    epoch: EPOCH,
    emittedPaths: ["Brain/preferences/pref-b.md"],
    regroundParts: [PART_2, PART_3],
    partCeilingChars: 9000,
  });
  expect(ok).toBe(true);
}

function postTool(): Record<string, unknown> {
  return { hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "Read" };
}

function contextOf(r: RunResult, event: string): string {
  const parsed = JSON.parse(r.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe(event);
  return parsed.hookSpecificOutput.additionalContext;
}

function auditRecords(): Array<Record<string, unknown>> {
  const dir = hookAuditDir(vault);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    .filter((record) => record["actor"] === "reground-deliver");
}

describe("reground-deliver hook", () => {
  test("flag off: no stdout, no audit and no hook state", async () => {
    const r = await runHook(postTool());
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toEqual([]);
    expect(existsSync(join(vault, ".open-second-brain"))).toBe(false);
  });

  test("flag off leaves a seeded queue untouched", async () => {
    seedQueue();
    const r = await runHook(postTool());
    expect(r.stdout).toBe("");
    const on = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(on, "PostToolUse")).toBe(PART_2);
  });

  test("each PostToolUse delivers the next part, then nothing", async () => {
    seedQueue();
    const first = await runHook(postTool(), REGROUND_ON);
    expect(first.exit).toBe(0);
    expect(contextOf(first, "PostToolUse")).toBe(PART_2);
    const second = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(second, "PostToolUse")).toBe(PART_3);
    const third = await runHook(postTool(), REGROUND_ON);
    expect(third.exit).toBe(0);
    expect(third.stdout).toBe("");
  });

  test("a UserPromptSubmit delivers the next part under its own event name", async () => {
    seedQueue();
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "continue" },
      REGROUND_ON,
    );
    expect(contextOf(r, "UserPromptSubmit")).toBe(PART_2);
  });

  test("any other event emits nothing and keeps the queue", async () => {
    seedQueue();
    const others = await Promise.all(
      ["SessionStart", "PreToolUse", "Stop", "PostCompact", ""].map((event) =>
        runHook({ hook_event_name: event, session_id: SESSION }, REGROUND_ON),
      ),
    );
    for (const r of others) {
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe("");
    }
    const r = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(r, "PostToolUse")).toBe(PART_2);
  });

  test("without a session id nothing is delivered", async () => {
    seedQueue();
    const r = await runHook({ hook_event_name: "PostToolUse", tool_name: "Read" }, REGROUND_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a held scope lock emits nothing quickly and the part survives", async () => {
    seedQueue();
    const lockPath = hookStateFilePath(vault, SESSION) + ".lock";
    writeFileSync(lockPath, "held by another process\n");
    try {
      const r = await runHook(postTool(), REGROUND_ON);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.elapsedMs).toBeLessThan(10_000);
    } finally {
      unlinkSync(lockPath);
    }
    const next = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(next, "PostToolUse")).toBe(PART_2);
  });

  test("every delivery appends one audit line", async () => {
    seedQueue();
    await runHook(postTool(), REGROUND_ON);
    await runHook(postTool(), REGROUND_ON);
    await runHook(postTool(), REGROUND_ON);
    const records = auditRecords();
    expect(records.length).toBe(2);
    const [first, second] = records.map((record) => record["details"] as Record<string, unknown>);
    expect(first).toEqual({
      part: 2,
      total: 3,
      epoch: EPOCH,
      bytes: Buffer.byteLength(PART_2, "utf8"),
      utf16_chars: PART_2.length,
      part_ceiling_chars: 9000,
      over_budget: false,
    });
    expect(second!["part"]).toBe(3);
    expect(second!["bytes"]).toBe(Buffer.byteLength(PART_3, "utf8"));
    expect(second!["utf16_chars"]).toBe(PART_3.length);
  });

  test("a part longer than its ceiling is delivered and flagged over budget", async () => {
    const ok = beginInjectionEpoch(vault, SESSION, {
      epoch: EPOCH,
      emittedPaths: [],
      regroundParts: ["x".repeat(2500)],
      partCeilingChars: 2000,
    });
    expect(ok).toBe(true);
    const r = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(r, "PostToolUse").length).toBe(2500);
    const details = auditRecords()[0]!["details"] as Record<string, unknown>;
    expect(details["over_budget"]).toBe(true);
  });
});

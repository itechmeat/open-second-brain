import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitRecallTelemetry } from "../../src/core/brain/recall-telemetry.ts";
import {
  listGapTasks,
  promoteGapsToTasks,
  GAP_TASK_STATUS_OPEN,
} from "../../src/core/brain/gaps/gap-loop.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-gap-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-gap-cfg-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(
  name: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
  };
  const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, `${name}.ts`)], {
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

function seedGap(topic: string, times: number): void {
  for (let i = 0; i < times; i++) {
    emitRecallTelemetry(vault, {
      host: "test",
      mode: "search",
      status: "empty",
      durationMs: 0,
      resultCount: 0,
      gaps: [topic],
      createdAt: `2026-05-2${i}T09:00:00.000Z`,
    });
  }
}

describe("gap-promote hook (SessionEnd)", () => {
  test("flag off is a no-op: no gap-task notes written", async () => {
    seedGap("alpha topic", 3);
    const r = await runHook("gap-promote", { hook_event_name: "SessionEnd" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(existsSync(join(vault, "Brain", "gap-tasks"))).toBe(false);
  });

  test("flag on promotes a recurring gap to an open gap-task note", async () => {
    seedGap("alpha topic", 3);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      {
        VAULT_DIR: vault,
        OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true",
        OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD: "2",
      },
    );
    expect(run.exit).toBe(0);
    const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
    expect(open.map((t) => t.topic)).toContain("alpha topic");
  });
});

describe("gap-agenda hook (SessionStart)", () => {
  test("flag off is a silent no-op: no stdout", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: new Date("2026-06-01T12:00:00.000Z") });
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("flag on injects an open-gap agenda as additionalContext", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: new Date("2026-06-01T12:00:00.000Z") });
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("alpha topic");
    expect(out.hookSpecificOutput.additionalContext).toContain("[open]");
  });

  test("flag on stays silent when there are no open gap tasks", async () => {
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

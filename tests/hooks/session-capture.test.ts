import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { IS_WINDOWS, homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "session-capture.ts",
);

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-session-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-session-cfg-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** How long a hook stuck on a FIFO read is given before it is killed. */
const FIFO_KILL_AFTER_MS = 15_000;

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
  killAfterMs?: number,
): Promise<{ stdout: string; stderr: string; exit: number; killed: boolean }> {
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
  let killed = false;
  const timer =
    killAfterMs === undefined
      ? undefined
      : setTimeout(() => {
          killed = true;
          proc.kill("SIGKILL");
        }, killAfterMs);
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  if (timer !== undefined) clearTimeout(timer);
  return { stdout, stderr, exit, killed };
}

describe("session-capture hook", () => {
  test("captures UserPromptSubmit markers and stays silent to the runtime", async () => {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "hook-session",
      prompt: "@osb feedback positive topic=hook principle=capture-hook-prompt",
    });

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("");
    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.endsWith(".md")),
    ).toHaveLength(1);
  });

  // The UserPromptSubmit hook runs under a host timeout, and the inbox it
  // would dedup against can hold thousands of signals on a slow mount. A
  // FIFO named like a signal blocks any read of it until a writer appears,
  // and none ever does - so the hook finishing at all is the proof that a
  // prompt with nothing to capture never opened an inbox signal.
  test.skipIf(IS_WINDOWS)(
    "a prompt with no marker or fact never reads the inbox signals",
    async () => {
      const fifo = join(vault, "Brain", "inbox", "sig-2026-01-01-blocking.md");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

      const result = await runHook(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "marker-free-session",
          prompt: "hello",
        },
        {},
        FIFO_KILL_AFTER_MS,
      );

      expect(result.killed).toBe(false);
      expect(result.exit).toBe(0);
      // The event was still recorded, so the hook did not bail out early.
      const logDir = join(vault, "Brain", "log");
      const logText = readdirSync(logDir)
        .filter((name) => name.endsWith(".md"))
        .map((name) => readFileSync(join(logDir, name), "utf8"))
        .join("\n");
      expect(logText).toContain("session_id: marker-free-session");
    },
    FIFO_KILL_AFTER_MS + 5_000,
  );

  test("a repeated prompt marker is deduped against the signal already on disk", async () => {
    const payload = {
      hook_event_name: "UserPromptSubmit",
      session_id: "dedup-session",
      prompt: "@osb feedback positive topic=hook-dedup principle=capture-once",
    };

    expect((await runHook(payload)).exit).toBe(0);
    expect((await runHook(payload)).exit).toBe(0);

    expect(
      readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.startsWith("sig-")),
    ).toHaveLength(1);
  });

  test("does not crash on malformed payload", async () => {
    const result = await runHook(null);

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });
});

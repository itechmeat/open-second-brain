import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

/** How long a test waits for a deferred capture worker to land its writes. */
const WORKER_WAIT_MS = 20_000;

async function waitFor(check: () => boolean, timeoutMs = WORKER_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling, sequential by design
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

function inboxSignals(): string[] {
  return readdirSync(join(vault, "Brain", "inbox")).filter((name) => name.startsWith("sig-"));
}

/** Number of session-lifecycle audit rows, i.e. captures that finished. */
function capturesFinished(): number {
  const dir = join(vault, "Brain", "log", "session-lifecycle");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("")
    .split("\n")
    .filter((line) => line.includes("session_lifecycle_capture")).length;
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
    // A marker needs the dedup index, so the capture is finished by a
    // detached worker after the hook has already returned.
    expect(await waitFor(() => capturesFinished() === 1)).toBe(true);
    expect(inboxSignals()).toHaveLength(1);
  });

  test("the hand-off can be disabled so the capture lands before the hook exits", async () => {
    const result = await runHook(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "inline-session",
        prompt: "@osb feedback positive topic=inline principle=capture-inline",
      },
      { OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER: "0" },
    );

    expect(result.exit).toBe(0);
    expect(inboxSignals()).toHaveLength(1);
  });

  // The regression the hand-off exists for: a prompt that DOES need the
  // dedup index (a marker, or a fact such as a URL) used to walk every
  // inbox signal inside the host's 10 s timeout. A FIFO named like a
  // signal blocks that walk until a writer appears; the hook returning
  // anyway proves the walk no longer runs on the host's clock.
  test.skipIf(IS_WINDOWS)(
    "a prompt that needs the dedup walk returns before the walk finishes",
    async () => {
      const fifo = join(vault, "Brain", "inbox", "sig-2026-01-01-blocking.md");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

      const started = Date.now();
      const result = await runHook(
        {
          hook_event_name: "UserPromptSubmit",
          session_id: "fact-session",
          prompt:
            "see https://example.com/some/page\n@osb feedback positive topic=fifo principle=deferred-capture",
        },
        {},
        FIFO_KILL_AFTER_MS,
      );

      expect(result.killed).toBe(false);
      expect(result.exit).toBe(0);
      expect(Date.now() - started).toBeLessThan(FIFO_KILL_AFTER_MS);
      expect(capturesFinished()).toBe(0);

      // Unblock the worker's read of the FIFO (open for write, then close
      // at once: the reader sees EOF) and let it finish the capture.
      spawnSync("sh", ["-c", `: > '${fifo}'`], { timeout: WORKER_WAIT_MS });
      expect(await waitFor(() => capturesFinished() === 1)).toBe(true);
      expect(inboxSignals().filter((name) => name.includes("fifo"))).toHaveLength(1);
    },
    FIFO_KILL_AFTER_MS + WORKER_WAIT_MS + 5_000,
  );

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

    // Back to back: the two deferred workers run one at a time, so the
    // second sees the first one's signal in its dedup index.
    expect((await runHook(payload)).exit).toBe(0);
    expect((await runHook(payload)).exit).toBe(0);

    expect(await waitFor(() => capturesFinished() === 2)).toBe(true);
    expect(inboxSignals()).toHaveLength(1);
  });

  test("does not crash on malformed payload", async () => {
    const result = await runHook(null);

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });
});

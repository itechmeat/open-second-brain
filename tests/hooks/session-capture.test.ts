import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";

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

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: configHome,
      VAULT_DIR: vault,
      ...env,
    },
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

  test("does not crash on malformed payload", async () => {
    const result = await runHook(null);

    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
  });
});

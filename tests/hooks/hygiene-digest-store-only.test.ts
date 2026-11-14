/**
 * The Stop hygiene digest on a store-only machine (a bare vault, store
 * present): its once-per-change ledger is machine state, so it lives in
 * the device-local state, nothing is written into the vault, and a second
 * Stop over the same findings reads it back and stays quiet.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { appendClaimEvent } from "../../src/core/brain/truth/store.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { HYGIENE_DIGEST_HASH_FILENAME } from "../../hooks/lib/hygiene-digest-state.ts";
import { homeEnv } from "../helpers/platform.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "hygiene-digest.ts",
);

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

test("the ledger is written outside the vault", async () => {
  env = makeStoreEnv("osb-hygiene-store-only-", { legacyTree: false, dualWrite: false });
  const now = Date.now();
  for (const [hours, agent, value, source] of [
    [48, "agent-a", "Berlin", "[[note-a]]"],
    [24, "agent-b", "Lisbon", "[[note-b]]"],
  ] as const) {
    appendClaimEvent(env.vault, {
      ts: new Date(now - hours * 3_600_000).toISOString(),
      agent,
      entity: "Acme Corp",
      aspect: "headquarters",
      value,
      source,
    });
  }
  const home = join(env.parent, "home");
  const transcript = join(home, ".claude", "projects", "session.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "add a file" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/tmp/x.md" } },
          ],
        },
      }),
    ].join("\n") + "\n",
  );
  const vault = env.vault;
  const runHook = async (): Promise<string> => {
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: home,
      env: {
        PATH: process.env["PATH"] ?? "",
        ...homeEnv(home),
        VAULT_DIR: vault,
        OPEN_SECOND_BRAIN_CONFIG: env!.configPath,
        [STORE_ROOT_ENV]: env!.storeRoot,
        O2B_DEVICE_ID: "dev-a",
        XDG_STATE_HOME: join(env!.parent, "state"),
        OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED: "true",
      },
    });
    proc.stdin.write(
      JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return stdout;
  };
  expect(await runHook()).toContain("Open Second Brain hygiene:");
  expect(existsSync(join(vault, ".open-second-brain"))).toBe(false);
  // The ledger landed in the device-local state, outside the vault ...
  const ledgers = readdirSync(env.parent, { recursive: true, encoding: "utf8" })
    .filter((rel) => basename(rel) === HYGIENE_DIGEST_HASH_FILENAME)
    .map((rel) => join(env!.parent, rel));
  expect(ledgers).toHaveLength(1);
  expect(ledgers[0]!.startsWith(vault)).toBe(false);
  // ... and is read back from there: the same findings stay quiet.
  expect(await runHook()).toBe("");
}, 30_000);

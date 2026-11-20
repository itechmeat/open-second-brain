/**
 * The answer-time quote check on a vault switched to the store, with its
 * legacy `Brain/` tree removed, through the real entry points: the
 * operator sets the phases with `o2b brain settings set`, the SessionStart
 * hook emits the digest and records what it emitted, and the Stop hook
 * finds those candidates, writes the `reply_presence` record and, on
 * `enforce`, the Brain-log event.
 *
 * Before the fix the setting was refused ("not a brain setting"), the
 * phases were read only from `Brain/_brain.yaml`, and the emitted ledger
 * was written only with recall-inject or re-delivery on, so the check had
 * no candidates and wrote nothing.
 */
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listContinuityRecords } from "../../src/core/brain/continuity/store.ts";
import { readAllLogEntries } from "../../src/core/brain/query.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { readActiveEmittedPaths } from "../../hooks/lib/injection-ledger.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { runCli } from "../helpers/run-cli.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HOOKS = join(REPO_ROOT, "hooks");
const SESSION = "switched-quote-session-1";
const RULE = "Always feed the otters before the herons.";
const INVENTED = "Never feed the otters on a Tuesday afternoon.";

let env: StoreEnv | null = null;
afterEach(async () => {
  // The session start spawns its maintenance detached; wait for it before
  // the fixture is removed. The fixture's environment is restored and its
  // folder removed even when that wait fails.
  try {
    if (env !== null) await waitForSelfHealChildren(env.vault);
  } finally {
    env?.cleanup();
    env = null;
  }
});

/** The environment a hook of this machine runs with: the defaults, no opt-in flag. */
function hookEnv(e: StoreEnv): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env as Record<string, string>).filter(
      ([key]) => !key.startsWith("OPEN_SECOND_BRAIN_"),
    ),
  );
  return {
    ...base,
    OPEN_SECOND_BRAIN_CONFIG: e.configPath,
    [STORE_ROOT_ENV]: e.storeRoot,
    [STORE_DUAL_WRITE_ENV]: process.env[STORE_DUAL_WRITE_ENV] ?? "",
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
    OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S: "0",
    // The synchronous form prints the annotation from the Stop hook itself.
    OPEN_SECOND_BRAIN_STOP_ADVISORY_DELIVERY: "sync",
    OPEN_SECOND_BRAIN_STOP_GUARDRAIL_ENABLED: "false",
  };
}

async function runHook(
  e: StoreEnv,
  name: string,
  payload: unknown,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  // The hook runs from the repository, not from inside the fixture: the
  // session start's detached search rebuild inherits this working
  // directory and outlives its own completion row by a moment, and on
  // Windows a folder that is a live process's working directory cannot
  // be removed (EBUSY in the cleanup). The payload's `cwd` still names
  // the vault.
  const proc = Bun.spawn(["bun", "run", join(HOOKS, `${name}.ts`)], {
    cwd: REPO_ROOT,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: hookEnv(e),
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exit: await proc.exited };
}

function cli(e: StoreEnv, args: ReadonlyArray<string>) {
  return runCli(args, { env: { OPEN_SECOND_BRAIN_CONFIG: e.configPath } });
}

test("set on a switched vault, the quote check finds the session start's notes and records the turn", async () => {
  env = makeStoreEnv("osb-quote-switched-", { legacyTree: false });
  switchDevice(env.storeRoot);
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);
  writePreference(env.vault, {
    slug: "otters-first",
    topic: "otters-first",
    principle: RULE,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-02T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-02T00:00:00Z",
    evidenced_by: ["[[sig-x]]"],
    confidence_value: 0.9,
  });

  // One after another: each write reads the settings the one before wrote.
  const sets = [];
  for (const phase of ["recall", "active", "subagent"]) {
    // oxlint-disable-next-line no-await-in-loop
    sets.push(await cli(env, ["brain", "settings", "set", `quote_check.${phase}`, "enforce"]));
  }
  for (const set of sets) {
    expect({ code: set.returncode, err: set.stderr }).toEqual({ code: 0, err: "" });
  }
  const get = await cli(env, ["brain", "settings", "get", "quote_check.active", "--json"]);
  expect(JSON.parse(get.stdout)).toMatchObject({ value: "enforce", source: "store" });
  // The settings command wrote no legacy tree back into the vault.
  expect(existsSync(join(env.vault, "Brain"))).toBe(false);

  const start = await runHook(env, "active-inject", {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: SESSION,
    cwd: env.vault,
  });
  expect({ exit: start.exit, stderr: start.stderr }).toEqual({ exit: 0, stderr: "" });
  expect(start.stdout).toContain(RULE);
  expect(readActiveEmittedPaths(env.vault, SESSION).has("Brain/active.md")).toBe(true);

  const transcript = join(env.parent, "transcript.jsonl");
  mkdirSync(env.parent, { recursive: true });
  const reply = `The rule says "${RULE}" and also "${INVENTED}"`;
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "what are the otter rules" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
      }),
    ].join("\n") + "\n",
  );
  const stop = await runHook(env, "answer-quote-check", {
    hook_event_name: "Stop",
    session_id: SESSION,
    transcript_path: transcript,
    cwd: env.vault,
    stop_hook_active: false,
  });
  expect({ exit: stop.exit, stderr: stop.stderr }).toEqual({ exit: 0, stderr: "" });
  // The invented quote is reported; the quoted rule is not.
  expect(stop.stdout).toContain("Tuesday afternoon");
  expect(stop.stdout).not.toContain("herons");

  const presence = listContinuityRecords(env.vault, { kind: "reply_presence" });
  expect(presence).toHaveLength(1);
  const payload = presence[0]!.payload as {
    session_id: string;
    per_note: ReadonlyArray<{ path: string; verdict: string }>;
  };
  expect(payload.session_id).toBe(SESSION);
  // The digest the session start emitted is read from the device-local
  // cache, not reported unavailable for lack of a `Brain/active.md` file.
  expect(payload.per_note.find((n) => n.path === "Brain/active.md")?.verdict).toBe("verified");

  const enforced = readAllLogEntries(env.vault).filter((event) =>
    JSON.stringify(event).includes("answer-quote-check"),
  );
  expect(enforced).toHaveLength(1);
});

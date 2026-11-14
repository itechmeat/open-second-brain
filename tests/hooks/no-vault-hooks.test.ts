/**
 * Every hook on a machine with no vault (design D14, task 2.10): a hook
 * does the store-side part of its job and skips the vault part. Each one
 * exits 0 with its usual output shape, writes what it writes to the
 * store, and changes nothing under the test's parent (the vault folder,
 * HOME, the config, the working directory) outside the sandboxed state
 * and store. The hooks with store-side work (active context, capture, log
 * catch-up, gaps, sub-agent context) have a behaviour test each; the
 * matrix runs every hook `hooks/hooks.json` registers.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendLogEvent } from "../../src/core/brain/log.ts";
import { writePreference } from "../../src/core/brain/preference.ts";
import { emitRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";
import { noVaultRoot } from "../../src/core/platform-dirs.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";
import { treeEntries } from "../helpers/vault-digest.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOKS = join(import.meta.dir, "..", "..", "hooks");

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

function noVaultEnv(prefix: string): StoreEnv {
  const made = makeStoreEnv(prefix, { legacyTree: false, configureVault: false });
  // A store-only machine with no vault: the vault folder the fixture made is not configured.
  // HOME exists, as on a real machine, so only what a run writes into it shows.
  mkdirSync(join(made.parent, "home"), { recursive: true });
  return made;
}

/**
 * The test process's environment without the product's opt-in flags a
 * developer shell or CI runner may export (`OPEN_SECOND_BRAIN_*_ENABLED`,
 * `..._HOST_SETTINGS_BACKUP`, `..._VIEW_TARGET`): only the ones the
 * fixtures and the preload set pass, so every run starts from the defaults
 * and a case turns a flag on through `extra`.
 */
const HOST_SETTINGS_BACKUP_ENV = "OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP";

const FIXTURE_PRODUCT_ENV = new Set([
  "OPEN_SECOND_BRAIN_CONFIG",
  STORE_ROOT_ENV,
  STORE_DUAL_WRITE_ENV,
  "OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR",
]);

function hookBaseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env as Record<string, string>).filter(
      ([key]) => !key.startsWith("OPEN_SECOND_BRAIN_") || FIXTURE_PRODUCT_ENV.has(key),
    ),
  );
}

async function runHook(name: string, payload: unknown, cwd: string): Promise<RunResult> {
  return runHookEnv(name, payload, cwd, {});
}

async function runHookEnv(
  name: string,
  payload: unknown,
  cwd: string,
  extra: Record<string, string>,
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", join(HOOKS, `${name}.ts`)], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...hookBaseEnv(),
      OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
      OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S: "0",
      ...extra,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exit: await proc.exited };
}

function storeRecords(e: StoreEnv) {
  return (["shared", "private"] as const)
    .flatMap((p) => readPartition(join(e.storeRoot, p)))
    .flatMap((s) => s.all);
}

/**
 * The test parent's folders a hook run may write: the device-local state,
 * the store, and Bun's own transpiler cache under the sandboxed HOME (the
 * runtime starting the hook writes it, not the hook).
 */
const WRITABLE = ["state", "store", "home/.bun"];

/** Every entry under the test parent outside the state and the store. */
function outsideSandbox(e: StoreEnv): Map<string, string> {
  const entries = treeEntries(e.parent);
  for (const key of entries.keys()) {
    if (WRITABLE.some((dir) => key === dir || key.startsWith(`${dir}/`))) entries.delete(key);
  }
  return entries;
}

/**
 * Everything outside the state and the store is as it was `before`, and
 * the no-vault root (under the state) was never created: nothing has a
 * vault to write.
 */
function expectNothingOutside(e: StoreEnv, before: Map<string, string>): void {
  expect(outsideSandbox(e)).toEqual(before);
  expect(existsSync(noVaultRoot())).toBe(false);
}

/** The hook names `hooks/hooks.json` registers, from each command's `o2b-hook <name>` fallback. */
function registeredHooks(): string[] {
  const text = readFileSync(join(HOOKS, "hooks.json"), "utf8");
  return [
    ...new Set([...text.matchAll(/exec o2b-hook ([a-z][a-z-]*)/g)].map((m) => m[1]!)),
  ].toSorted();
}

describe("hooks with no vault", () => {
  test("active-inject injects the active context the store's folds render", async () => {
    env = noVaultEnv("osb-hook-novault-active-");
    writePreference(null, {
      slug: "otters",
      topic: "otters",
      principle: "Always feed the otters first.",
      created_at: "2026-11-01T00:00:00Z",
      unconfirmed_until: "2026-11-02T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-11-02T00:00:00Z",
      evidenced_by: ["[[sig-x]]"],
      confidence_value: 0.9,
    });
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const res = await runHook(
      "active-inject",
      { hook_event_name: "SessionStart", session_id: "s1", source: "startup", cwd },
      cwd,
    );
    expect({ exit: res.exit, stderr: res.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(res.stdout).toContain("Always feed the otters first.");
    expectNothingOutside(env, untouched);
    expect(storeRecords(env).length).toBeGreaterThan(0);
  });

  test("session-capture captures a marker into the store as a signal", async () => {
    env = noVaultEnv("osb-hook-novault-capture-");
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const proc = await runHookEnv(
      "session-capture",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "nv-session",
        prompt: "@osb feedback positive topic=novault principle=capture-without-a-vault",
      },
      cwd,
      { OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER: "0" },
    );
    expect({ exit: proc.exit, stderr: proc.stderr, stdout: proc.stdout }).toEqual({
      exit: 0,
      stderr: "",
      stdout: "",
    });
    const signals = storeRecords(env).filter((r) => r.kind === "signal");
    expect(JSON.stringify(signals)).toContain("capture-without-a-vault");
    expectNothingOutside(env, untouched);
  });

  /**
   * The payload and the flags that switch its work on, for every hook
   * `hooks/hooks.json` registers. A file path names a file inside the test
   * parent, never a real path of this machine.
   */
  const HOOK_CASES: Readonly<
    Record<
      string,
      { payload: (cwd: string) => Record<string, unknown>; flags: Record<string, string> }
    >
  > = {
    "active-inject": {
      payload: () => ({ hook_event_name: "SessionStart", source: "startup" }),
      flags: {},
    },
    "gap-agenda": {
      payload: () => ({ hook_event_name: "SessionStart", source: "startup" }),
      flags: { OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    },
    "backlog-nudge": {
      payload: () => ({ hook_event_name: "SessionStart", source: "startup" }),
      flags: { OPEN_SECOND_BRAIN_BACKLOG_NUDGE_ENABLED: "true" },
    },
    "log-catchup": {
      payload: () => ({ hook_event_name: "SessionStart", source: "startup" }),
      flags: { OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true" },
    },
    "view-render": {
      payload: () => ({ hook_event_name: "SessionStart", source: "startup" }),
      flags: {},
    },
    "recall-inject": {
      payload: () => ({ hook_event_name: "UserPromptSubmit", prompt: "what about otters?" }),
      flags: { OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    },
    "nav-inject": {
      payload: () => ({ hook_event_name: "UserPromptSubmit", prompt: "map" }),
      flags: { OPEN_SECOND_BRAIN_NAV_TIER_ENABLED: "true" },
    },
    "counterparty-brief": {
      payload: () => ({ hook_event_name: "UserPromptSubmit", prompt: "Ada said hi" }),
      flags: { OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED: "true" },
    },
    "reground-deliver": {
      payload: () => ({ hook_event_name: "UserPromptSubmit", prompt: "go" }),
      flags: { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" },
    },
    "pretool-orient": {
      payload: (cwd) => ({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: join(cwd, "x.md") },
      }),
      flags: { OPEN_SECOND_BRAIN_HOOK_STRICT_ENABLED: "true" },
    },
    "pretool-host-backup": {
      // A protected settings path, with no file to back up yet: the
      // enabled hook takes its predicate path and allows. The backup of
      // an existing file has its own test below.
      payload: (cwd) => ({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(cwd, ".claude", "settings.json"), content: "{}" },
      }),
      flags: { [HOST_SETTINGS_BACKUP_ENV]: "true" },
    },
    "post-write-reminder": {
      payload: (cwd) => ({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(cwd, "x.md") },
      }),
      flags: {},
    },
    "subagent-inject": {
      payload: () => ({ hook_event_name: "SubagentStart", agent_type: "general" }),
      flags: {},
    },
    "stop-log-guardrail": { payload: () => ({ hook_event_name: "Stop" }), flags: {} },
    "answer-quote-check": { payload: () => ({ hook_event_name: "Stop" }), flags: {} },
    "hygiene-digest": {
      payload: () => ({ hook_event_name: "Stop" }),
      flags: { OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED: "true" },
    },
    "gap-promote": {
      payload: () => ({ hook_event_name: "SessionEnd", reason: "exit" }),
      flags: { OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    },
    "session-capture": {
      payload: () => ({ hook_event_name: "SessionEnd", reason: "exit" }),
      flags: {},
    },
  };

  test("the matrix covers exactly the hooks hooks/hooks.json registers", () => {
    expect(Object.keys(HOOK_CASES).toSorted()).toEqual(registeredHooks());
  });

  // One run per hook, with its flags on: the enabled path runs everything
  // the default path runs and more. With nothing seeded there is nothing
  // for a hook to report; what each store-side hook does is asserted by
  // its behaviour test above or below.
  for (const name of registeredHooks()) {
    test(`${name} exits 0 and writes nothing outside the state and the store`, async () => {
      const hook = HOOK_CASES[name];
      expect(hook).toBeDefined();
      env = noVaultEnv(`osb-hook-novault-${name}-`);
      const cwd = join(env.parent, "work");
      mkdirSync(cwd, { recursive: true });
      const untouched = outsideSandbox(env);
      const res = await runHookEnv(
        name,
        { session_id: "nv-every", cwd, ...hook!.payload(cwd) },
        cwd,
        hook!.flags,
      );
      expect({ hook: name, exit: res.exit, stderr: res.stderr }).toEqual({
        hook: name,
        exit: 0,
        stderr: "",
      });
      // The output keeps the host's shape: nothing, or one JSON document.
      if (res.stdout.trim() !== "") expect(() => JSON.parse(res.stdout)).not.toThrow();
      expectNothingOutside(env, untouched);
    }, 30_000);
  }

  test("pretool-host-backup backs a settings file up beside it and writes nothing else", async () => {
    env = noVaultEnv("osb-hook-novault-hostbackup-");
    const cwd = join(env.parent, "work");
    const settings = join(cwd, ".claude", "settings.json");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(settings, '{"model":"x"}\n');
    const untouched = outsideSandbox(env);
    const res = await runHookEnv(
      "pretool-host-backup",
      {
        session_id: "nv-backup",
        cwd,
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: settings, content: "{}" },
      },
      cwd,
      { [HOST_SETTINGS_BACKUP_ENV]: "true" },
    );
    // A successful backup is silent: the write proceeds.
    expect(res).toEqual({ stdout: "", stderr: "", exit: 0 });
    const backups = join(cwd, ".claude", ".o2b-backups", "settings.json");
    const taken = readdirSync(backups);
    expect(taken).toHaveLength(1);
    expect(readFileSync(join(backups, taken[0]!), "utf8")).toBe('{"model":"x"}\n');
    // With no vault there is no receipt: the backup folder (and its
    // ignore marker) is the only change outside the state and the store.
    const changed = [...outsideSandbox(env).keys()].filter((key) => !untouched.has(key));
    expect(changed.every((key) => key.startsWith("work/.claude/.o2b-backups"))).toBe(true);
    expect(changed.length).toBeGreaterThan(0);
    for (const [key, value] of untouched) expect(outsideSandbox(env).get(key)).toBe(value);
    expect(existsSync(noVaultRoot())).toBe(false);
  }, 30_000);

  test("log-catchup hands over another agent's log lines from the store", async () => {
    env = noVaultEnv("osb-hook-novault-logcatchup-");
    // This device is "me" by its agent name; the line below is another agent's.
    writeFileSync(env.configPath, "agent_name: me-agent\n");
    appendLogEvent(null, {
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      eventType: "note",
      agent: "other-agent",
      body: { text: "Wombat milestone reached" },
    });
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const res = await runHookEnv(
      "log-catchup",
      { hook_event_name: "SessionStart", source: "startup", session_id: "nv-log", cwd },
      cwd,
      { OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED: "true" },
    );
    expect({ exit: res.exit, stderr: res.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(res.stdout).toContain("Wombat milestone reached");
    expectNothingOutside(env, untouched);
  });

  test("gap-promote turns recurring recall gaps into a gap task, and gap-agenda lists it", async () => {
    env = noVaultEnv("osb-hook-novault-gaps-");
    for (let i = 0; i < 3; i++) {
      emitRecallTelemetry(noVaultRoot(), {
        host: "test",
        channel: RECALL_CHANNEL.cli,
        mode: "search",
        status: "empty",
        durationMs: 0,
        resultCount: 0,
        gaps: ["platypus care"],
        createdAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      });
    }
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const flags = { OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" };
    const promoted = await runHookEnv(
      "gap-promote",
      { hook_event_name: "SessionEnd", reason: "exit", session_id: "nv-gap", cwd },
      cwd,
      flags,
    );
    expect({ exit: promoted.exit, stderr: promoted.stderr }).toEqual({ exit: 0, stderr: "" });
    const lanes = storeRecords(env).filter((r) => r.kind === "lane-entry");
    expect(lanes.map((r) => r.body["lane"])).toContain("gap-tasks");
    const agenda = await runHookEnv(
      "gap-agenda",
      { hook_event_name: "SessionStart", source: "startup", session_id: "nv-gap", cwd },
      cwd,
      flags,
    );
    expect(agenda.exit).toBe(0);
    expect(agenda.stdout).toContain("platypus care");
    expectNothingOutside(env, untouched);
  });

  test("session-capture records a session end in the store (log and continuity)", async () => {
    env = noVaultEnv("osb-hook-novault-sessionend-");
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const res = await runHookEnv(
      "session-capture",
      { hook_event_name: "SessionEnd", reason: "exit", session_id: "nv-end-1", cwd },
      cwd,
      { OPEN_SECOND_BRAIN_SESSION_CAPTURE_DEFER: "0" },
    );
    expect({ exit: res.exit, stderr: res.stderr, stdout: res.stdout }).toEqual({
      exit: 0,
      stderr: "",
      stdout: "",
    });
    // The lifecycle log event and the lineage ledger row landed in the store.
    const kinds = new Set(storeRecords(env).map((r) => r.kind));
    expect(kinds.has("log-event")).toBe(true);
    expect(kinds.has("ledger-row")).toBe(true);
    expectNothingOutside(env, untouched);
  });

  test("subagent-inject hands a sub-agent the store's active context", async () => {
    env = noVaultEnv("osb-hook-novault-subagent-");
    writePreference(null, {
      slug: "otters",
      topic: "otters",
      principle: "Always feed the otters first.",
      created_at: "2026-11-01T00:00:00Z",
      unconfirmed_until: "2026-11-02T00:00:00Z",
      status: "confirmed",
      confirmed_at: "2026-11-02T00:00:00Z",
      evidenced_by: ["[[sig-x]]"],
      confidence_value: 0.9,
    });
    const cwd = join(env.parent, "work");
    mkdirSync(cwd, { recursive: true });
    const untouched = outsideSandbox(env);
    const res = await runHook(
      "subagent-inject",
      {
        hook_event_name: "SubagentStart",
        session_id: "0b5d7c1e-6a3f-4c2e-9d8b-1a2b3c4d5e6f",
        agent_id: "agent-1",
        agent_type: "general",
        cwd,
      },
      cwd,
    );
    expect({ exit: res.exit, stderr: res.stderr }).toEqual({ exit: 0, stderr: "" });
    expect(res.stdout).toContain("Always feed the otters first.");
    expectNothingOutside(env, untouched);
  });
});

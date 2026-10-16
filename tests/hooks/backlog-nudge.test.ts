/**
 * The SessionStart backlog nudge hook (session-mining-economy,
 * t_0358af42).
 *
 * The hook answers one question at session start - how much of the
 * imported session backlog has never been distilled - and only when the
 * answer has CHANGED since the last time it was injected. The census is
 * the vault-side mining census, so no source log is ever hashed inside
 * the hook's budget; under the deadline the hook degrades to silence,
 * never to a fabricated number.
 *
 * Flag off is an immediate no-op with zero output: the session preamble
 * stays byte-identical. Every path exits 0.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { importSession } from "../../src/core/brain/sessions/import.ts";
import { recordSessionImports, sessionLedgerPath } from "../../src/core/brain/sessions/discover.ts";
import { sessionMiningLedgerPath } from "../../src/core/brain/session-mining-ledger.ts";
import { DERIVED_STORE_DIR } from "../../src/core/brain/path-constants.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { SESSION_RUNTIME_ID } from "../../src/core/runtime/host-facts.ts";
import { homeEnv } from "../helpers/platform.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
const NOW = new Date("2026-09-18T10:00:00Z");

let vault: string;
let configHome: string;
let sessionsDir: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-nudge-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-nudge-cfg-"));
  sessionsDir = mkdtempSync(join(tmpdir(), "o2b-nudge-sessions-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
  };
  const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, "backlog-nudge.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

/** The flag-on environment, built per call: `vault` moves with every test. */
function flagOn(): Record<string, string> {
  return { OPEN_SECOND_BRAIN_BACKLOG_NUDGE_ENABLED: "true", VAULT_DIR: vault };
}

const SESSION_START = { hook_event_name: "SessionStart" };

/** The state file: one overwrite-only count beside the hygiene digest. */
function statePath(): string {
  return join(vault, DERIVED_STORE_DIR, "backlog-nudge.count");
}

/** Session filenames stay unique across calls: the basename IS the identity. */
let seeded = 0;

/** Seed `n` imported, never-mined sessions, the way the import verb does. */
async function seedBacklog(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const path = join(sessionsDir, `backlog-${seeded}.jsonl`);
    seeded += 1;
    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        parentUuid: null,
        entrypoint: "cli",
        sessionId: `s-${seeded}`,
        uuid: `u-${seeded}`,
        timestamp: "2026-09-18T09:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: `backlog item ${seeded}` }] },
      }) + "\n",
      "utf8",
    );
    // Sequential on purpose: each importSession builds and consults its
    // own dedup index, and two concurrent imports would race the vault.
    // oxlint-disable-next-line no-await-in-loop
    await importSession(vault, path, { agent: "tester", now: NOW, recall: true });
    recordSessionImports(vault, [{ path, runtime: SESSION_RUNTIME_ID.claudeCode }]);
  }
}

interface InjectedPayload {
  readonly hookSpecificOutput?: {
    readonly hookEventName?: string;
    readonly additionalContext?: string;
  };
}

describe("backlog-nudge hook (SessionStart)", () => {
  test("flag off is an immediate no-op with zero output and no state", async () => {
    await seedBacklog(2);
    const r = await runHook(SESSION_START, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(statePath())).toBe(false);
  });

  test("flag on with a changed count injects one line naming the count", async () => {
    await seedBacklog(1);
    const r = await runHook(SESSION_START, flagOn());
    expect(r.exit).toBe(0);
    const payload = JSON.parse(r.stdout) as InjectedPayload;
    expect(payload.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput?.additionalContext).toMatch(/1 imported session\b/);
    expect(payload.hookSpecificOutput?.additionalContext).not.toMatch(/2 imported sessions/);
    // The state lands only after the emit, overwrite-only, size one.
    expect(readFileSync(statePath(), "utf8")).toBe("1\n");
  });

  test("an unchanged count stays silent", async () => {
    await seedBacklog(1);
    expect((await runHook(SESSION_START, flagOn())).stdout).not.toBe("");
    const again = await runHook(SESSION_START, flagOn());
    expect(again.exit).toBe(0);
    expect(again.stdout).toBe("");
  });

  test("a grown backlog re-arms the nudge", async () => {
    await seedBacklog(1);
    await runHook(SESSION_START, flagOn());
    await seedBacklog(1);
    const r = await runHook(SESSION_START, flagOn());
    const payload = JSON.parse(r.stdout) as InjectedPayload;
    expect(payload.hookSpecificOutput?.additionalContext).toMatch(/2 imported sessions/);
    expect(readFileSync(statePath(), "utf8")).toBe("2\n");
  });

  test("a drained backlog is recorded, not announced, and re-arms when it returns", async () => {
    await seedBacklog(1);
    expect((await runHook(SESSION_START, flagOn())).stdout).not.toBe("");

    // The backlog empties (the sessions were mined, or the import records
    // went away). A line announcing zero work is noise; the state still
    // moves, so the NEXT change is measured against zero.
    rmSync(sessionLedgerPath(vault));
    const drained = await runHook(SESSION_START, flagOn());
    expect(drained.exit).toBe(0);
    expect(drained.stdout).toBe("");
    expect(readFileSync(statePath(), "utf8")).toBe("0\n");

    await seedBacklog(1);
    const returned = await runHook(SESSION_START, flagOn());
    const payload = JSON.parse(returned.stdout) as InjectedPayload;
    expect(payload.hookSpecificOutput?.additionalContext).toMatch(/1 imported session\b/);
  }, 20000);

  test("a count of zero with no recorded state is silent too", async () => {
    const r = await runHook(SESSION_START, flagOn());
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(statePath(), "utf8")).toBe("0\n");
  });

  test("an event that cannot carry additionalContext gets nothing", async () => {
    await seedBacklog(1);
    const r = await runHook({ hook_event_name: "PostToolUse" }, flagOn());
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(statePath())).toBe(false);
  });

  test("no vault resolves to silence", async () => {
    const r = await runHook(SESSION_START, { OPEN_SECOND_BRAIN_BACKLOG_NUDGE_ENABLED: "true" });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("a corrupt census source degrades to silence, naming itself on stderr", async () => {
    await seedBacklog(1);
    mkdirSync(dirname(sessionMiningLedgerPath(vault)), { recursive: true });
    writeFileSync(sessionMiningLedgerPath(vault), "{ this is not json", "utf8");
    const r = await runHook(SESSION_START, flagOn());
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("backlog-nudge");
    expect(r.stderr).toContain("session mining ledger is corrupted JSON");
  });

  test("a corrupt state file reads as changed, so the next eligible session emits", async () => {
    await seedBacklog(1);
    mkdirSync(dirname(statePath()), { recursive: true });
    atomicWriteFileSync(statePath(), "not a count\n");
    const r = await runHook(SESSION_START, flagOn());
    expect(r.exit).toBe(0);
    expect(JSON.parse(r.stdout as string)).toBeDefined();
    expect(readFileSync(statePath(), "utf8")).toBe("1\n");
  });
});

/**
 * `reground-deliver` carrier (recall-injection-lifecycle, t_55ee804e):
 * hands out exactly one queued part of an oversized SessionStart payload
 * per PostToolUse or UserPromptSubmit event, under a try-once lock, and
 * stays silent everywhere else.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LEDGER_KEY_REGROUND, beginInjectionEpoch } from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath, readHookStamp } from "../../hooks/lib/session-state.ts";
import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { CHMOD_CANNOT_DENY, homeEnv } from "../helpers/platform.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "reground-deliver.ts",
);

/**
 * Modules a flag-off run must never load: the ledger, the lock and the audit
 * writer. (`fs-atomic.ts` is not listed: `config.ts`, which the flag check
 * needs, already imports it.)
 */
const HEAVY_MODULES = ["injection-ledger.ts", "session-state.ts", "sync-lockfile.ts", "audit.ts"];

/** Preload that reports every loaded module path on stderr at exit. */
const LOADED_PROBE = `process.on("exit", () => {
  process.stderr.write("LOADED:" + JSON.stringify(Object.keys(require.cache)) + "\\n");
});
`;

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
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(
  payload: unknown,
  env: Record<string, string> = {},
  preload: ReadonlyArray<string> = [],
): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", ...preload, HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(configHome),
      // The failed-take marker lives under the OS temp dir; keep it per test.
      TMPDIR: configHome,
      TEMP: configHome,
      TMP: configHome,
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

function seedQueue(sessionId: string = SESSION): void {
  const ok = beginInjectionEpoch(vault, sessionId, {
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

  test("flag off loads none of the ledger, lock or audit modules", async () => {
    seedQueue();
    const probe = join(configHome, "loaded-probe.ts");
    writeFileSync(probe, LOADED_PROBE);
    const r = await runHook(postTool(), {}, ["--preload", probe]);
    expect(r.exit).toBe(0);
    const line = r.stderr.split("\n").find((l) => l.startsWith("LOADED:"));
    expect(line).toBeDefined();
    const loaded = (JSON.parse(line!.slice("LOADED:".length)) as string[]).map((path) =>
      path.replaceAll("\\", "/"),
    );
    expect(loaded.some((path) => path.endsWith("hooks/reground-deliver.ts"))).toBe(true);
    for (const name of HEAVY_MODULES) {
      expect(loaded.filter((path) => path.endsWith(`/${name}`))).toEqual([]);
    }
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

  test("without a session id nothing is delivered, not even from the default scope", async () => {
    // The sessionless lane maps to the default scope file; a queue there must stay put.
    const defaultScope = "default";
    expect(hookStateFilePath(vault, defaultScope)).toBe(hookStateFilePath(vault, undefined));
    seedQueue(defaultScope);
    const before = readFileSync(hookStateFilePath(vault, undefined), "utf8");
    const r = await runHook({ hook_event_name: "PostToolUse", tool_name: "Read" }, REGROUND_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(readFileSync(hookStateFilePath(vault, undefined), "utf8")).toBe(before);
  });

  test("a tool call inside a sub-agent emits nothing and keeps the cursor", async () => {
    seedQueue();
    const queueBefore = readHookStamp(vault, SESSION, LEDGER_KEY_REGROUND);
    const r = await runHook(
      { ...postTool(), agent_id: "subagent-12345", agent_type: "security-reviewer" },
      REGROUND_ON,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(auditRecords()).toEqual([]);
    expect(readHookStamp(vault, SESSION, LEDGER_KEY_REGROUND)).toEqual(queueBefore);
    const main = await runHook(postTool(), REGROUND_ON);
    expect(contextOf(main, "PostToolUse")).toBe(PART_2);
  });

  test("a main thread started with --agent (agent_type, no agent_id) still gets its part", async () => {
    seedQueue();
    const r = await runHook({ ...postTool(), agent_type: "reviewer" }, REGROUND_ON);
    expect(contextOf(r, "PostToolUse")).toBe(PART_2);
  });

  test("a held scope lock emits nothing, audits no delivery and keeps the cursor", async () => {
    seedQueue();
    const queueBefore = readHookStamp(vault, SESSION, LEDGER_KEY_REGROUND);
    const lockPath = hookStateFilePath(vault, SESSION) + ".lock";
    writeFileSync(lockPath, "held by another process\n");
    try {
      const r = await runHook(postTool(), REGROUND_ON);
      expect(r.exit).toBe(0);
      expect(r.stdout).toBe("");
      expect(auditRecords()).toEqual([]);
      expect(readHookStamp(vault, SESSION, LEDGER_KEY_REGROUND)).toEqual(queueBefore);
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

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a failed take emits nothing and leaves a reground_take_failed audit line",
    async () => {
      seedQueue();
      const stateDir = dirname(hookStateFilePath(vault, SESSION));
      // A read-only state directory: the queue reads, the lock cannot be created.
      chmodSync(stateDir, 0o500);
      try {
        const r = await runHook(postTool(), REGROUND_ON);
        expect(r.exit).toBe(0);
        expect(r.stdout).toBe("");
      } finally {
        chmodSync(stateDir, 0o700);
      }
      const records = auditRecords();
      expect(records.map((record) => [record["action"], record["ok"]])).toEqual([
        ["reground_take_failed", false],
      ]);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a take that keeps failing audits only its first failure of the epoch",
    async () => {
      seedQueue();
      const stateDir = dirname(hookStateFilePath(vault, SESSION));
      chmodSync(stateDir, 0o500);
      try {
        await runHook(postTool(), REGROUND_ON);
        await runHook(postTool(), REGROUND_ON);
      } finally {
        chmodSync(stateDir, 0o700);
      }
      expect(auditRecords().map((record) => record["action"])).toEqual(["reground_take_failed"]);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a failed take under a new queue epoch is audited again",
    async () => {
      const stateDir = dirname(hookStateFilePath(vault, SESSION));
      const failOnce = async (): Promise<void> => {
        chmodSync(stateDir, 0o500);
        try {
          await runHook(postTool(), REGROUND_ON);
        } finally {
          chmodSync(stateDir, 0o700);
        }
      };
      seedQueue();
      await failOnce();
      expect(
        beginInjectionEpoch(vault, SESSION, {
          epoch: "compact:1760000000001",
          emittedPaths: [],
          regroundParts: [PART_2, PART_3],
          partCeilingChars: 9000,
        }),
      ).toBe(true);
      await failOnce();
      expect(auditRecords().map((record) => record["details"])).toEqual([
        { epoch: EPOCH },
        { epoch: "compact:1760000000001" },
      ]);
    },
  );

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a symlink planted at the failed-take marker name is not written through",
    async () => {
      seedQueue();
      const scope = createHash("sha256").update(`${vault}\0${SESSION}`).digest("hex").slice(0, 16);
      const victim = join(configHome, "victim.txt");
      writeFileSync(victim, "keep me");
      symlinkSync(victim, join(configHome, `o2b-reground-take-failed-${scope}`));
      const stateDir = dirname(hookStateFilePath(vault, SESSION));
      chmodSync(stateDir, 0o500);
      try {
        await runHook(postTool(), REGROUND_ON);
      } finally {
        chmodSync(stateDir, 0o700);
      }
      expect(readFileSync(victim, "utf8")).toBe("keep me");
      expect(auditRecords().map((record) => record["action"])).toEqual(["reground_take_failed"]);
      // A drifted marker formula would leave a second, regular marker here.
      const marker = `o2b-reground-take-failed-${scope}`;
      expect(
        readdirSync(configHome).filter((name) => name.startsWith("o2b-reground-take-failed-")),
      ).toEqual([marker]);
      expect(lstatSync(join(configHome, marker)).isSymbolicLink()).toBe(true);
    },
  );
});

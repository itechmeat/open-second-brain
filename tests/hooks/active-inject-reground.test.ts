/**
 * active-inject splits an oversized SessionStart payload
 * (recall-injection-lifecycle, t_55ee804e). With `reground_parts_enabled`
 * on and a runtime that has the `reground-deliver` carrier (Claude Code,
 * Codex), a payload past the part ceiling is emitted as part 1 and parts
 * 2..n are queued in the session ledger under the new epoch. Everything
 * else - the flag off, a payload that fits, another runtime - emits the
 * single payload exactly as before.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginInjectionEpoch,
  readActiveEmittedPaths,
  takeRegroundPart,
} from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

const SESSION = "reground-session-0001";
const REGROUND_ON = { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" };
const CLAUDE_TRANSCRIPT = "/home/u/.claude/projects/p/reground-session-0001.jsonl";
const CODEX_TRANSCRIPT = "/home/u/.codex/sessions/2026/10/04/rollout.jsonl";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-inject-reground-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-inject-reground-cfg-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(async () => {
  await waitForSelfHealChildren(vault);
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    ...homeEnv(configHome),
    OPEN_SECOND_BRAIN_RUNTIME_NOTICES: "false",
    VAULT_DIR: vault,
  };
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, exit };
}

function contextOf(r: RunResult): string {
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
}

function claudePayload(): Record<string, unknown> {
  return {
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: SESSION,
    transcript_path: CLAUDE_TRANSCRIPT,
  };
}

function codexPayload(): Record<string, unknown> {
  return {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: SESSION,
    transcript_path: CODEX_TRANSCRIPT,
  };
}

/** Standing rules plus an active body totalling about 20,000 chars. */
function writeLargeVault(): void {
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\nactive:\n  inject_budget_chars: 40000\n",
    "utf8",
  );
  const rules = Array.from({ length: 15 }, (_, i) => `- Standing rule ${i} `.padEnd(99, "r"));
  writeFileSync(join(vault, "Brain", "standing-rules.md"), rules.join("\n") + "\n", "utf8");
  const prefs = Array.from({ length: 185 }, (_, i) =>
    `- \`pref-n${i}\` (confidence: high (0.90)) — rule body `.padEnd(99, "b"),
  );
  writeFileSync(
    join(vault, "Brain", "active.md"),
    [
      "---",
      "kind: brain-active",
      "generated_at: 2026-05-15T10:00:00Z",
      "---",
      "",
      "# Active Brain Preferences",
      "",
      "## Confirmed (186)",
      "",
      ...prefs,
      "- `pref-late` — the last rule",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeSmallVault(): void {
  writeFileSync(
    join(vault, "Brain", "active.md"),
    "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (1)\n\n- `pref-foo` — Rule body\n",
    "utf8",
  );
}

/** Drain the queue the hook left behind. */
function drainQueue(): Array<{ part: string; index: number; total: number; epoch: string }> {
  const out: Array<{ part: string; index: number; total: number; epoch: string }> = [];
  for (;;) {
    const take = takeRegroundPart(vault, SESSION);
    if (take.status !== "part") {
      expect(take.status).toBe("empty");
      return out;
    }
    out.push({ part: take.part, index: take.index, total: take.total, epoch: take.epoch });
  }
}

interface ReceiptRecord {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}

function injectionPayload(): Record<string, unknown> {
  const dir = join(vault, "Brain", "log", "continuity");
  const out: ReceiptRecord[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as ReceiptRecord);
      }
    }
  }
  const receipts = out.filter(
    (r) => r.kind === "context_receipt" && r.payload["trigger"] === "session_inject",
  );
  expect(receipts.length).toBe(1);
  return receipts[0]!.payload["injection"] as Record<string, unknown>;
}

describe("active-inject chunked re-delivery", () => {
  test("a Claude Code payload past the ceiling emits part 1 and queues parts 2..n", async () => {
    writeLargeVault();
    const r = await runHook(claudePayload(), REGROUND_ON);
    expect(r.exit).toBe(0);
    const first = contextOf(r);
    expect(first.length).toBeLessThanOrEqual(9000);
    expect(first.startsWith("[Open Second Brain context - part 1 of ")).toBe(true);
    expect(first).toContain("## Operator standing rules");

    const queued = drainQueue();
    expect(queued.length).toBeGreaterThanOrEqual(2);
    const total = queued[0]!.total;
    expect(total).toBe(queued.length + 1);
    queued.forEach((entry, i) => {
      expect(entry.index).toBe(i + 2);
      expect(entry.epoch.startsWith("compact:")).toBe(true);
      expect(entry.part.length).toBeLessThanOrEqual(9000);
      expect(entry.part.startsWith(`[Open Second Brain context - part ${i + 2} of ${total}]`)).toBe(
        true,
      );
    });
    expect(queued.at(-1)!.part).toContain("pref-late");
  });

  test("a Codex payload is split the same way", async () => {
    writeLargeVault();
    const r = await runHook(codexPayload(), REGROUND_ON);
    expect(r.exit).toBe(0);
    expect(contextOf(r).startsWith("[Open Second Brain context - part 1 of ")).toBe(true);
    expect(drainQueue().length).toBeGreaterThanOrEqual(2);
  });

  test("a smaller per-runtime ceiling produces more parts", async () => {
    writeLargeVault();
    await runHook(claudePayload(), REGROUND_ON);
    const standard = drainQueue().length;

    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "5000",
    });
    expect(r.exit).toBe(0);
    expect(contextOf(r).length).toBeLessThanOrEqual(5000);
    const smaller = drainQueue();
    expect(smaller.length).toBeGreaterThan(standard);
    for (const entry of smaller) expect(entry.part.length).toBeLessThanOrEqual(5000);
  });

  test("a Codex ceiling key bounds every Codex part", async () => {
    writeLargeVault();
    const r = await runHook(codexPayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CODEX: "5000",
    });
    expect(r.exit).toBe(0);
    expect(contextOf(r).length).toBeLessThanOrEqual(5000);
    const queued = drainQueue();
    expect(queued.length).toBeGreaterThanOrEqual(2);
    for (const entry of queued) expect(entry.part.length).toBeLessThanOrEqual(5000);
    expect(injectionPayload()["part_ceiling_chars"]).toBe(5000);
  });

  test("the Claude Code ceiling key does not apply to Codex", async () => {
    writeLargeVault();
    const r = await runHook(codexPayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "5000",
    });
    expect(r.exit).toBe(0);
    expect(contextOf(r).length).toBeGreaterThan(5000);
    expect(injectionPayload()["part_ceiling_chars"]).toBe(9000);
  });

  test("a rejected ceiling value is named on the receipt by its source", async () => {
    writeLargeVault();
    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "1999",
    });
    expect(r.exit).toBe(0);
    const injection = injectionPayload();
    expect(injection["part_ceiling_chars"]).toBe(9000);
    expect(injection["config_invalid"]).toEqual([
      "OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE",
    ]);
  });

  test("grok-shaped and unknown payloads emit the single full payload and queue nothing", async () => {
    writeLargeVault();
    const off = await runHook(claudePayload());
    const full = contextOf(off);
    expect(full.length).toBeGreaterThan(9000);

    const grok = await runHook(
      { hook_event_name: "SessionStart", hookEventName: "SessionStart", session_id: SESSION },
      REGROUND_ON,
    );
    expect(contextOf(grok)).toBe(full);
    expect(drainQueue()).toEqual([]);

    const unknown = await runHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
      REGROUND_ON,
    );
    expect(contextOf(unknown)).toBe(full);
    expect(drainQueue()).toEqual([]);
  });

  test("under the ceiling the output is byte-identical with the flag on", async () => {
    writeSmallVault();
    const off = await runHook(claudePayload());
    const on = await runHook(claudePayload(), REGROUND_ON);
    expect(on.stdout).toBe(off.stdout);
    expect(drainQueue()).toEqual([]);
  });

  test("the receipt carries the meter fields when the flag is on", async () => {
    writeLargeVault();
    const r = await runHook(claudePayload(), REGROUND_ON);
    expect(r.exit).toBe(0);
    const queued = drainQueue();
    const injection = injectionPayload();
    expect(injection["part_ceiling_chars"]).toBe(9000);
    expect(injection["parts_total"]).toBe(queued.length + 1);
    expect(injection["parts_dropped"]).toBe(0);
    expect(injection["over_budget"]).toBe(false);
    expect(injection["config_invalid"]).toBeUndefined();
    const utf16 = injection["utf16_chars"] as number;
    expect(utf16).toBeGreaterThan(9000);
  });

  test("with the flag off the receipt keeps its existing shape", async () => {
    writeLargeVault();
    const r = await runHook(claudePayload());
    expect(r.exit).toBe(0);
    const context = contextOf(r);
    expect(injectionPayload()).toEqual({
      hook_event: "SessionStart",
      loader_source: "fresh",
      sources_measured: true,
      total_bytes: Buffer.byteLength(context, "utf8"),
      total_tokens: Math.ceil(Buffer.byteLength(context, "utf8") / 4),
    });
  });

  test("the emitted set includes pref paths from the queued parts", async () => {
    writeLargeVault();
    const r = await runHook(claudePayload(), REGROUND_ON);
    expect(r.exit).toBe(0);
    expect(contextOf(r)).not.toContain("pref-late");
    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/preferences/pref-late.md")).toBe(true);
    expect(emitted.has("Brain/preferences/pref-n0.md")).toBe(true);
  });

  test("a queue that cannot be written falls back to the whole payload", async () => {
    writeLargeVault();
    const off = await runHook(claudePayload());
    // Only the fallback run's receipt is under test.
    rmSync(join(vault, "Brain", "log", "continuity"), { recursive: true, force: true });
    // A regular file where the state directory belongs makes every write fail.
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(join(vault, ".open-second-brain", "hook-state"), "not a directory", "utf8");

    const r = await runHook(claudePayload(), REGROUND_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe(off.stdout);
    const injection = injectionPayload();
    expect(injection["parts_total"]).toBe(1);
    expect(injection["parts_dropped"]).toBe(0);
    expect(injection["over_budget"]).toBe(true);
    expect(injection["reground_fallback"]).toBe("ledger_write_failed");
  });

  test("a UserPromptSubmit run past the ceiling emits the whole context and queues nothing", async () => {
    writeLargeVault();
    const whole = contextOf(await runHook(claudePayload()));
    const r = await runHook(
      { ...claudePayload(), hook_event_name: "UserPromptSubmit" },
      REGROUND_ON,
    );
    expect(r.exit).toBe(0);
    expect(contextOf(r)).toBe(whole);
    expect(existsSync(join(vault, ".open-second-brain", "hook-state"))).toBe(false);
  });

  test("a SessionStart source outside the host's set is recorded as unknown", async () => {
    writeLargeVault();
    const r = await runHook({ ...claudePayload(), source: "x/../not-a-source" }, REGROUND_ON);
    expect(r.exit).toBe(0);
    const queued = drainQueue();
    expect(queued.length).toBeGreaterThanOrEqual(1);
    for (const entry of queued) expect(entry.epoch.startsWith("unknown:")).toBe(true);
  });

  test("when every ledger write fails, the earlier queue outlives the whole-payload fallback", async () => {
    // Documents the accepted behaviour: the fallback retries the epoch write
    // with the unsplit delivery, which clears the earlier queue after a
    // transient failure; a lock held through both attempts leaves it.
    writeLargeVault();
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: [],
        regroundParts: ["[Open Second Brain context - part 2 of 2]\n\nold"],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    const off = await runHook(claudePayload());
    const lock = hookStateFilePath(vault, SESSION) + ".lock";
    writeFileSync(lock, "held by the test\n", "utf8");
    const r = await runHook(claudePayload(), REGROUND_ON);
    rmSync(lock, { force: true });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe(off.stdout);
    const queued = drainQueue();
    expect(queued.map((entry) => entry.epoch)).toEqual(["startup:1"]);
  });

  test("a split that fits needs no fallback marker", async () => {
    writeLargeVault();
    await runHook(claudePayload(), REGROUND_ON);
    expect(injectionPayload()["reground_fallback"]).toBeUndefined();
  });

  test("parts dropped past the cap are absent from the emitted set", async () => {
    writeLargeVault();
    writeFileSync(join(vault, "Brain", "lessons.md"), "# Lessons\n\n- Lesson one\n", "utf8");
    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "2000",
    });
    expect(r.exit).toBe(0);
    const queued = drainQueue();
    const committed = [contextOf(r), ...queued.map((entry) => entry.part)].join("\n\n");
    expect(injectionPayload()["parts_dropped"]).toBeGreaterThan(0);
    expect(committed).not.toContain("pref-late");

    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/preferences/pref-n0.md")).toBe(true);
    expect(emitted.has("Brain/preferences/pref-late.md")).toBe(false);
    // Every recorded pref was actually committed for delivery.
    for (const path of emitted) {
      const slug = /^Brain\/preferences\/(pref-[^/]+)\.md$/.exec(path)?.[1];
      if (slug !== undefined) expect(committed).toContain(`\`${slug}\``);
    }
    // The memory bodies did not survive whole, so neither counts as emitted.
    expect(emitted.has("Brain/active.md")).toBe(false);
    expect(emitted.has("Brain/lessons.md")).toBe(false);
  });

  test("a dropped body whose last line is a fragment of a committed line is not emitted", async () => {
    writeLargeVault();
    // The last line is a substring of the committed standing rule line, not a line of its own.
    writeFileSync(
      join(vault, "Brain", "lessons.md"),
      "# Lessons\n\n- Lesson one\nStanding rule 0\n",
      "utf8",
    );
    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "2000",
    });
    expect(r.exit).toBe(0);
    const committed = [contextOf(r), ...drainQueue().map((entry) => entry.part)].join("\n\n");
    expect(injectionPayload()["parts_dropped"]).toBeGreaterThan(0);
    expect(committed).toContain("Standing rule 0");
    expect(committed).not.toContain("Lesson one");
    expect(readActiveEmittedPaths(vault, SESSION).has("Brain/lessons.md")).toBe(false);
  });

  test("a dropped body whose last line repeats a committed line is not emitted", async () => {
    writeLargeVault();
    // The last line equals a whole committed standing rule line, so only the
    // body's position in the payload can tell that the body was cut.
    const repeated = "- Standing rule 0 ".padEnd(99, "r");
    writeFileSync(
      join(vault, "Brain", "lessons.md"),
      `# Lessons\n\n- Lesson one\n${repeated}\n`,
      "utf8",
    );
    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "2000",
    });
    expect(r.exit).toBe(0);
    const committed = [contextOf(r), ...drainQueue().map((entry) => entry.part)].join("\n\n");
    expect(injectionPayload()["parts_dropped"]).toBeGreaterThan(0);
    expect(committed.split("\n")).toContain(repeated);
    expect(committed).not.toContain("Lesson one");
    expect(readActiveEmittedPaths(vault, SESSION).has("Brain/lessons.md")).toBe(false);
  });

  test("a body delivered whole before the dropped tail is still emitted", async () => {
    writeSmallVault();
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 40000\n",
      "utf8",
    );
    const lessons = Array.from({ length: 250 }, (_, i) => `- Lesson ${i} `.padEnd(99, "l"));
    writeFileSync(
      join(vault, "Brain", "lessons.md"),
      ["# Lessons", "", ...lessons, ""].join("\n"),
      "utf8",
    );
    const r = await runHook(claudePayload(), {
      ...REGROUND_ON,
      OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_CLAUDECODE: "2000",
    });
    expect(r.exit).toBe(0);
    drainQueue();
    expect(injectionPayload()["parts_dropped"]).toBeGreaterThan(0);
    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/active.md")).toBe(true);
    expect(emitted.has("Brain/lessons.md")).toBe(false);
  });
});

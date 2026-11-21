/**
 * The session start digest ends in ONE truncation note.
 *
 * The field check found three notes stacked in one digest: the pinned
 * context's own cut line, the active body's notice, and a third from the
 * host-limit guard, which cut the payload again because the active
 * body's notice rode on top of a budget that already filled the host's
 * room. Each lane is now budgeted without a note of its own, the note's
 * room comes off the ceiling before the lanes are sized, and the payload
 * ends in one note that says what was cut in total, how many rule lines
 * and sections and how much pinned context are missing, and which call
 * returns the full set. The same holds for a Codex session, whose
 * SessionStart runs the same hook.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_CONTEXT_CEILING_CHARS, utf8Bytes } from "../../hooks/lib/host-context-ceiling.ts";
import { detectHookRuntime } from "../../hooks/lib/detect.ts";
import { readActiveEmittedPaths } from "../../hooks/lib/injection-ledger.ts";
import { readInjectCache, writeInjectCache } from "../../src/core/brain/inject-failopen.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";
import { lingerGuardEnv } from "../helpers/hook-linger.ts";
import { TEST_DEVICE_ID } from "../helpers/test-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

const NOTE_OPEN = "_Injection truncated to budget:";
const RULES = 300;

let parent: string;
let vault: string;
let projectDir: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "o2b-one-note-"));
  vault = join(parent, "vault");
  projectDir = join(parent, "work", "o2b");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(parent, "home"), { recursive: true });
  writeFileSync(join(projectDir, ".o2b-vault.json"), JSON.stringify({ vault }));
});

afterEach(async () => {
  await waitForSelfHealChildren(vault);
  rmSync(parent, { recursive: true, force: true });
});

const ENGLISH = "keep the wording plain and the claims sourced ";
/** The same rule in Russian: two UTF-8 bytes a letter, as in the field vault. */
const RUSSIAN = "пиши просто и подтверждай каждое утверждение ";

function rules(prefix: string, count: number, phrase: string): string[] {
  return Array.from(
    { length: count },
    (_, i) =>
      `- \`pref-${prefix}-${i}\` (scope: writing, confidence: high (0.9)) — ` +
      `Rule ${prefix} ${i}: ${phrase.repeat(3)}`,
  );
}

/**
 * The field's shape: a few hundred confirmed rules and two more sections,
 * a pinned context twenty times its cap, and standing rules large enough
 * that the host's room, not the product budget, binds the memory body.
 */
function writeFieldVault(phrase: string = ENGLISH): void {
  writeFileSync(
    join(vault, "Brain", "active.md"),
    [
      "---",
      "kind: brain-active",
      "generated_at: 2026-11-20T10:00:00Z",
      "---",
      "",
      "# Active Brain Preferences",
      "",
      `## Confirmed (${RULES})`,
      "",
      ...rules("confirmed", RULES, phrase),
      "",
      "## Most-applied (30d) (10)",
      "",
      ...rules("applied", 10, phrase),
      "",
      "## Quarantined (40)",
      "",
      ...rules("quarantined", 40, phrase),
      "",
    ].join("\n"),
  );
  writeFileSync(join(vault, "Brain", "pinned.md"), "pinned context words ".repeat(1000));
  writeFileSync(
    join(vault, "Brain", "standing-rules.md"),
    Array.from({ length: 40 }, (_, i) => `- STANDING-PROBE-${i}: never skip the review.`).join(
      "\n",
    ),
  );
}

async function runHook(
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(join(parent, "home")),
      VAULT_DIR: vault,
      OPEN_SECOND_BRAIN_STORE_ROOT: join(parent, "store"),
      O2B_DEVICE_ID: TEST_DEVICE_ID,
      ...extraEnv,
      ...lingerGuardEnv(),
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).toBe(0);
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

/** Every check the one-note contract makes on an emitted digest. */
function expectOneHonestNote(context: string): void {
  expect(context.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
  // One note, and it is the payload's last line.
  expect(context.split(NOTE_OPEN).length - 1).toBe(1);
  expect(context).not.toContain("to fit the host's context limit");
  expect(context).not.toContain("Pinned context cut to budget");
  const note = context.slice(context.lastIndexOf("\n\n") + 2);
  expect(note.startsWith(NOTE_OPEN)).toBe(true);
  // The note's counts match what the payload carries.
  const delivered = context.split("\n").filter((line) => line.startsWith("- `pref-")).length;
  expect(delivered).toBeGreaterThan(0);
  const all = RULES + 10 + 40;
  expect(note).toContain(`Not shown: ${all - delivered} of ${all} rule lines, 2 of 3 sections`);
  expect(note).toMatch(/\d+ of 20999 characters of pinned context/);
  expect(note).toContain("Call `brain_context` for the full preference set and the pinned context");
  // The operator's rules and the first confirmed rules still reach the model.
  expect(context).toContain("STANDING-PROBE-39");
  expect(context).toContain("`pref-confirmed-0`");
}

describe("the session start digest ends in one truncation note", () => {
  test("the field case: the host's room binds and nothing is cut twice", async () => {
    writeFieldVault();
    const context = await runHook({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "one-note-claude",
      cwd: projectDir,
      transcript_path: `/home/u/.claude/projects/p/one-note-claude.jsonl`,
    });
    expectOneHonestNote(context);
  });

  test("a Codex SessionStart gets the same single note under the same limit", async () => {
    writeFieldVault();
    const payload = codexPayload();
    expect(detectHookRuntime(payload, { HOME: join(parent, "home") })).toBe("codex");
    const context = await runHook(payload);
    expectOneHonestNote(context);
    expectUnderCodexLimit(context);
  });

  test("Codex detection follows CODEX_HOME session roots without matching another host", () => {
    const relocated = {
      hook_event_name: "SessionStart",
      transcript_path: "/tmp/osb-codex/sessions/2026/11/rollout.jsonl",
    };
    expect(
      detectHookRuntime(relocated, { HOME: join(parent, "home"), CODEX_HOME: "/tmp/osb-codex" }),
    ).toBe("codex");
    expect(
      detectHookRuntime(relocated, {
        HOME: join(parent, "home"),
        CODEX_HOME: "/tmp/other-codex",
      }),
    ).toBe("unknown");
    expect(detectHookRuntime(codexPayload(), { HOME: join(parent, "home") })).toBe("codex");
  });

  test("relocated Codex sessions use the byte-counted ceiling", async () => {
    writeFieldVault(RUSSIAN);
    const context = await runHook(
      {
        ...codexPayload(),
        transcript_path: "/tmp/osb-codex/sessions/2026/11/rollout.jsonl",
      },
      { CODEX_HOME: "/tmp/osb-codex" },
    );
    expectOneHonestNote(context);
    expectUnderCodexLimit(context);
  });

  test("a Codex SessionStart on a Russian vault stays under Codex's byte-counted limit", async () => {
    // Codex spills a hook's context to a file once ceil(UTF-8 bytes / 4)
    // passes 2,500 tokens. A Russian rule costs two bytes a letter, so a
    // payload sized to 9,000 characters is about 16,000 bytes there.
    writeFieldVault(RUSSIAN);
    const context = await runHook(codexPayload());
    expectOneHonestNote(context);
    expectUnderCodexLimit(context);
  });

  test("Claude Code keeps its character measure on the same Russian vault", async () => {
    writeFieldVault(RUSSIAN);
    const context = await runHook({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "one-note-claude",
      cwd: projectDir,
      transcript_path: `/home/u/.claude/projects/p/one-note-claude.jsonl`,
    });
    expectOneHonestNote(context);
    // Claude Code counts characters, so the payload uses that room: more
    // bytes than Codex would take, and still under its character cap.
    expect(utf8Bytes(context)).toBeGreaterThan(HOST_CONTEXT_CEILING_CHARS);
  });

  test("a payload served from the last good copy ends in the note its run wrote", async () => {
    writeFieldVault();
    const payload = {
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "one-note-claude",
      cwd: projectDir,
      transcript_path: `/home/u/.claude/projects/p/one-note-claude.jsonl`,
    };
    const fresh = await runHook(payload);
    // An active.md that cannot be read: the memory context comes from the cache.
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));
    const cached = await runHook(payload);
    expect(cached).toBe(fresh);
    expectOneHonestNote(cached);
  });

  test("cached memory ignores a stale separately written cuts record", async () => {
    writeFieldVault();
    const payload = {
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "one-note-claude",
      cwd: projectDir,
      transcript_path: `/home/u/.claude/projects/p/one-note-claude.jsonl`,
    };
    const fresh = await runHook(payload);
    const cache = join(vault, ".open-second-brain", "inject-cache");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "active-cuts.txt"), "[]");
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));
    const cached = await runHook(payload);
    expect(cached).toBe(fresh);
    expectOneHonestNote(cached);
  });

  test("a host cut that removes only the cached cut note keeps the memory path emitted", async () => {
    writeFieldVault();
    const payload = {
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: "one-note-claude",
      cwd: projectDir,
      transcript_path: `/home/u/.claude/projects/p/one-note-claude.jsonl`,
    };
    const fresh = await runHook(payload);
    const raw = readInjectCache(vault, "active");
    expect(raw).not.toBeNull();
    const snapshot = JSON.parse(raw!) as { version: number; context: string; cuts: unknown[] };
    const padding = HOST_CONTEXT_CEILING_CHARS + 1 - fresh.length;
    expect(padding).toBeGreaterThan(0);
    snapshot.context += "x".repeat(padding);
    writeInjectCache(vault, "active", JSON.stringify(snapshot));
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));

    const cached = await runHook(payload);
    expect(cached.length).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
    expect(cached).toContain("to fit the host's context limit");
    expect(readActiveEmittedPaths(vault, "one-note-claude").has("Brain/active.md")).toBe(true);
  });
});

/**
 * The payload Codex sends to a SessionStart hook: its transcript lives
 * under the Codex sessions directory, which is how the hook tells it from
 * Claude Code. The path is inside the test's own temporary home; nothing
 * here touches a real ~/.codex.
 */
function codexPayload(): Record<string, unknown> {
  return {
    hook_event_name: "SessionStart",
    source: "startup",
    session_id: "019a0000-0000-7000-8000-000000000001",
    cwd: projectDir,
    model: "gpt-5-codex",
    transcript_path: join(
      parent,
      "home",
      ".codex",
      "sessions",
      "2026",
      "11",
      "21",
      "rollout-2026-11-21T10-00-00-019a0000-0000-7000-8000-000000000001.jsonl",
    ),
  };
}

/** Codex's own limit: ceil(UTF-8 bytes / 4) tokens at most 2,500, less the 10% margin. */
function expectUnderCodexLimit(context: string): void {
  expect(utf8Bytes(context)).toBeLessThanOrEqual(HOST_CONTEXT_CEILING_CHARS);
  expect(Math.ceil(utf8Bytes(context) / 4)).toBeLessThanOrEqual(2500);
}

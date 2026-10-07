/**
 * active-inject records the injection epoch (recall-injection-lifecycle,
 * t_5528ab98 / t_e9da6b7e R2): every emitting SessionStart writes the
 * preference paths it actually delivered into the per-session ledger and
 * clears the recall set, so recall-inject neither repeats the digest nor
 * carries dedupe state across a compaction.
 *
 * The ledger is written only when a consumer exists (`recall_inject_enabled`
 * or `reground_parts_enabled`) and the host sent a real session id; a default
 * install gets no new disk write. Every write is fail-soft.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginInjectionEpoch,
  readActiveEmittedPaths,
  readRecallInjected,
  recordRecallInjected,
  takeRegroundPart,
} from "../../hooks/lib/injection-ledger.ts";
import { homeEnv } from "../helpers/platform.ts";
import { waitForSelfHealChildren } from "../helpers/self-heal-children.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "active-inject.ts",
);

const SESSION = "ledger-session-0001";
const RECALL_ON = { OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" };

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-inject-ledger-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-inject-ledger-cfg-"));
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

function writeActive(body: string): void {
  writeFileSync(join(vault, "Brain", "active.md"), body, "utf8");
}

function hookStateDir(): string {
  return join(vault, ".open-second-brain", "hook-state");
}

const ACTIVE_BODY =
  "---\nkind: brain-active\ngenerated_at: 2026-05-15T10:00:00Z\n---\n\n# Active Brain Preferences\n\n## Confirmed (2)\n\n- `pref-foo` — Rule foo\n- `pref-bar` — Rule bar\n";

/** A confirmed head that fits a 500-char budget and a retired tail that does not. */
function budgetedActiveBody(): string {
  const filler = Array.from(
    { length: 12 },
    (_, i) => `- \`pref-pad${i}\` — low_confidence on 2026-05-01`,
  );
  return [
    "---",
    "kind: brain-active",
    "generated_at: 2026-05-15T10:00:00Z",
    "---",
    "",
    "# Active Brain Preferences",
    "",
    "## Confirmed (1)",
    "",
    "- `pref-keep` — Kept rule",
    "",
    "## Recently retired (last 13)",
    "",
    ...filler,
    "- `pref-cut` — low_confidence on 2026-05-01",
    "",
  ].join("\n");
}

describe("active-inject injection ledger", () => {
  test("records the emitted pref paths and clears the recall set", async () => {
    writeActive(ACTIVE_BODY);
    recordRecallInjected(vault, SESSION, [":Brain/notes/a.md#L1-L4"]);
    expect(readRecallInjected(vault, SESSION).size).toBe(1);

    const r = await runHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("pref-foo");

    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/preferences/pref-foo.md")).toBe(true);
    expect(emitted.has("Brain/preferences/pref-bar.md")).toBe(true);
    expect(emitted.has("Brain/active.md")).toBe(true);
    expect(readRecallInjected(vault, SESSION).size).toBe(0);
  });

  test("a SessionStart with nothing to emit still clears the recall set", async () => {
    recordRecallInjected(vault, SESSION, [":Brain/notes/a.md#L1-L4"]);
    const r = await runHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(readRecallInjected(vault, SESSION).size).toBe(0);
  });

  test("a SessionStart with nothing to emit drops the earlier re-delivery queue", async () => {
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: ["Brain/preferences/pref-old.md"],
        regroundParts: ["[Open Second Brain context - part 2 of 2]\n\nold"],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    const r = await runHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: SESSION },
      { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(takeRegroundPart(vault, SESSION)).toEqual({ status: "empty" });
    expect(readActiveEmittedPaths(vault, SESSION).size).toBe(0);
  });

  test("an empty SessionStart without a session id writes nothing", async () => {
    const r = await runHook({ hook_event_name: "SessionStart", source: "compact" }, RECALL_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(hookStateDir())).toBe(false);
  });

  test("a UserPromptSubmit run injects but starts no epoch", async () => {
    writeActive(ACTIVE_BODY);
    recordRecallInjected(vault, SESSION, ["k"]);
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("pref-foo");
    expect([...readRecallInjected(vault, SESSION)]).toEqual(["k"]);
    expect(readActiveEmittedPaths(vault, SESSION).size).toBe(0);
  });

  test("a UserPromptSubmit run with nothing to emit keeps the queue and the recall set", async () => {
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: ["Brain/preferences/pref-old.md"],
        regroundParts: ["[Open Second Brain context - part 2 of 2]\n\nold"],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    recordRecallInjected(vault, SESSION, ["k"]);
    const r = await runHook(
      { hook_event_name: "UserPromptSubmit", session_id: SESSION },
      { ...RECALL_ON, OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect([...readRecallInjected(vault, SESSION)]).toEqual(["k"]);
    expect([...readActiveEmittedPaths(vault, SESSION)]).toEqual(["Brain/preferences/pref-old.md"]);
    const take = takeRegroundPart(vault, SESSION);
    expect(take.status).toBe("part");
    if (take.status === "part") expect(take.epoch).toBe("startup:1");
  });

  test("the reground flag alone is a consumer too", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook(
      { hook_event_name: "SessionStart", source: "compact", session_id: SESSION },
      { OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(readActiveEmittedPaths(vault, SESSION).has("Brain/preferences/pref-foo.md")).toBe(true);
  });

  test("a preference cut by the budget is absent from the set", async () => {
    writeFileSync(
      join(vault, "Brain", "_brain.yaml"),
      "schema_version: 1\nactive:\n  inject_budget_chars: 500\n",
      "utf8",
    );
    writeActive(budgetedActiveBody());
    const r = await runHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("pref-keep");
    expect(r.stdout).not.toContain("pref-cut");

    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/preferences/pref-keep.md")).toBe(true);
    expect(emitted.has("Brain/preferences/pref-cut.md")).toBe(false);
  });

  test("with both flags off nothing is written and stdout is unchanged", async () => {
    writeActive(ACTIVE_BODY);
    const payload = { hook_event_name: "SessionStart", source: "startup", session_id: SESSION };
    const off = await runHook(payload);
    expect(off.exit).toBe(0);
    expect(existsSync(hookStateDir())).toBe(false);

    const on = await runHook(payload, RECALL_ON);
    expect(on.exit).toBe(0);
    expect(on.stdout).toBe(off.stdout);
  });

  test("without a session id nothing is written", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook({ hook_event_name: "SessionStart", source: "startup" }, RECALL_ON);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("pref-foo");
    expect(existsSync(hookStateDir())).toBe(false);
  });

  test("a startup SessionStart prunes a 10-day-old scope file", async () => {
    writeActive(ACTIVE_BODY);
    mkdirSync(hookStateDir(), { recursive: true });
    const stale = join(hookStateDir(), "aa-stale-scope.json");
    writeFileSync(stale, "{}", "utf8");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(stale, tenDaysAgo, tenDaysAgo);
    expect(statSync(stale).mtimeMs).toBeLessThan(Date.now() - 9 * 86_400_000);

    const r = await runHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(existsSync(stale)).toBe(false);
    expect(readActiveEmittedPaths(vault, SESSION).size).toBeGreaterThan(0);
  });

  test("a resume SessionStart does not prune", async () => {
    writeActive(ACTIVE_BODY);
    mkdirSync(hookStateDir(), { recursive: true });
    const stale = join(hookStateDir(), "aa-stale-scope.json");
    writeFileSync(stale, "{}", "utf8");
    const tenDaysAgo = (Date.now() - 10 * 86_400_000) / 1000;
    utimesSync(stale, tenDaysAgo, tenDaysAgo);

    const r = await runHook(
      { hook_event_name: "SessionStart", source: "resume", session_id: SESSION },
      RECALL_ON,
    );
    expect(r.exit).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  test("a ledger write failure leaves stdout unchanged and exits 0", async () => {
    writeActive(ACTIVE_BODY);
    const payload = { hook_event_name: "SessionStart", source: "startup", session_id: SESSION };
    const healthy = await runHook(payload);
    expect(healthy.exit).toBe(0);

    // A regular file where the state directory belongs makes every write fail.
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    writeFileSync(hookStateDir(), "not a directory", "utf8");

    const broken = await runHook(payload, RECALL_ON);
    expect(broken.exit).toBe(0);
    expect(broken.stdout).toBe(healthy.stdout);
  });

  test("a fresh load records Brain/active.md and omits an absent lessons body", async () => {
    writeActive(ACTIVE_BODY);
    const r = await runHook(startup(), RECALL_ON);
    expect(r.exit).toBe(0);
    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/active.md")).toBe(true);
    expect(emitted.has("Brain/lessons.md")).toBe(false);
  });

  test("a fresh load with a lessons body records both memory bodies", async () => {
    writeActive(ACTIVE_BODY);
    writeLessons();
    const r = await runHook(startup(), RECALL_ON);
    expect(r.stdout).toContain(LESSON_LINE);
    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/active.md")).toBe(true);
    expect(emitted.has("Brain/lessons.md")).toBe(true);
  });

  test("a last-good-cache load records both memory bodies", async () => {
    writeActive(ACTIVE_BODY);
    const fresh = await runHook(startup(), RECALL_ON);
    expect(fresh.stdout).toContain("pref-foo");
    // An active.md that cannot be read as a file makes the assembly throw,
    // so the loader serves the last-good cache.
    rmSync(join(vault, "Brain", "active.md"));
    mkdirSync(join(vault, "Brain", "active.md"));
    const cached = await runHook(startup(), RECALL_ON);
    expect(cached.stdout).toContain("pref-foo");
    const emitted = readActiveEmittedPaths(vault, SESSION);
    expect(emitted.has("Brain/active.md")).toBe(true);
    expect(emitted.has("Brain/lessons.md")).toBe(true);
  });
});

const LESSON_LINE = "- Lesson one: verify before claiming done";

function writeLessons(): void {
  writeFileSync(join(vault, "Brain", "lessons.md"), `# Lessons\n\n${LESSON_LINE}\n`, "utf8");
}

function startup(): Record<string, unknown> {
  return { hook_event_name: "SessionStart", source: "startup", session_id: SESSION };
}

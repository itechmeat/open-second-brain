/**
 * The real recall-inject hook entry over an indexed temp vault: per-session
 * dedupe through the injection ledger, the cross-lane digest filter, and
 * operator-declared slices from `_brain.yaml`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { recallInjectNoteKey } from "../../src/core/brain/recall-inject.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import {
  beginInjectionEpoch,
  readRecallInjected,
  recallNoteKey,
} from "../../hooks/lib/injection-ledger.ts";
import { homeEnv } from "../helpers/platform.ts";
import { createTempVault, writeMd } from "../helpers/search-fixtures.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "recall-inject.ts",
);
const PROMPT = "heron migration schedule";
const SESSION = "sess-dedupe-1";
const PREF_PATH = "Brain/preferences/pref-heron-watch.md";

let vault: string;
let cleanup: () => void;
let configPath: string;

beforeEach(async () => {
  ({ vault, cleanup } = createTempVault("recall-dedupe-hook"));
  writeMd(
    vault,
    "notes/schedule.md",
    "# Heron schedule\n\nThe heron migration schedule starts in October.",
  );
  writeMd(vault, "notes/nests.md", "# Heron nests\n\nHeron migration routes pass the river nests.");
  writeMd(
    vault,
    PREF_PATH,
    "---\ntype: preference\n---\n# Heron watch\n\nWatch the heron migration schedule at dawn.",
  );
  configPath = join(vault, ".o2b-test-config.yaml");
  writeConfig({});
  await indexVault(resolveSearchConfig({ vault, configPath }));
});
afterEach(() => cleanup());

function writeConfig(entries: Record<string, string>): void {
  const all = { search_recency_amplitude: "0", ...entries };
  writeFileSync(
    configPath,
    Object.entries(all)
      .map(([k, v]) => `${k}: "${v}"`)
      .join("\n") + "\n",
  );
}

interface HookRun {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(sessionId?: string, env: Record<string, string> = {}): Promise<HookRun> {
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      ...homeEnv(join(vault, ".home")),
      VAULT_DIR: vault,
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true",
      // Keep every audit record in the one legacy week shard (see the
      // decision-model hook suite), so "last record" means the last run.
      O2B_DEVICE_ID: "",
      ...env,
    },
  });
  const payload: Record<string, unknown> = { hook_event_name: "UserPromptSubmit", prompt: PROMPT };
  if (sessionId !== undefined) payload["session_id"] = sessionId;
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

function brief(run: HookRun): string {
  const out = JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } };
  return out.hookSpecificOutput.additionalContext;
}

function lastDetails(): Record<string, unknown> {
  const dir = hookAuditDir(vault);
  if (!existsSync(dir)) return {};
  const all = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted()
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    .filter((r) => r["actor"] === "recall-inject");
  return (all[all.length - 1]?.["details"] ?? {}) as Record<string, unknown>;
}

describe("recall-inject hook: per-session dedupe", () => {
  test("a repeated prompt in one session injects once, then abstains as already injected", async () => {
    const first = await runHook(SESSION);
    expect(first.exit).toBe(0);
    expect(brief(first)).toContain("notes/schedule.md");
    expect(readRecallInjected(vault, SESSION).size).toBeGreaterThan(0);

    const second = await runHook(SESSION);
    expect(second.exit).toBe(0);
    expect(second.stdout).toBe("");
    const details = lastDetails();
    expect(details["decision"]).toBe("abstain");
    expect(details["reason"]).toBe("all_already_injected");
    // The ledger the second run consulted held what the first run rendered.
    const deduped = details["deduped"] as { already_injected: number; digest_paths: number };
    expect(deduped.digest_paths).toBe(0);
    expect(deduped.already_injected).toBe(readRecallInjected(vault, SESSION).size);
    expect(deduped.already_injected).toBeGreaterThan(0);
  });

  test("without a session id both runs inject and no ledger is consulted", async () => {
    const first = await runHook();
    const second = await runHook();
    expect(brief(first)).toContain("notes/schedule.md");
    expect(second.stdout).toBe(first.stdout);
    expect(lastDetails()["deduped"]).toBeUndefined();
  });

  test("recall_inject_dedupe: false injects both times", async () => {
    writeConfig({ recall_inject_dedupe: "false" });
    const first = await runHook(SESSION);
    const second = await runHook(SESSION);
    expect(brief(first)).toContain("notes/schedule.md");
    expect(second.stdout).toBe(first.stdout);
  });

  test("a preference the SessionStart digest emitted is not recalled again", async () => {
    const control = await runHook("sess-control");
    expect(brief(control)).toContain(PREF_PATH);

    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: [PREF_PATH],
        regroundParts: [],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    const run = await runHook(SESSION);
    expect(run.exit).toBe(0);
    expect(brief(run)).not.toContain(PREF_PATH);
    expect(brief(run)).toContain("notes/schedule.md");
  });

  test("the ledger key and the core key agree for the same note", () => {
    const local = { path: "notes/a.md", startLine: 3, endLine: 9 };
    const remote = { ...local, origin: "team" };
    expect(recallNoteKey(local)).toBe(recallInjectNoteKey(local));
    expect(recallNoteKey(remote)).toBe(recallInjectNoteKey(remote));
  });
});

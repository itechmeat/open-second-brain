/**
 * The real recall-inject hook entry over an indexed temp vault: per-session
 * dedupe through the injection ledger, the cross-lane digest filter, and
 * operator-declared slices from `_brain.yaml`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hookAuditDir } from "../../src/core/brain/paths.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { beginInjectionEpoch, readRecallInjected } from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";
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
    const sets = details["dedupe_sets"] as { already_injected: number; digest_paths: number };
    expect(sets.digest_paths).toBe(0);
    expect(sets.already_injected).toBe(readRecallInjected(vault, SESSION).size);
    expect(sets.already_injected).toBeGreaterThan(0);
    expect(details["deduped"]).toBeUndefined();
    expect(details["ledger_recorded"]).toBeUndefined();
    expect(details["ledger_read"]).toBeUndefined();
  });

  test("a ledger write that fails after stdout is named on the audit line", async () => {
    // A fresh lockfile reads as a live holder, so the post-stdout record
    // gives up after its bounded retry while the read still succeeds.
    const statePath = hookStateFilePath(vault, SESSION);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(`${statePath}.lock`, "held by the test\n");
    const run = await runHook(SESSION);
    expect(run.exit).toBe(0);
    expect(brief(run)).toContain("notes/schedule.md");
    const details = lastDetails();
    expect(details["decision"]).toBe("inject");
    expect(details["ledger_recorded"]).toBe(false);
    expect(readRecallInjected(vault, SESSION).size).toBe(0);
  });

  test("a corrupt ledger fails open and is named on the audit line", async () => {
    const statePath = hookStateFilePath(vault, SESSION);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "{not json");
    const run = await runHook(SESSION);
    expect(run.exit).toBe(0);
    expect(brief(run)).toContain("notes/schedule.md");
    const details = lastDetails();
    expect(details["ledger_read"]).toBe("corrupt");
    expect(details["dedupe_sets"]).toEqual({ already_injected: 0, digest_paths: 0 });
  });

  test("without a session id both runs inject and no ledger is consulted", async () => {
    const first = await runHook();
    const second = await runHook();
    expect(brief(first)).toContain("notes/schedule.md");
    expect(second.stdout).toBe(first.stdout);
    expect(lastDetails()["decision"]).toBe("inject");
    expect(lastDetails()["dedupe_sets"]).toBeUndefined();
    expect(existsSync(join(vault, ".open-second-brain", "hook-state"))).toBe(false);
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
    expect(lastDetails()["dedupe_sets"]).toEqual({ already_injected: 0, digest_paths: 1 });
  });
});

/** The note bullets of a brief, one per rendered note. */
function bullets(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith('- "'));
}

describe("recall-inject hook: resolved caps take effect", () => {
  test("recall_inject_max_notes=1 renders exactly one bullet", async () => {
    const control = await runHook();
    expect(bullets(brief(control)).length).toBeGreaterThan(1);
    const run = await runHook(undefined, { OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES: "1" });
    expect(bullets(brief(run))).toHaveLength(1);
  });

  test("recall_inject_max_chars=200 bounds the brief", async () => {
    const control = await runHook();
    expect(brief(control).length).toBeGreaterThan(200);
    const run = await runHook(undefined, { OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_CHARS: "200" });
    expect(brief(run).length).toBeLessThanOrEqual(200);
  });
});

describe("recall-inject hook: operator-declared slices", () => {
  test("a path_prefix slice injects only notes under that prefix, under its heading", async () => {
    writeMd(
      vault,
      "Brain/_brain.yaml",
      [
        "schema_version: 1",
        "recall_inject:",
        "  slices: [field]",
        "  slice_field_heading: Field notes",
        "  slice_field_path_prefix: notes/",
        "",
      ].join("\n"),
    );
    const run = await runHook();
    expect(run.exit).toBe(0);
    const text = brief(run);
    expect(text).toContain("## Field notes");
    expect(text).toContain("notes/schedule.md");
    expect(text).not.toContain(PREF_PATH);
    const details = lastDetails();
    expect(details["decision"]).toBe("inject");
    const slices = details["slices"] as Array<Record<string, unknown>>;
    expect(slices).toHaveLength(1);
    expect(slices[0]).toMatchObject({ name: "field", outcome: "inject" });
    expect(slices[0]!["notes"]).toBe(details["note_count"]);
    expect(details["slices_config"]).toBeUndefined();
  });

  test("a types slice injects only notes of that frontmatter type", async () => {
    writeMd(
      vault,
      "Brain/_brain.yaml",
      [
        "schema_version: 1",
        "recall_inject:",
        "  slices: [prefs]",
        "  slice_prefs_heading: Preferences",
        "  slice_prefs_types: [preference]",
        "",
      ].join("\n"),
    );
    const run = await runHook();
    expect(run.exit).toBe(0);
    const text = brief(run);
    expect(text).toContain("## Preferences");
    expect(text).toContain(PREF_PATH);
    expect(text).not.toContain("notes/schedule.md");
    expect(text).not.toContain("notes/nests.md");
  });

  test("a _brain.yaml that fails to load errors the decision and names slices_config", async () => {
    writeMd(
      vault,
      "Brain/_brain.yaml",
      ["schema_version: 1", "recall_inject:", "  slices: [Bad_Name]", ""].join("\n"),
    );
    const run = await runHook();
    expect(run.exit).toBe(0);
    // The search loads the same policy file, so the unsliced retrieval
    // fails on it too and the hook stays fail-closed with no brief. What
    // this pins is that the slice path was not taken and the reason is on
    // the audit line.
    expect(run.stdout).toBe("");
    const details = lastDetails();
    expect(details["slices_config"]).toBe("invalid");
    expect(details["slices"]).toBeUndefined();
    expect(details["fault"]).toBe("retriever_failed");
  });

  test("a vault without _brain.yaml adds no slice fields to the audit line", async () => {
    await runHook();
    const details = lastDetails();
    expect(details["decision"]).toBe("inject");
    expect(details["slices"]).toBeUndefined();
    expect(details["slices_config"]).toBeUndefined();
  });
});

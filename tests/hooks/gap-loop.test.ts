import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitRecallTelemetry, RECALL_CHANNEL } from "../../src/core/brain/recall-telemetry.ts";
import { assessRecallAdequacy } from "../../src/core/brain/recall-adequacy.ts";
import {
  normalizeQueryTerms,
  recordRecallAdequacyDemand,
} from "../../src/core/brain/query-demand.ts";
import {
  listGapTasks,
  promoteGapsToTasks,
  GAP_SOURCE_ADEQUACY,
  GAP_SOURCE_TELEMETRY,
  GAP_TASK_CLOSED_RETENTION_MS,
  GAP_TASK_KIND,
  GAP_TASK_STATUS_CLOSED,
  GAP_TASK_STATUS_OPEN,
  GAP_TASKS_MAX_NOTES,
} from "../../src/core/brain/gaps/gap-loop.ts";
import { brainGapTasksDir } from "../../src/core/brain/paths.ts";
import { writeFrontmatterAtomic } from "../../src/core/vault.ts";

const HOOKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-gap-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-hook-gap-cfg-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

interface RunResult {
  readonly stdout: string;
  readonly exit: number;
}

async function runHook(
  name: string,
  payload: unknown,
  env: Record<string, string> = {},
): Promise<RunResult> {
  const inherited: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    HOME: configHome,
  };
  const proc = Bun.spawn(["bun", "run", join(HOOKS_DIR, `${name}.ts`)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...inherited, ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  return { stdout, exit };
}

function seedGap(topic: string, times: number): void {
  for (let i = 0; i < times; i++) {
    emitRecallTelemetry(vault, {
      host: "test",
      channel: RECALL_CHANNEL.cli,
      mode: "search",
      status: "empty",
      durationMs: 0,
      resultCount: 0,
      gaps: [topic],
      createdAt: `2026-05-2${i}T09:00:00.000Z`,
    });
  }
}

/** The bucket key `normalizeQueryTerms` derives for {@link ADEQUACY_QUERY}. */
const ADEQUACY_QUERY = "widget calibration procedure";
const ADEQUACY_BUCKET = normalizeQueryTerms(ADEQUACY_QUERY).join(" ");

/** Seed a recurring weak-recall bucket (signals-that-survive, unit 6). */
function seedUnmetRecall(times: number): void {
  const verdict = assessRecallAdequacy({ matchQuality: 0.4, scores: [0.9] });
  for (let i = 0; i < times; i++) {
    recordRecallAdequacyDemand(vault, {
      query: ADEQUACY_QUERY,
      verdict,
      at: `2026-05-1${i}T09:00:00.000Z`,
    });
  }
}

describe("gap-promote hook (SessionEnd)", () => {
  test("flag off is a no-op: no gap-task notes written", async () => {
    seedGap("alpha topic", 3);
    const r = await runHook("gap-promote", { hook_event_name: "SessionEnd" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(existsSync(join(vault, "Brain", "gap-tasks"))).toBe(false);
  });

  test("flag off is a no-op for the adequacy source too", async () => {
    seedUnmetRecall(4);
    const r = await runHook("gap-promote", { hook_event_name: "SessionEnd" }, { VAULT_DIR: vault });
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(vault, "Brain", "gap-tasks"))).toBe(false);
    expect(listGapTasks(vault)).toHaveLength(0);
  });

  test("flag on promotes a recurring weak-recall bucket to a gap task", async () => {
    seedUnmetRecall(4);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      {
        VAULT_DIR: vault,
        OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true",
        OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD: "3",
      },
    );
    expect(run.exit).toBe(0);
    const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
    expect(open.map((t) => t.topic)).toContain(ADEQUACY_BUCKET);
    expect(open.map((t) => t.source)).toContain(GAP_SOURCE_ADEQUACY);
  });

  test("flag on promotes a recurring gap to an open gap-task note", async () => {
    seedGap("alpha topic", 3);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      {
        VAULT_DIR: vault,
        OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true",
        OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD: "2",
      },
    );
    expect(run.exit).toBe(0);
    const open = listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN });
    expect(open.map((t) => t.topic)).toContain("alpha topic");
  });
});

describe("gap-promote hook audit line and auto-close", () => {
  /** Every `gap_loop_run` details object the hook appended, oldest first. */
  function auditDetails(): ReadonlyArray<Record<string, unknown>> {
    const dir = join(vault, ".open-second-brain", "hook-audit");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .toSorted()
      .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { action?: string; details?: Record<string, unknown> })
      .filter((record) => record.action === "gap_loop_run")
      .map((record) => record.details ?? {});
  }

  /** Write one gap-task note directly, bypassing the hook's mint budget. */
  function writeTask(
    key: string,
    status: string,
    opts: { closedAt?: string; topic?: string } = {},
  ): void {
    const topic = opts.topic ?? key;
    writeFrontmatterAtomic(
      join(brainGapTasksDir(vault), `${key}.md`),
      {
        kind: GAP_TASK_KIND,
        gap_key: key,
        gap_topic: topic,
        gap_source: GAP_SOURCE_TELEMETRY,
        status,
        occurrences: "3",
        created_at: "2026-01-01T00:00:00.000Z",
        ...(opts.closedAt !== undefined
          ? { closed_at: opts.closedAt, closed_reason: "recalled" }
          : {}),
      },
      // The body repeats the topic, exactly as a minted note does: that is
      // why the auto-close gate excludes gap-task notes by path.
      `Recurring recall gap for ${topic}.`,
      { vaultForRelativePath: vault, overwrite: true },
    );
  }

  /** A plain vault note that genuinely covers `topic`, outside the gap area. */
  function writeCoveringNote(topic: string): void {
    writeFrontmatterAtomic(
      join(vault, "notes", "coverage.md"),
      { title: topic },
      `This note documents ${topic} end to end. The ${topic} steps are recorded here.`,
      { vaultForRelativePath: vault, overwrite: true },
    );
  }

  const FLAG_ON = {
    OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true",
    OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD: "2",
  } as const;

  test("carries every count the promotion returns, not just the promotions", async () => {
    seedGap("alpha topic", 3);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(run.exit).toBe(0);
    const [details] = auditDetails();
    expect(details).toBeDefined();
    expect(Object.keys(details ?? {}).toSorted()).toEqual([
      "capped",
      "closed",
      "kept",
      "promoted",
      "pruned",
      "skipped",
    ]);
    expect(details?.["promoted"]).toBe(1);
    expect(details?.["pruned"]).toBe(0);
    expect(details?.["capped"]).toBe(0);
  });

  test("reports a closed task removed under the retention window as pruned", async () => {
    const stale = new Date(Date.now() - GAP_TASK_CLOSED_RETENTION_MS - 60_000).toISOString();
    writeTask("gap-stale", GAP_TASK_STATUS_CLOSED, { closedAt: stale });
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(run.exit).toBe(0);
    const [details] = auditDetails();
    expect(details?.["pruned"]).toBe(1);
    expect(existsSync(join(brainGapTasksDir(vault), "gap-stale.md"))).toBe(false);
  });

  test("reports a refusal at the cap instead of an unremarkable run", async () => {
    // Closed-but-recent fillers fill the directory without giving the
    // auto-close pass anything to recall.
    const recent = new Date().toISOString();
    for (let i = 0; i < GAP_TASKS_MAX_NOTES; i++) {
      writeTask(`gap-filler-${i}`, GAP_TASK_STATUS_CLOSED, { closedAt: recent });
    }
    seedGap("alpha topic", 3);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(run.exit).toBe(0);
    const [details] = auditDetails();
    expect(details?.["capped"]).toBe(1);
    expect(details?.["promoted"]).toBe(0);
    expect(listGapTasks(vault)).toHaveLength(GAP_TASKS_MAX_NOTES);
  });

  // The two tests below drive the WHOLE hook, not `autoCloseRecalledGaps`
  // in isolation, because the fault they exist to catch lives in the
  // wiring rather than in either piece. The gate takes a retriever of
  // `(topic, admits)`; a plain one-argument `RecallRetriever` is
  // structurally assignable to that type, so passing one type-checks
  // cleanly, ignores the membership rule, returns the gap-task note
  // itself and makes the gate throw - into the hook's outer catch, which
  // left every run doing nothing. Only an end-to-end run can tell the
  // difference: a core-level test supplies its own retriever and so can
  // never observe which one the hook actually passes.
  const COVERED_TOPIC = "widget calibration procedure";

  test("closes a gap task the vault now covers outside the gap area", async () => {
    writeTask("gap-covered", GAP_TASK_STATUS_OPEN, { topic: COVERED_TOPIC });
    writeCoveringNote(COVERED_TOPIC);
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(run.exit).toBe(0);
    const [details] = auditDetails();
    expect(details).toBeDefined();
    expect(details?.["closed"]).toBe(1);
    expect(details?.["kept"]).toBe(0);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_CLOSED }).map((t) => t.key)).toEqual([
      "gap-covered",
    ]);
  });

  test("keeps a gap task whose only match is its own note", async () => {
    writeTask("gap-uncovered", GAP_TASK_STATUS_OPEN, { topic: COVERED_TOPIC });
    const run = await runHook(
      "gap-promote",
      { hook_event_name: "SessionEnd" },
      { VAULT_DIR: vault, ...FLAG_ON },
    );
    expect(run.exit).toBe(0);
    const [details] = auditDetails();
    expect(details?.["closed"]).toBe(0);
    expect(details?.["kept"]).toBe(1);
    expect(listGapTasks(vault, { status: GAP_TASK_STATUS_OPEN }).map((t) => t.key)).toEqual([
      "gap-uncovered",
    ]);
  });
});

describe("gap-agenda hook (SessionStart)", () => {
  test("flag off is a silent no-op: no stdout", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: new Date("2026-06-01T12:00:00.000Z") });
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("flag on injects an open-gap agenda as additionalContext", async () => {
    seedGap("alpha topic", 3);
    promoteGapsToTasks(vault, { threshold: 2, now: new Date("2026-06-01T12:00:00.000Z") });
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("alpha topic");
    expect(out.hookSpecificOutput.additionalContext).toContain("[open]");
  });

  test("flag on stays silent when there are no open gap tasks", async () => {
    const r = await runHook(
      "gap-agenda",
      { hook_event_name: "SessionStart" },
      { VAULT_DIR: vault, OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED: "true" },
    );
    expect(r.exit).toBe(0);
    expect(r.stdout).toBe("");
  });
});

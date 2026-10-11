/**
 * The Stop hook step for answer-time quote verification (answer-trust
 * wave, Lane A): synthetic transcripts plus a real injection ledger.
 *
 * Pinned here: the single-annotation output shape, phase gating (the
 * recall injection flag, live active/subagent ledgers, the per-phase
 * `quote_check` mode), citation resolution by wikilink and vault-relative
 * path pointer, ledger membership for uncited spans, the bounded
 * fail-open arms (never blocks, one stderr audit line on error, silent
 * once-per-turn), and that a checked turn never edits the transcript.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  beginInjectionEpoch,
  LEDGER_KEY_SUBAGENT_INJECT,
  recordRecallInjected,
  recordSubagentDeliveredId,
} from "../../hooks/lib/injection-ledger.ts";
import { hookStateFilePath } from "../../hooks/lib/session-state.ts";

const HOOK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "hooks",
  "answer-quote-check.ts",
);

const SESSION = "sess-quote-check-1";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-hook-quote-check-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain", "notes"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The note the fixtures quote from. */
function writeNote(rel: string, body: string): string {
  const path = join(vault, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/** `quote_check` config for the hook's vault, plus any extra YAML keys. */
function writeConfig(mode: string): void {
  writeConfigFor({ recall: mode, active: mode, subagent: mode });
}

/** `quote_check` config with a per-phase mode. */
function writeConfigFor(modes: { recall: string; active: string; subagent: string }): void {
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    `schema_version: 2\n\nquote_check:\n  recall: ${modes.recall}\n  active: ${modes.active}\n  subagent: ${modes.subagent}\n`,
  );
}

/** The subagent phase alone: recall and active off, subagent as given. */
function subagentOnlyConfig(mode: string): void {
  writeConfigFor({ recall: "off", active: "off", subagent: mode });
}

function ccUser(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function ccAssistant(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function writeTranscript(lines: readonly string[]): string {
  const path = join(tmp, "transcript.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

async function runHook(overrides: Record<string, unknown> = {}): Promise<RunResult> {
  const transcriptPath =
    typeof overrides["transcript_path"] === "string"
      ? (overrides["transcript_path"] as string)
      : join(tmp, "transcript.jsonl");
  const proc = Bun.spawn(["bun", "run", HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Bun hands a child without `env` the environment this process STARTED
    // with; pass the live one so the child keeps the hermetic defaults the
    // suite preload installed, plus this test's VAULT_DIR and recall gate.
    env: { ...process.env, VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
  });
  proc.stdin.write(
    JSON.stringify({
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
      session_id: SESSION,
      cwd: vault,
      stop_hook_active: false,
      ...overrides,
    }),
  );
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { stdout, stderr, exit };
}

/** Parsed stdout annotations: one entry per emitted JSON line. */
function annotations(run: RunResult): ReadonlyArray<string> {
  return run.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed = JSON.parse(line) as {
        hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
      };
      expect(parsed.hookSpecificOutput?.hookEventName).toBe("Stop");
      return parsed.hookSpecificOutput?.additionalContext ?? "";
    });
}

/** The Brain log days the vault holds (a proxy for "the vault was written"). */
function logDays(): ReadonlyArray<string> {
  const logDir = join(vault, "Brain", "log");
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir).toSorted();
}

describe("answer-quote-check hook - output shape", () => {
  test("a verified cited span is silent, exit 0, no stderr", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital to secure services.\n");
    writeTranscript([
      ccUser("what does the note say?"),
      ccAssistant('The note states "reuses staked capital" plainly (Brain/notes/restaking.md).'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run)).toEqual([]);
    expect(logDays()).toEqual([]);
  });

  test("one unverified cited span in shadow emits exactly one annotation, and writes nothing to the vault", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital to secure services.\n");
    writeTranscript([
      ccUser("what does the note say?"),
      ccAssistant('The note states "reuses pooled capital" plainly (Brain/notes/restaking.md).'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[not-in-note]");
    expect(found[0]).toContain("reuses pooled capital");
    expect(logDays()).toEqual([]);
  });

  test("the transcript is never edited", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    const lines = [
      ccUser("what does the note say?"),
      ccAssistant('The note states "totally fabricated words" plainly (Brain/notes/restaking.md).'),
    ];
    writeTranscript(lines);
    const before = readFileSync(join(tmp, "transcript.jsonl"), "utf8");
    await runHook();
    expect(readFileSync(join(tmp, "transcript.jsonl"), "utf8")).toBe(before);
  });
});

describe("answer-quote-check hook - citations", () => {
  test("a vault-relative wikilink citation resolves against the vault", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        'Per [[Brain/notes/restaking]], the answer "reuses staked capital" is supported.',
      ),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(annotations(run)).toEqual([]);
  });

  test("a bare-name wikilink with no resolvable file is note-unavailable, not verified", async () => {
    // Basename resolution needs the link-graph index; a bounded Stop step
    // resolves vault-relative references only, and an unresolvable
    // citation is a "could not check" finding, never an all-clear.
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('Per [[restaking]], the answer "reuses staked capital" is supported.'),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[note-unavailable]");
  });

  test("a pointer that names a line range checks the range and misses as source-truncated", async () => {
    writeConfig("shadow");
    writeNote(
      "Brain/notes/restaking.md",
      "First line about staking.\nSecond line about risk.\nThird line: reuses staked capital.\n",
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('The note says "reuses staked capital" (Brain/notes/restaking.md:L1-L2).'),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[source-truncated]");
  });

  test("a cited note that cannot be read is note-unavailable, annotation kept", async () => {
    writeConfig("shadow");
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('The note says "reuses staked capital" (Brain/notes/absent.md).'),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[note-unavailable]");
  });
});

describe("answer-quote-check hook - ledger membership", () => {
  test("an uncited span a recall-injected note contains is verified silently", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    expect(recordRecallInjected(vault, SESSION, ["semantic:Brain/notes/restaking.md#L1-L1"])).toBe(
      true,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As the context showed, restaking "reuses staked capital".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(annotations(run)).toEqual([]);
  });

  test("an uncited span absent from every injected note is not-in-note", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: ["Brain/notes/restaking.md"],
        regroundParts: [],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('Restaking "secures pooled validators" everywhere.'),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[not-in-note]");
  });

  test("no candidates at all is note-unavailable - nothing to check is a finding", async () => {
    writeConfig("shadow");
    writeTranscript([ccUser("summarize"), ccAssistant('It "reuses staked capital", clearly.')]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[note-unavailable]");
  });

  test("the active digest's emitted paths are candidate evidence for the active phase", async () => {
    writeConfig("shadow");
    writeNote("Brain/active.md", "The operator prefers terse answers about staking.\n");
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: ["Brain/active.md"],
        regroundParts: [],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    writeTranscript([
      ccUser("how should I answer?"),
      ccAssistant('The digest says the operator "prefers terse answers".'),
    ]);
    const run = await runHook();
    expect(annotations(run)).toEqual([]);
  });
});

describe("answer-quote-check hook - the subagent phase", () => {
  test("a quoted span inside a delivered row's evidence paths verifies silently", async () => {
    subagentOnlyConfig("shadow");
    writeNote(
      "Brain/notes/restaking.md",
      "Restaking reuses staked capital to secure additional services.\n",
    );
    expect(recordSubagentDeliveredId(vault, SESSION, "agent-1", ["Brain/notes/restaking.md"])).toBe(
      true,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As delivered, restaking "reuses staked capital to secure additional services".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run)).toEqual([]);
  });

  test("a span the delivered evidence does not contain is annotated - the phase runs", async () => {
    subagentOnlyConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    expect(recordSubagentDeliveredId(vault, SESSION, "agent-1", ["Brain/notes/restaking.md"])).toBe(
      true,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As delivered, restaking "secures pooled validators".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[not-in-note]");
  });

  test("a legacy delivered row without paths keeps the phase silent", async () => {
    subagentOnlyConfig("shadow");
    // A row recorded before the wave carried agent ids and nothing else.
    mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
    writeFileSync(
      hookStateFilePath(vault, SESSION),
      JSON.stringify({
        [LEDGER_KEY_SUBAGENT_INJECT]: {
          expiresAt: Date.now() + 3_600_000,
          data: { ids: ["agent-legacy"] },
        },
      }),
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As delivered, restaking "secures pooled validators".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run)).toEqual([]);
  });

  test("quote_check.subagent off stays silent even with delivered paths", async () => {
    subagentOnlyConfig("off");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    expect(recordSubagentDeliveredId(vault, SESSION, "agent-1", ["Brain/notes/restaking.md"])).toBe(
      true,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As delivered, restaking "secures pooled validators".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run)).toEqual([]);
  });
});

describe("answer-quote-check hook - phase gating", () => {
  test("quote_check.recall off keeps the recall phase silent even with findings", async () => {
    writeConfig("off");
    writeTranscript([ccUser("summarize"), ccAssistant('It "reuses staked capital", clearly.')]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(annotations(run)).toEqual([]);
  });

  test("recall_inject_enabled off keeps the recall phase silent", async () => {
    writeConfig("shadow");
    writeTranscript([ccUser("summarize"), ccAssistant('It "reuses staked capital", clearly.')]);
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "false" },
    });
    proc.stdin.write(
      JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: join(tmp, "transcript.jsonl"),
        session_id: SESSION,
        stop_hook_active: false,
      }),
    );
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  test("stop_hook_active true is a silent once-per-turn arm", async () => {
    writeConfig("shadow");
    writeTranscript([ccUser("summarize"), ccAssistant('It "reuses staked capital", clearly.')]);
    const run = await runHook({ stop_hook_active: true });
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("no quoted spans is silent", async () => {
    writeConfig("shadow");
    writeTranscript([ccUser("summarize"), ccAssistant("Nothing quoted here at all.")]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("");
  });
});

describe("answer-quote-check hook - the enforce trail", () => {
  /** Lines of the vault's Brain-log JSONL sidecars naming the hook. */
  function enforceLines(): ReadonlyArray<string> {
    const logDir = join(vault, "Brain", "log");
    if (!existsSync(logDir)) return [];
    return readdirSync(logDir)
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap((name) => readFileSync(join(logDir, name), "utf8").split(/\r?\n/))
      .filter((line) => line.includes("answer-quote-check"));
  }

  test("enforce appends exactly one Brain-log event per turn, beside the annotation", async () => {
    writeConfig("enforce");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeTranscript([
      ccUser("what does the note say?"),
      ccAssistant('The note states "reuses pooled capital" plainly (Brain/notes/restaking.md).'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run).length).toBe(1);
    const lines = enforceLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("[not-in-note]");
    expect(lines[0]).toContain("reuses pooled capital");
    expect(lines[0]).toContain("recall");
  });

  test("enforce with every span verified writes nothing", async () => {
    writeConfig("enforce");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital to secure services.\n");
    writeTranscript([
      ccUser("what does the note say?"),
      ccAssistant('The note states "reuses staked capital" plainly (Brain/notes/restaking.md).'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(annotations(run)).toEqual([]);
    expect(enforceLines()).toEqual([]);
    expect(logDays()).toEqual([]);
  });

  test("a failed append names itself on one stderr line; the annotation still goes out, exit 0", async () => {
    writeConfig("enforce");
    // A FILE where the log directory belongs: every append fails.
    writeFileSync(join(vault, "Brain", "log"), "not a directory\n");
    writeTranscript([
      ccUser("what does the note say?"),
      ccAssistant('The note states "reuses pooled capital" plainly (Brain/notes/restaking.md).'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    const lines = run.stderr.split(/\r?\n/).filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]!.startsWith("answer-quote-check:")).toBe(true);
    expect(annotations(run).length).toBe(1);
  });
});

describe("answer-quote-check hook - fail-open arms", () => {
  test("an unreadable transcript exits 0 with exactly one stderr audit line", async () => {
    writeConfig("shadow");
    const dirAsTranscript = join(tmp, "not-a-transcript");
    mkdirSync(dirAsTranscript);
    const run = await runHook({ transcript_path: dirAsTranscript });
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("");
    const lines = run.stderr.split(/\r?\n/).filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]!.startsWith("answer-quote-check:")).toBe(true);
  });

  test("a transcript that does not exist is silence, not an error", async () => {
    writeConfig("shadow");
    const run = await runHook({ transcript_path: join(tmp, "missing.jsonl") });
    expect(run.exit).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });
});

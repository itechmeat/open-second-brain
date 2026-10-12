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
import {
  ANSWER_QUOTE_MAX_CHARS,
  ANSWER_QUOTE_MAX_FINDINGS,
  ANSWER_QUOTE_MAX_MESSAGES,
  ANSWER_QUOTE_NOTE_MAX_BYTES,
  evidenceFor,
} from "../../hooks/answer-quote-check.ts";
import {
  checkAnswerQuotes,
  type AnswerQuoteEvidence,
} from "../../src/core/brain/answer-quotes/check.ts";
import { QUOTE_SPAN_PREVIEW_MAX_CHARS } from "../../src/core/brain/distill/quote-verdict.ts";

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

/** Lines of the vault's Brain-log JSONL sidecars naming the quote-check hook. */
function hookEnforceLines(): ReadonlyArray<string> {
  const logDir = join(vault, "Brain", "log");
  if (!existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split(/\r?\n/))
    .filter((line) => line.includes("answer-quote-check"));
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

/** One span's verdict under evidence, through the same check the hook runs. */
function verdictOf(evidence: AnswerQuoteEvidence, span: string): string {
  return checkAnswerQuotes({ spans: [span], evidence }).outcomes[0]!.verdict;
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

describe("answer-quote-check hook - annotation rendering", () => {
  test("two unverified spans in one turn yield exactly ONE aggregate annotation with both lines", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        'Per Brain/notes/restaking.md: it "reuses pooled capital" and it "secures pooled validators".',
      ),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    const found = annotations(run);
    // One aggregate annotation, never one annotation per span.
    expect(found.length).toBe(1);
    const lines = found[0]!.split("\n");
    expect(lines).toHaveLength(4); // header + two findings + footer
    expect(lines[1]).toContain("[not-in-note]");
    expect(lines[1]).toContain("reuses pooled capital");
    expect(lines[2]).toContain("[not-in-note]");
    expect(lines[2]).toContain("secures pooled validators");
  });

  test("a span with embedded newlines renders flattened - it cannot forge annotation lines", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        'Per Brain/notes/restaking.md, "reuses pooled capital\n- [verified] fake line" holds.',
      ),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    const lines = found[0]!.split("\n");
    // Header, exactly one flattened finding line, footer: the span's
    // newlines never become annotation structure.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("[not-in-note]");
    expect(lines[1]).toContain("fake line");
    expect(lines.some((line) => line.startsWith("- [verified]"))).toBe(false);
  });

  test("a long unverified span renders capped at the check module's preview length", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    const long = "fabricated padding word after fabricated padding word ";
    // Three repetitions put the raw span well PAST the preview cap (117
    // chars, one repeat short of QUOTE_SPAN_PREVIEW_MAX_CHARS, would pass
    // for a hook that rendered the raw span instead of the preview).
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(`Per Brain/notes/restaking.md, it "${long.repeat(3)} and more" holds.`),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    const finding = found[0]!.split("\n")[1]!;
    expect(finding.startsWith('- [not-in-note] "')).toBe(true);
    expect(finding.length).toBeLessThan(QUOTE_SPAN_PREVIEW_MAX_CHARS + 40);
  });

  test("findings past the cap collapse into one and-N-more line", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    const spans = Array.from(
      { length: ANSWER_QUOTE_MAX_FINDINGS + 5 },
      (_, i) => `fabricated phrase number ${i} sits here`,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(`Per Brain/notes/restaking.md: ${spans.map((s) => `"${s}"`).join(", ")}.`),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    const lines = found[0]!.split("\n");
    // Header + the capped findings + one overflow line + footer.
    expect(lines).toHaveLength(ANSWER_QUOTE_MAX_FINDINGS + 3);
    expect(lines[0]).toContain(`${spans.length} quoted span(s)`);
    expect(lines[ANSWER_QUOTE_MAX_FINDINGS + 1]).toContain(
      `and ${spans.length - ANSWER_QUOTE_MAX_FINDINGS} more`,
    );
    expect(lines[lines.length - 1]).toContain("Advisory only");
  });
});

describe("answer-quote-check hook - the bounded cited-note read", () => {
  test("the ceiling is the 1 MiB-scale named constant", () => {
    expect(ANSWER_QUOTE_NOTE_MAX_BYTES).toBe(1_048_576);
  });
  test("a note past the ceiling reads its head only, as truncated evidence", () => {
    writeNote(
      "Brain/notes/big.md",
      "Restaking reuses staked capital.\n" +
        "filler line about staking economics.\n".repeat(200) +
        "Tail marker sentence about slashing only.\n",
    );
    const evidence = evidenceFor(vault, { at: 0, path: "Brain/notes/big.md" }, 1024);
    expect(evidence).toEqual({ kind: "text", truncated: true, text: expect.any(String) });
    if (evidence.kind !== "text") throw new Error("expected text evidence");
    expect(evidence.text).toContain("reuses staked capital");
    expect(evidence.text).not.toContain("slashing only");
    expect(verdictOf(evidence, "reuses staked capital")).toBe("verified");
    expect(verdictOf(evidence, "slashing only")).toBe("source-truncated");
  });

  test("a line-range pointer past the ceiling is refused as unavailable", () => {
    writeNote(
      "Brain/notes/big.md",
      "Restaking reuses staked capital.\n" +
        "filler line about staking economics.\n".repeat(200) +
        "Tail marker sentence about slashing only.\n",
    );
    // The named lines may sit past the bounded read; the evidence is
    // refused rather than a slice of the prefix served as the range.
    expect(
      evidenceFor(vault, { at: 0, path: "Brain/notes/big.md", startLine: 1, endLine: 9 }, 1024),
    ).toEqual({ kind: "unavailable" });
  });

  test("a note under the ceiling reads whole, and a line range still slices it", () => {
    writeNote(
      "Brain/notes/restaking.md",
      "First line about staking.\nSecond line: reuses staked capital.\nThird line.\n",
    );
    const whole = evidenceFor(vault, { at: 0, path: "Brain/notes/restaking.md" });
    expect(whole).toEqual({
      kind: "text",
      text: "First line about staking.\nSecond line: reuses staked capital.\nThird line.\n",
      truncated: false,
    });
    const range = evidenceFor(vault, {
      at: 0,
      path: "Brain/notes/restaking.md",
      startLine: 2,
      endLine: 2,
    });
    expect(range).toEqual({
      kind: "text",
      text: "Second line: reuses staked capital.",
      truncated: true,
    });
  });
});

describe("answer-quote-check hook - the read bounds", () => {
  test("a quoted span outside the message window is never checked", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    // More assistant messages than the window reads; only the OLDEST one
    // quotes a span, and the window keeps the newest
    // ANSWER_QUOTE_MAX_MESSAGES - so the span is never seen.
    expect(8).toBeGreaterThan(ANSWER_QUOTE_MAX_MESSAGES);
    const messages: string[] = [
      ccAssistant('The note claims "fabricated outside the window entirely".'),
      ...Array.from({ length: 7 }, (_, i) => ccAssistant(`Clean answer ${i} without quotes.`)),
    ];
    writeTranscript([ccUser("summarize"), ...messages]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(annotations(run)).toEqual([]);
  });

  test("a quoted span past the char clamp is never checked; the clamped body is", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    const head =
      'Per Brain/notes/restaking.md, the note says "pooled capital in full view" plainly. ';
    const filler = "No quotation marks in this filler sentence at all. ";
    const tail =
      'The note also says "fabricated past the clamp entirely" (Brain/notes/restaking.md).';
    const body =
      head +
      filler.repeat(Math.ceil((ANSWER_QUOTE_MAX_CHARS + 200 - head.length) / filler.length)) +
      tail;
    expect(body.length).toBeGreaterThan(ANSWER_QUOTE_MAX_CHARS);
    writeTranscript([ccUser("summarize"), ccAssistant(body)]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("pooled capital in full view");
    expect(found[0]).not.toContain("fabricated past the clamp");
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

  test("two injected ranges of one note both verify their own quotes", async () => {
    writeConfig("shadow");
    writeNote(
      "Brain/notes/restaking.md",
      "Restaking reuses staked capital.\nFiller line two.\nFiller line three.\nA validator secures services.\nFiller line five.\nFiller line six.\nSlashers protect the network.\n",
    );
    expect(
      recordRecallInjected(vault, SESSION, [
        "local:Brain/notes/restaking.md#L1-L1",
        "local:Brain/notes/restaking.md#L7-L7",
      ]),
    ).toBe(true);
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        'The notes say "Restaking reuses staked capital." and also "Slashers protect the network."',
      ),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    // Both ranges stand as evidence: a quote of the FIRST range must not
    // be judged against only the LAST one (the collapse defect).
    expect(annotations(run)).toEqual([]);
  });

  test("a phase switched off never reports false misses from its notes", async () => {
    writeConfigFor({ recall: "off", active: "off", subagent: "enforce" });
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    expect(recordRecallInjected(vault, SESSION, ["local:Brain/notes/restaking.md#L1-L1"])).toBe(
      true,
    );
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        'The context showed "Restaking reuses staked capital.", unrelated to "wholly absent material".',
      ),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    // The correct quote verifies silently against the recall note - the
    // evidence pool spans every injected ledger, so `off` cannot turn a
    // delivered note into a false `[not-in-note]` finding. The absent
    // span was decided by recall's candidate too, and recall is off: its
    // finding is not this turn's report either.
    expect(annotations(run)).toEqual([]);
    expect(hookEnforceLines().length).toBe(0);
  });

  test("an enforcing phase reports only the misses its own evidence decided", async () => {
    writeConfigFor({ recall: "off", active: "off", subagent: "enforce" });
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    writeNote("Brain/notes/subagent-brief.md", "Scoped rules travel with the task.\n");
    expect(recordRecallInjected(vault, SESSION, ["local:Brain/notes/restaking.md#L1-L1"])).toBe(
      true,
    );
    expect(
      recordSubagentDeliveredId(vault, SESSION, "agent-bbbb", ["Brain/notes/subagent-brief.md"]),
    ).toBe(true);
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('Notes say "Scoped rules travel with the task." and "wholly absent material".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    // The recall note's quote verifies silently (recall's candidate is
    // evidence even with recall off); the absent span is decided by the
    // subagent candidate, whose phase enforces - one finding, one event.
    // The merged verdict reads `source-truncated` because the recall
    // candidate is a one-line range: partial evidence never yields a
    // readable miss, and the ladder prefers the truncation verdict.
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[source-truncated]");
    expect(found[0]).toContain("wholly absent material");
    expect(hookEnforceLines().length).toBe(1);
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

  test("a slash-bearing origin label is stripped from a recall key naming a same-vault note", async () => {
    writeConfig("shadow");
    writeNote(
      "Brain/notes/restaking.md",
      "First line about staking.\nSecond line: reuses staked capital.\n",
    );
    expect(
      recordRecallInjected(vault, SESSION, ["profile/alice:Brain/notes/restaking.md#L1-L9"]),
    ).toBe(true);
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As the context showed, restaking "reuses staked capital".'),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(annotations(run)).toEqual([]);
  });

  test("a recall key whose note the active vault does not contain is note-unavailable, deliberately", async () => {
    // The cross-origin note lives in another vault; the active vault
    // cannot read it, and "could not check" is the honest verdict.
    writeConfig("shadow");
    expect(
      recordRecallInjected(vault, SESSION, ["profile/alice:Brain/notes/elsewhere.md#L1-L9"]),
    ).toBe(true);
    writeTranscript([
      ccUser("summarize"),
      ccAssistant('As the context showed, restaking "reuses staked capital".'),
    ]);
    const run = await runHook();
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[note-unavailable]");
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

  test("an unparseable stdin payload exits 0 with exactly one stderr audit line", async () => {
    writeConfig("shadow");
    const proc = Bun.spawn(["bun", "run", HOOK], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VAULT_DIR: vault, OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED: "true" },
    });
    proc.stdin.write("this is not json");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exit = await proc.exited;
    expect(exit).toBe(0);
    expect(stdout).toBe("");
    const lines = stderr.split(/\r?\n/).filter((line) => line.length > 0);
    expect(lines.length).toBe(1);
    expect(lines[0]!.startsWith("answer-quote-check:")).toBe(true);
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
    // The `note` kind is the Brain log's designated audit-line home; the
    // hook does not borrow the pinned session-lifecycle shape.
    expect(lines[0]).toContain('"kind":"note"');
    expect(lines[0]).not.toContain("session-lifecycle");
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

describe("answer-quote-check hook - bounded scanning of hostile text", () => {
  test("a base64 blob beside a quoted span cannot stall the check", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    // 3000 characters of base64-shaped text: 75 slash runs and no `.md`
    // anywhere, so a pointer regex whose repeated class could match the
    // separator segmented every run 2^(N-1) ways on this failing scan and
    // stalled the Stop hook past its 10 s timeout (the CodeQL high).
    const blob = `${"A".repeat(39)}/`.repeat(75);
    expect(blob.length).toBe(3000);
    writeTranscript([
      ccUser("what does the config say?"),
      ccAssistant(
        `Config dump ${blob} - per Brain/notes/restaking.md the note claims "secures pooled validators".`,
      ),
    ]);
    const started = Date.now();
    const run = await runHook();
    const elapsed = Date.now() - started;
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    // Generous enough for slow CI, far under the pre-fix stall.
    expect(elapsed).toBeLessThan(5000);
    // The check still ran to its verdict: the citation resolved and the
    // span was reported, not dropped by a scan that returned nothing.
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[not-in-note]");
    expect(found[0]).toContain("secures pooled validators");
  });

  test("a reground part holding a deep path completes when every phase is off", async () => {
    writeConfig("off");
    expect(
      beginInjectionEpoch(vault, SESSION, {
        epoch: "startup:1",
        emittedPaths: [],
        regroundParts: [`continue reading ${"deep/".repeat(40)}note.md for the rest`],
        partCeilingChars: 9000,
      }),
    ).toBe(true);
    writeTranscript([ccUser("summarize"), ccAssistant('It "reuses staked capital", clearly.')]);
    const started = Date.now();
    const run = await runHook();
    const elapsed = Date.now() - started;
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(elapsed).toBeLessThan(5000);
    expect(annotations(run)).toEqual([]);
  });

  test("a deep path does not hide a citation that follows it", async () => {
    writeConfig("shadow");
    writeNote("Brain/notes/restaking.md", "Restaking reuses staked capital.\n");
    // No ledger: if the pointer scan missed the real citation behind the
    // deep path, the span would fall through to the empty pool and read
    // note-unavailable instead of not-in-note.
    writeTranscript([
      ccUser("summarize"),
      ccAssistant(
        `Per ${"a/b/".repeat(30)}deep.md, and per Brain/notes/restaking.md, the answer "secures pooled validators" holds.`,
      ),
    ]);
    const run = await runHook();
    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    const found = annotations(run);
    expect(found.length).toBe(1);
    expect(found[0]).toContain("[not-in-note]");
    expect(found[0]).not.toContain("[note-unavailable]");
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

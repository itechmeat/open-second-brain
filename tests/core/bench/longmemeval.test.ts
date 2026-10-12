/**
 * LongMemEval bench suite adapter (recall-quality wave, t_607d429d):
 * parser with named errors, converter with abstention exclusion and the
 * direct gold-session-id join, no expected_text reliance for retrieval
 * scoring, and an end-to-end run over the committed sample fixture.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { benchSuite } from "../../../src/cli/brain/verbs/bench.ts";
import { parseBenchFixture } from "../../../src/core/bench/fixture.ts";
import {
  LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE,
  LONGMEMEVAL_JUDGE_SYSTEM_PROMPT,
  LONGMEMEVAL_PROMPT_REVISION,
  LONGMEMEVAL_RECALL_CUTOFF,
  loadLongMemEvalFixture,
  longMemEvalToBenchFixture,
  parseLongMemEvalDataset,
  scoreLongMemEvalRecall,
} from "../../../src/core/bench/longmemeval.ts";
import { runMemoryBench } from "../../../src/core/bench/phases.ts";
import { BENCH_REPORT_SCHEMA } from "../../../src/core/bench/types.ts";

const SAMPLE = join("tests", "fixtures", "bench", "longmemeval-sample.json");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A minimal valid entry, overridden per test. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  const sessions = [
    {
      session_id: "s1",
      date: "2026-03-02T10:00:00Z",
      turns: [
        { role: "user", content: "We picked Blue Heron as the launch codename." },
        { role: "assistant", content: "Noted: the launch codename is Blue Heron." },
      ],
    },
  ];
  return {
    q_id: "q1",
    question_type: "single-hop",
    question: "launch codename",
    haystack_session_id: sessions.map((s) => s.session_id),
    haystack_dates: sessions.map((s) => s.date),
    haystack_session: sessions.map((s) => s.turns),
    answer_session_ids: ["s1"],
    ...overrides,
  };
}

describe("parseLongMemEvalDataset", () => {
  test("accepts the official bare-array shape and a named wrapper", () => {
    const bare = parseLongMemEvalDataset([entry({})]);
    expect(bare.entries).toHaveLength(1);
    const wrapped = parseLongMemEvalDataset({ name: "sample", questions: [entry({})] });
    expect(wrapped.name).toBe("sample");
    expect(wrapped.entries).toHaveLength(1);
  });

  test("a missing q_id is a named error", () => {
    expect(() => parseLongMemEvalDataset([entry({ q_id: "" })])).toThrow(/q_id/);
  });

  test("an unknown question type is a named error listing the known types", () => {
    expect(() => parseLongMemEvalDataset([entry({ question_type: "quantum" })])).toThrow(
      /question_type/,
    );
  });

  test("a non-abstention question with no gold sessions is a named error", () => {
    expect(() => parseLongMemEvalDataset([entry({ answer_session_ids: [] })])).toThrow(
      /answer_session_ids/,
    );
  });

  test("a gold session id that joins no haystack session is rejected by name", () => {
    expect(() => parseLongMemEvalDataset([entry({ answer_session_ids: ["s-missing"] })])).toThrow(
      /unknown session 's-missing'/,
    );
  });

  test("misaligned haystack arrays are a named error", () => {
    expect(() =>
      parseLongMemEvalDataset([entry({ haystack_dates: ["2026-03-02T10:00:00Z", "2026-03-03"] })]),
    ).toThrow(/aligned/);
  });

  test("an unparseable session date is a named error", () => {
    expect(() => parseLongMemEvalDataset([entry({ haystack_dates: ["not-a-date"] })])).toThrow(
      /valid date/,
    );
  });

  test("a session with the same id but different content is a named error", () => {
    const other = entry({
      q_id: "q2",
      haystack_session: [[{ role: "user", content: "Something entirely different about coffee." }]],
    });
    expect(() => parseLongMemEvalDataset([entry({}), other])).toThrow(/session 's1'/);
  });
});

describe("longMemEvalToBenchFixture", () => {
  test("abstention questions are excluded with the count recorded", () => {
    const dataset = parseLongMemEvalDataset([
      entry({}),
      entry({ q_id: "q-abs", question_type: "abstention", answer_session_ids: [] }),
    ]);
    const { fixture, receipt } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(receipt.abstention_excluded).toBe(1);
  });

  test("gold session ids join directly to the session note paths", () => {
    const dataset = parseLongMemEvalDataset([entry({})]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions[0]!.expected_paths).toEqual(["sessions/s1.md"]);
    expect(fixture.questions[0]!.top_k).toBe(LONGMEMEVAL_RECALL_CUTOFF);
  });

  test("converted questions never set expected_text (retrieval scoring ignores it)", () => {
    const dataset = parseLongMemEvalDataset([entry({ answer: "Blue Heron" })]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    for (const question of fixture.questions) {
      expect(question.expected_text).toBeUndefined();
    }
  });

  test("the converted fixture round-trips parseBenchFixture", () => {
    const { fixture } = longMemEvalToBenchFixture(
      parseLongMemEvalDataset([
        entry({}),
        entry({ q_id: "q2", question_type: "multi-hop", answer_session_ids: ["s1"] }),
      ]),
    );
    expect(() => parseBenchFixture(fixture)).not.toThrow();
  });

  test("sessions become notes and session_turn continuity records", () => {
    const { fixture } = longMemEvalToBenchFixture(parseLongMemEvalDataset([entry({})]));
    expect(fixture.notes.map((n) => n.path)).toEqual(["sessions/s1.md"]);
    expect(fixture.continuity).toHaveLength(2);
    for (const record of fixture.continuity) {
      expect(record.kind).toBe("session_turn");
      expect(record.payload["session_id"]).toBe("s1");
      expect(typeof record.payload["text"]).toBe("string");
    }
  });

  test("converted questions carry the official judge input", () => {
    const { fixture } = longMemEvalToBenchFixture(
      parseLongMemEvalDataset([entry({ answer: "Blue Heron" })]),
    );
    expect(fixture.questions[0]!.judge_input).toEqual({
      question: "launch codename",
      answer: "Blue Heron",
      gold: ["s1"],
    });
  });

  test("a question without a stated reference answer omits the judge answer field", () => {
    const { fixture } = longMemEvalToBenchFixture(parseLongMemEvalDataset([entry({})]));
    expect(fixture.questions[0]!.judge_input).toBeDefined();
    expect(fixture.questions[0]!.judge_input!.answer).toBeUndefined();
    expect(fixture.questions[0]!.judge_input!.gold).toEqual(["s1"]);
  });
});

describe("the official judge prompts", () => {
  test("the prompt constants are pinned to a named upstream revision", () => {
    expect(LONGMEMEVAL_PROMPT_REVISION).toContain("LongMemEval");
    expect(LONGMEMEVAL_PROMPT_REVISION.length).toBeGreaterThan(20);
  });

  test("the system prompt and question template cover the payload fields", () => {
    expect(LONGMEMEVAL_JUDGE_SYSTEM_PROMPT).toContain("evidence");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{question}");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{answer}");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{gold}");
  });
});

describe("scoreLongMemEvalRecall", () => {
  const QUESTIONS = [
    {
      id: "q-both",
      category: "multi_evidence" as const,
      query: "q",
      top_k: 5,
      expected_paths: ["sessions/a.md", "sessions/b.md"],
    },
    {
      id: "q-missing",
      category: "single_hop" as const,
      query: "q",
      top_k: 5,
      expected_paths: ["sessions/a.md", "sessions/z.md"],
    },
    {
      id: "q-outside",
      category: "single_hop" as const,
      query: "q",
      top_k: 5,
      expected_paths: ["sessions/far.md"],
    },
  ];

  test("passes a question only when every gold note ranks inside the cutoff", () => {
    const retrieved = [
      { id: "q-both", paths: ["sessions/b.md", "sessions/a.md", "sessions/c.md"] },
      {
        id: "q-missing",
        paths: [
          "sessions/a.md",
          "sessions/b.md",
          "sessions/c.md",
          "sessions/d.md",
          "sessions/e.md",
        ],
      },
      {
        id: "q-outside",
        paths: [
          "sessions/a.md",
          "sessions/b.md",
          "sessions/c.md",
          "sessions/d.md",
          "sessions/e.md",
          "sessions/far.md",
        ],
      },
    ];
    // q-missing never surfaces sessions/z.md; q-outside's gold note sits
    // one rank past the strict cutoff. Exactly one question passes.
    expect(scoreLongMemEvalRecall(QUESTIONS, retrieved)).toEqual({ scored: 3, passed: 1 });
  });

  test("a question with no persisted result scores as a miss, never a pass", () => {
    expect(scoreLongMemEvalRecall(QUESTIONS, [])).toEqual({ scored: 3, passed: 0 });
  });

  test("non-retrieval questions are not scored", () => {
    const mixed = [
      ...QUESTIONS,
      { id: "q-handoff", category: "session_handoff" as const, session_id: "s1" },
    ];
    const scored = scoreLongMemEvalRecall(mixed, []);
    expect(scored.scored).toBe(3);
  });
});

describe("the longmemeval suite", () => {
  test("is registered with the embeddings capability", () => {
    const registration = benchSuite("longmemeval");
    expect(registration).toBeDefined();
    expect(registration!.capabilities).toEqual({ embeddings: true });
    expect(typeof registration!.loader).toBe("function");
  });

  test("the loader converts the committed sample with its receipt", () => {
    const { fixture, receipt } = loadLongMemEvalFixture(SAMPLE);
    expect(fixture.name).toBe("longmemeval-sample");
    expect(fixture.questions).toHaveLength(3);
    expect(receipt.abstention_excluded).toBe(1);
  });

  test("running the committed sample produces a green report with the judge skipped", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({ fixture, runsDir });
    expect(report.schema).toBe(BENCH_REPORT_SCHEMA);
    expect(report.fixture).toBe("longmemeval-sample");
    expect(report.judge.status).toBe("skipped");
    // Keyword-distinctive queries over a small haystack: all retrieval
    // questions find their gold sessions inside the recall cutoff.
    expect(report.quality.passed).toBe(report.quality.total);
    expect(report.quality.total).toBe(3);
  }, 30_000);

  test("the suite runs the embeddings capability path end to end", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({
      fixture,
      runsDir,
      capabilities: { embeddings: true },
      pinnedKnobs: { semantic: { enabled: true, provider: "local" } },
    });
    expect(report.embeddings).toBeDefined();
    expect(report.embeddings!.provider).toBe("local");
    expect(report.embeddings!.gate).toEqual({ blocked: false, reason: null });
    expect(report.judge.status).toBe("skipped");
    expect(report.quality.passed).toBe(report.quality.total);
  }, 30_000);

  test("a suite run surfaces the strict recall_all@5 family with the exclusion count", async () => {
    const { fixture, receipt } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({
      fixture,
      runsDir,
      suite: "longmemeval",
      suiteReceipt: receipt,
    });
    // The sample's three retrieval questions all find their gold
    // sessions inside the cutoff; one abstention question was excluded.
    expect(report.longmemeval).toEqual({ recall_all_at_5: 1, abstention_excluded: 1 });
  }, 30_000);

  test("the report family stays absent without the suite name", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({ fixture, runsDir });
    expect(report.longmemeval).toBeUndefined();
  }, 30_000);

  // The judge command runs under the platform shell (sh on POSIX,
  // cmd.exe on Windows), so the fake judge avoids shell operators
  // entirely: the test writes a script and passes both paths as
  // quoted, forward-slashed arguments.
  function writeFakeJudgeScript(runsDir: string): string {
    const script = join(runsDir, "fake-judge.mjs");
    writeFileSync(
      script,
      [
        'import { writeFileSync } from "node:fs";',
        "const chunks = [];",
        "for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);",
        'const text = Buffer.concat(chunks).toString("utf8");',
        "writeFileSync(process.argv[2], text);",
        "const parsed = JSON.parse(text);",
        "const verdicts = {};",
        "for (const q of parsed.questions) verdicts[q.id] = true;",
        "console.log(JSON.stringify({ verdicts }));",
        "",
      ].join("\n"),
    );
    return script;
  }
  const shellSafe = (path: string) => `"${path.replaceAll("\\", "/")}"`;

  test("a fake judge receives question, answer and gold and its verdicts land", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const stdinCapture = join(runsDir, "judge-stdin.json");
    // The external judge stays a dumb command: capture the payload, then
    // echo a true verdict for every question id it received.
    const judgeCmd = `bun ${shellSafe(writeFakeJudgeScript(runsDir))} ${shellSafe(stdinCapture)}`;
    const report = await runMemoryBench({ fixture, runsDir, judgeCmd });
    expect(report.judge.status).toBe("ran");
    for (const question of report.questions) {
      expect(question.judge_pass).toBe(true);
    }
    const payload = JSON.parse(readFileSync(stdinCapture, "utf8")) as {
      questions: Array<Record<string, unknown>>;
    };
    expect(payload.questions).toHaveLength(3);
    for (const payloadEntry of payload.questions) {
      expect(typeof payloadEntry["question"]).toBe("string");
      expect(Array.isArray(payloadEntry["gold"])).toBe(true);
      expect((payloadEntry["gold"] as ReadonlyArray<string>).length).toBeGreaterThan(0);
    }
    // The sample states a reference answer for at least its first
    // question; the payload carries it verbatim.
    const withAnswer = payload.questions.find((q) => typeof q["answer"] === "string");
    expect(withAnswer).toBeDefined();
  }, 20_000);

  test("a suite without judge input keeps the judge payload unchanged", async () => {
    const native = parseBenchFixture({
      name: "judge-payload-default",
      notes: [{ path: "Brain/notes/a.md", body: "alpha note" }],
      continuity: [],
      questions: [
        { id: "q1", category: "single_hop", query: "alpha", expected_paths: ["Brain/notes/a.md"] },
      ],
    });
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const stdinCapture = join(runsDir, "judge-stdin.json");
    const judgeCmd = `bun ${shellSafe(writeFakeJudgeScript(runsDir))} ${shellSafe(stdinCapture)}`;
    const report = await runMemoryBench({ fixture: native, runsDir, judgeCmd });
    expect(report.judge.status).toBe("ran");
    const payload = JSON.parse(readFileSync(stdinCapture, "utf8")) as {
      questions: Array<Record<string, unknown>>;
    };
    expect(payload.questions).toHaveLength(1);
    // No suite-provided judge input: no question, answer or gold fields.
    expect("question" in payload.questions[0]).toBe(false);
    expect("answer" in payload.questions[0]).toBe(false);
    expect("gold" in payload.questions[0]).toBe(false);
  }, 20_000);
});

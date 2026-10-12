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
import { embedBenchVaultIndex } from "../../../src/core/bench/embedding-cache.ts";
import { parseBenchFixture, materializeBenchVault } from "../../../src/core/bench/fixture.ts";
import {
  LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE,
  LONGMEMEVAL_JUDGE_SYSTEM_PROMPT,
  LONGMEMEVAL_PROMPT_PROVENANCE,
  LONGMEMEVAL_RECALL_CUTOFF,
  loadLongMemEvalFixture,
  longMemEvalToBenchFixture,
  parseLongMemEvalDataset,
  scoreLongMemEvalRecall,
} from "../../../src/core/bench/longmemeval.ts";
import { benchSearchConfig, runMemoryBench } from "../../../src/core/bench/phases.ts";
import { BENCH_REPORT_SCHEMA, type BenchPinnedKnobs } from "../../../src/core/bench/types.ts";

const SAMPLE = join("tests", "fixtures", "bench", "longmemeval-sample.json");
const OFFICIAL_SAMPLE = join("tests", "fixtures", "bench", "longmemeval-official-sample.json");

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

test("an all-abstention dataset names the abstention filter, not a missing dataset", () => {
  const dataset = parseLongMemEvalDataset([
    entry({ q_id: "abstain-1", question_type: "abstention" }),
  ]);
  expect(() => longMemEvalToBenchFixture(dataset)).toThrow(/abstention/);
});

test("session ids that sanitize to one note path are a named parse error", () => {
  const dataset = parseLongMemEvalDataset([
    entry({
      q_id: "collide",
      haystack_session_id: ["a/b", "a-b"],
      haystack_dates: ["2026-01-01", "2026-01-02"],
      haystack_session: [
        [{ role: "user", content: "alpha note" }],
        [{ role: "user", content: "beta note" }],
      ],
      answer_session_ids: ["a/b"],
    }),
  ]);
  expect(() => longMemEvalToBenchFixture(dataset)).toThrow(/same note path/);
});

describe("the official dataset shape", () => {
  test("the committed official-shape sample parses (official keys, types, _abs, question_date)", () => {
    const raw: unknown = JSON.parse(readFileSync(OFFICIAL_SAMPLE, "utf8"));
    const dataset = parseLongMemEvalDataset(raw);
    expect(dataset.entries.map((e) => e.q_id)).toEqual([
      "single-session-user_1",
      "multi-session_2",
      "single-session-user_3_abs",
    ]);
    expect(dataset.entries[0]!.question_type).toBe("single-session-user");
    expect(dataset.entries[0]!.question_date).toBe("2023/05/20 (Sat) 02:21");
  });

  test("official key spellings are read; the legacy sample shape keeps working", () => {
    const official = parseLongMemEvalDataset([
      {
        question_id: "q-official",
        question_type: "single-session-user",
        question: "launch codename",
        question_date: "2023/05/20 (Sat) 02:21",
        haystack_session_ids: ["s1"],
        haystack_sessions: [
          [{ role: "user", content: "We picked Blue Heron as the launch codename." }],
        ],
        haystack_dates: ["2023/05/01 (Mon) 09:15"],
        answer_session_ids: ["s1"],
      },
    ]);
    expect(official.entries[0]!.q_id).toBe("q-official");
    expect(official.entries[0]!.haystack_session_id).toEqual(["s1"]);
    expect(official.entries[0]!.haystack_session).toHaveLength(1);
    const legacy = parseLongMemEvalDataset([entry({})]);
    expect(legacy.entries[0]!.q_id).toBe("q1");
    expect(legacy.entries[0]!.haystack_session_id).toEqual(["s1"]);
  });

  test("every official question type maps to a bench category", () => {
    const types = [
      ["single-session-user", "single_hop"],
      ["single-session-assistant", "single_hop"],
      ["single-session-preference", "single_hop"],
      ["multi-session", "multi_evidence"],
      ["temporal-reasoning", "temporal"],
      ["knowledge-update", "contradiction"],
    ] as const;
    const dataset = parseLongMemEvalDataset(
      types.map(([type], i) =>
        entry({
          q_id: `q-type-${i}`,
          question_type: type,
          haystack_session_id: [`s-type-${i}`],
          haystack_dates: ["2026-03-02T10:00:00Z"],
          haystack_session: [[{ role: "user", content: `type marker ${i} zebra.` }]],
          answer_session_ids: [`s-type-${i}`],
        }),
      ),
    );
    const { fixture } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions.map((q) => q.category)).toEqual(types.map(([, category]) => category));
  });

  test("abstention is the _abs question-id suffix; the explicit type keeps working", () => {
    const dataset = parseLongMemEvalDataset([
      entry({
        q_id: "single-session-user_9_abs",
        question_type: "single-session-user",
        answer_session_ids: [],
      }),
      entry({ q_id: "abstain-legacy", question_type: "abstention", answer_session_ids: [] }),
      entry({}),
    ]);
    const { fixture, receipt } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions.map((q) => q.id)).toEqual(["q1"]);
    expect(receipt.abstention_excluded).toBe(2);
  });

  test("question_date is read, falling back to the last haystack date", () => {
    const dataset = parseLongMemEvalDataset([
      entry({ question_date: "2023/05/20 (Sat) 02:21" }),
      entry({ q_id: "q2" }),
    ]);
    expect(dataset.entries[0]!.question_date).toBe("2023/05/20 (Sat) 02:21");
    expect(dataset.entries[1]!.question_date).toBe("2026-03-02T10:00:00Z");
  });

  test("a non-date question_date is a named error", () => {
    expect(() => parseLongMemEvalDataset([entry({ question_date: "eventually" })])).toThrow(
      /question_date/,
    );
  });

  test("the official-shape sample converts with the _abs exclusion", () => {
    const raw: unknown = JSON.parse(readFileSync(OFFICIAL_SAMPLE, "utf8"));
    const { fixture, receipt } = longMemEvalToBenchFixture(parseLongMemEvalDataset(raw));
    expect(receipt.abstention_excluded).toBe(1);
    expect(fixture.questions.map((q) => q.id)).toEqual([
      "single-session-user_1",
      "multi-session_2",
    ]);
    expect(fixture.questions.map((q) => q.category)).toEqual(["single_hop", "multi_evidence"]);
  });
});

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

  test("a shared session id with per-instance dates parses (first date wins)", () => {
    const dataset = parseLongMemEvalDataset([
      entry({}),
      entry({
        q_id: "q2",
        question_type: "multi-hop",
        haystack_dates: ["2026-09-09T10:00:00Z"],
      }),
    ]);
    // Upstream assigns haystack dates per instance: the same session id
    // carrying a different date in each entry is data, not corruption.
    expect(dataset.entries).toHaveLength(2);
    expect(dataset.entries[1]!.haystack_dates).toEqual(["2026-09-09T10:00:00Z"]);
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
    expect(fixture.questions[0]!.expected_paths).toEqual(["sessions/q1/s1.md"]);
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
    expect(fixture.notes.map((n) => n.path)).toEqual(["sessions/q1/s1.md"]);
    expect(fixture.continuity).toHaveLength(2);
    for (const record of fixture.continuity) {
      expect(record.kind).toBe("session_turn");
      expect(record.payload["question_id"]).toBe("q1");
      expect(record.payload["session_id"]).toBe("s1");
      expect(typeof record.payload["text"]).toBe("string");
    }
  });

  test("each question's evidence is namespaced under its own subtree", () => {
    // LongMemEval scores every question against ITS OWN haystack, so
    // pooling all entries into one corpus would have each query search
    // the union of all haystacks. The converted notes, continuity and
    // expected_paths of one entry all live under sessions/<q_id>/.
    const shared = [{ role: "user", content: "shared zebra session about quilting." }];
    const dataset = parseLongMemEvalDataset([
      entry({
        q_id: "qA",
        haystack_session_id: ["s1", "shared"],
        haystack_dates: ["2026-03-02T10:00:00Z", "2026-03-02T11:00:00Z"],
        haystack_session: [[{ role: "user", content: "quokka alpha note." }], shared],
        answer_session_ids: ["s1"],
      }),
      entry({
        q_id: "qB",
        question_type: "multi-hop",
        haystack_session_id: ["shared", "s3"],
        haystack_dates: ["2026-03-02T11:00:00Z", "2026-03-03T10:00:00Z"],
        haystack_session: [shared, [{ role: "user", content: "wombat beta note." }]],
        answer_session_ids: ["s3"],
      }),
    ]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    for (const question of fixture.questions) {
      for (const path of question.expected_paths!) {
        expect(path.startsWith(`sessions/${question.id}/`)).toBe(true);
      }
    }
    const notePaths = fixture.notes.map((n) => n.path);
    expect(notePaths).toContain("sessions/qA/s1.md");
    expect(notePaths).toContain("sessions/qA/shared.md");
    expect(notePaths).toContain("sessions/qB/s3.md");
    expect(notePaths).toContain("sessions/qB/shared.md");
    // A session shared by two entries exists once per scope, and its
    // continuity records name the question that produced them.
    const sharedRecords = fixture.continuity.filter((r) => r.payload["session_id"] === "shared");
    expect(sharedRecords.map((r) => r.payload["question_id"]).sort()).toEqual(["qA", "qB"]);
  });

  test("distinct question ids that sanitize to one scope are a named error", () => {
    const dataset = parseLongMemEvalDataset([
      entry({ q_id: "q/1" }),
      entry({ q_id: "q-1", question_type: "multi-hop" }),
    ]);
    expect(() => longMemEvalToBenchFixture(dataset)).toThrow(/same path scope/);
  });

  test("a duplicate question id is a named error", () => {
    const dataset = parseLongMemEvalDataset([entry({}), entry({})]);
    expect(() => longMemEvalToBenchFixture(dataset)).toThrow(/appears twice/);
  });

  test("converted questions carry the suite judge input", () => {
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

describe("the judge prompts", () => {
  test("the prompt constants state their self-written provenance", () => {
    expect(LONGMEMEVAL_PROMPT_PROVENANCE).toContain("self-written");
    expect(LONGMEMEVAL_PROMPT_PROVENANCE).toContain("github.com/xiaowu0162/LongMemEval");
    expect(LONGMEMEVAL_PROMPT_PROVENANCE).toContain("evaluate_qa.py");
    // No pretense of an upstream transcription or a revision pin.
    expect(LONGMEMEVAL_PROMPT_PROVENANCE.toLowerCase()).not.toContain("pinned");
  });

  test("the system prompt and question template cover the payload fields", () => {
    expect(LONGMEMEVAL_JUDGE_SYSTEM_PROMPT).toContain("evidence");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{question}");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{answer}");
    expect(LONGMEMEVAL_JUDGE_QUESTION_TEMPLATE).toContain("{gold}");
  });
});

describe("date parsing", () => {
  test("official slash dates derive UTC turn timestamps, not host-local ones", () => {
    const dataset = parseLongMemEvalDataset([
      entry({
        haystack_dates: ["2023/05/20 (Sat) 02:21"],
        haystack_session: [[{ role: "user", content: "zebra anchor." }]],
      }),
    ]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    // Host-local parsing shifts this by the zone offset; UTC pins it.
    expect(fixture.continuity[0]!.created_at).toBe("2023-05-20T02:21:00.000Z");
  });

  test("the committed official sample derives UTC turn timestamps", () => {
    const raw: unknown = JSON.parse(readFileSync(OFFICIAL_SAMPLE, "utf8"));
    const { fixture } = longMemEvalToBenchFixture(parseLongMemEvalDataset(raw));
    expect(fixture.continuity[0]!.created_at).toBe("2023-05-01T09:15:00.000Z");
  });

  test("a naive ISO date-time is read as UTC, not host-local", () => {
    const dataset = parseLongMemEvalDataset([entry({ haystack_dates: ["2026-03-02T10:00:00"] })]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    expect(fixture.continuity[0]!.created_at).toBe("2026-03-02T10:00:00.000Z");
  });

  test("a date form only the host zone could interpret is a named error", () => {
    expect(() => parseLongMemEvalDataset([entry({ haystack_dates: ["May 20, 2023"] })])).toThrow(
      /valid date/,
    );
  });
});

describe("answer coercion", () => {
  test("numeric answers are coerced to strings for the judge payload", () => {
    const dataset = parseLongMemEvalDataset([
      entry({ answer: 42 }),
      entry({ q_id: "q2", question_type: "multi-hop", answer: 0 }),
    ]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions[0]!.judge_input!.answer).toBe("42");
    expect(fixture.questions[1]!.judge_input!.answer).toBe("0");
  });

  test("other non-string answer types stay refused", () => {
    const dataset = parseLongMemEvalDataset([entry({ answer: true })]);
    const { fixture } = longMemEvalToBenchFixture(dataset);
    expect(fixture.questions[0]!.judge_input!.answer).toBeUndefined();
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

  test("the loader converts the committed official-shape sample with its receipt", () => {
    const { fixture, receipt } = loadLongMemEvalFixture(OFFICIAL_SAMPLE);
    expect(fixture.name).toBe("longmemeval-suite");
    expect(fixture.questions).toHaveLength(2);
    expect(receipt.abstention_excluded).toBe(1);
    for (const question of fixture.questions) {
      expect(question.expected_paths!.every((p) => p.startsWith(`sessions/${question.id}/`))).toBe(
        true,
      );
    }
  });

  test("the official-shape sample runs end to end with the strict family", async () => {
    const { fixture, receipt } = loadLongMemEvalFixture(OFFICIAL_SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({
      fixture,
      runsDir,
      suite: "longmemeval",
      suiteReceipt: receipt,
      capabilities: { embeddings: true },
      // The official questions are natural sentences; the deterministic
      // local provider matches them to their haystack notes, which is
      // the lane the suite exists for.
      pinnedKnobs: { semantic: { enabled: true, provider: "local" } },
    });
    expect(report.embeddings).toBeDefined();
    expect(report.quality.passed).toBe(report.quality.total);
    expect(report.longmemeval).toEqual({ recall_all_at_5: 1, abstention_excluded: 1 });
  }, 30_000);

  test("the keyword-only default pin matches nothing for natural official questions", async () => {
    const { fixture, receipt } = loadLongMemEvalFixture(OFFICIAL_SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({
      fixture,
      runsDir,
      suite: "longmemeval",
      suiteReceipt: receipt,
    });
    // The keyword lane requires every query token to hit, so a natural
    // question scores zero notes - this is why the suite declares the
    // embeddings capability, and the report says so rather than
    // manufacturing a passing number.
    expect(report.longmemeval).toEqual({ recall_all_at_5: 0, abstention_excluded: 1 });
    expect(report.quality.passed).toBe(0);
  }, 30_000);

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

  test("a second identical vault is served by the shared vector cache", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    // Two disposable vaults, same content, one shared runs-dir cache:
    // the first arm pays the full census through the misses path, the
    // second is served whole - the cache-hit contract the pending
    // lookup exists for.
    const vaultA = mkdtempSync(join(tmpdir(), "o2b-longmemeval-vault-"));
    const vaultB = mkdtempSync(join(tmpdir(), "o2b-longmemeval-vault-"));
    dirs.push(vaultA, vaultB);
    materializeBenchVault(fixture, vaultA);
    materializeBenchVault(fixture, vaultB);
    const pin: BenchPinnedKnobs = { semantic: { enabled: true, provider: "local" } };
    const first = await embedBenchVaultIndex({
      config: benchSearchConfig(vaultA, pin),
      runsDir,
    });
    expect(first.cache_hits).toBe(0);
    expect(first.cache_misses).toBeGreaterThan(0);
    const second = await embedBenchVaultIndex({
      config: benchSearchConfig(vaultB, pin),
      runsDir,
    });
    expect(second.cache_hits).toBe(first.cache_misses);
    expect(second.cache_misses).toBe(0);
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

  test("without a suite receipt the exclusion count is null, never a manufactured 0", async () => {
    const { fixture } = loadLongMemEvalFixture(SAMPLE);
    const runsDir = mkdtempSync(join(tmpdir(), "o2b-longmemeval-runs-"));
    dirs.push(runsDir);
    const report = await runMemoryBench({ fixture, runsDir, suite: "longmemeval" });
    // A direct caller that skips the conversion receipt must not get a
    // report asserting zero exclusions: unknown is null, and a reader
    // can tell the two apart.
    expect(report.longmemeval).toEqual({ recall_all_at_5: 1, abstention_excluded: null });
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
    // Judged questions carry the evidence the run actually injected, so
    // the judge can evaluate against what the system showed.
    const withEvidence = payload.questions.find(
      (q) => Array.isArray(q["evidence"]) && (q["evidence"] as unknown[]).length > 0,
    );
    expect(withEvidence).toBeDefined();
    for (const entry of withEvidence!["evidence"] as Array<Record<string, unknown>>) {
      expect(typeof entry["path"]).toBe("string");
      expect(typeof entry["text"]).toBe("string");
    }
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
    const first = payload.questions[0]!;
    expect("question" in first).toBe(false);
    expect("answer" in first).toBe(false);
    expect("gold" in first).toBe(false);
  }, 20_000);
});

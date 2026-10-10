/**
 * Open-decision vault (write-side-trust wave, Lane E, Task 10).
 *
 * One Markdown record per parked question at
 * `Brain/decisions/open-<slug>.md`, modeled on the trigger store
 * lifecycle: a frozen key table, JSON-quoted free text, a body of
 * Question / Options / Context sections, named-unreadable partitioned
 * reads, a directory lock around transitions, and terminal records that
 * stay in place so history is a status filter.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import lockfile from "proper-lockfile";

import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { queryDecisionChangeHistory } from "../../../../src/core/brain/decisions/receipts.ts";
import {
  listDecisions,
  recordDecision,
  showDecision,
} from "../../../../src/core/brain/decisions/record.ts";
import { slugify } from "../../../../src/core/vault.ts";
import { BRAIN_DECISIONS_REL } from "../../../../src/core/brain/path-constants.ts";
import { decisionsDir } from "../../../../src/core/brain/paths.ts";
import {
  discardOpenDecision,
  isOpenDecisionStatus,
  listOpenDecisions,
  OPEN_DECISION_STATUS,
  OPEN_DECISION_STATUSES,
  OPEN_LOCK_STALE_MS,
  OpenDecisionDuplicateError,
  OpenDecisionError,
  openDecision,
  openQuestionHash,
  resolveOpenDecision,
  showOpenDecision,
} from "../../../../src/core/brain/decisions/open-store.ts";

// The log mirror is best-effort by contract; the mirror-failure test below
// needs the real appendLogEvent to throw for ONE event kind while every
// other event still lands, so the module is wrapped in a forwarding mock
// (captured before the mock is installed, or the forward would recurse).
import * as logModule from "../../../../src/core/brain/log.ts";

const realAppendLogEvent = logModule.appendLogEvent;
let failResolvedLogMirror = false;

mock.module("../../../../src/core/brain/log.ts", () => ({
  ...logModule,
  appendLogEvent: (
    ...args: Parameters<typeof realAppendLogEvent>
  ): ReturnType<typeof realAppendLogEvent> => {
    if (failResolvedLogMirror && args[1]!.eventType === BRAIN_LOG_EVENT_KIND.decisionResolved) {
      throw new Error("log shard unwritable");
    }
    return realAppendLogEvent(...args);
  },
}));

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-open-decisions-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const T0 = new Date("2026-10-01T09:00:00Z");
const T1 = new Date("2026-10-02T09:00:00Z");
const T2 = new Date("2026-10-03T09:00:00Z");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Which HTTP client for the ingest lane",
    question: "Which HTTP client should the ingest lane adopt?",
    options: ["bun's fetch", "undici"],
    context: "The lane needs connection pooling and HTTP/2.",
    agent: "tester",
    now: T0,
    ...overrides,
  };
}

describe("OPEN_DECISION_STATUS vocabulary", () => {
  test("the frozen trio and its companion list agree", () => {
    expect([...OPEN_DECISION_STATUSES]).toEqual(Object.values(OPEN_DECISION_STATUS));
    expect(OPEN_DECISION_STATUS.open).toBe("open");
    expect(OPEN_DECISION_STATUS.resolved).toBe("resolved");
    expect(OPEN_DECISION_STATUS.discarded).toBe("discarded");
    expect(Object.isFrozen(OPEN_DECISION_STATUS)).toBe(true);
    expect(Object.isFrozen(OPEN_DECISION_STATUSES)).toBe(true);
  });

  test("the type guard accepts every member and refuses everything else", () => {
    for (const status of OPEN_DECISION_STATUSES) expect(isOpenDecisionStatus(status)).toBe(true);
    expect(isOpenDecisionStatus("pending")).toBe(false);
    expect(isOpenDecisionStatus("")).toBe(false);
    expect(isOpenDecisionStatus(42)).toBe(false);
    expect(isOpenDecisionStatus(null)).toBe(false);
  });
});

describe("openDecision", () => {
  test("writes Brain/decisions/open-<slug>.md with JSON-quoted values and the three body sections", () => {
    const rec = openDecision(vault, baseInput());
    expect(rec.id).toBe("open-which-http-client-for-the-ingest-lane");
    expect(rec.status).toBe("open");
    expect(rec.path).toBe(join(decisionsDir(vault), `${rec.id}.md`));
    expect(existsSync(rec.path)).toBe(true);

    const raw = readFileSync(rec.path, "utf8");
    // Free text is JSON-quoted so YAML-significant characters cannot
    // corrupt the frontmatter (triggers/intentions pattern).
    expect(raw).toContain('title: "Which HTTP client for the ingest lane"');
    expect(raw).toContain('agent: "tester"');
    expect(raw).toContain(`question_hash: ${openQuestionHash(baseInput().question as string)}`);
    expect(raw).toContain("## Question");
    expect(raw).toContain("## Options");
    expect(raw).toContain("## Context");
    expect(raw).toContain("- bun's fetch");
    expect(raw).toContain("- undici");

    const listed = listOpenDecisions(vault);
    expect(listed.unreadable).toEqual([]);
    expect(listed.records).toHaveLength(1);
    const back = listed.records[0]!;
    expect(back.id).toBe(rec.id);
    expect(back.title).toBe("Which HTTP client for the ingest lane");
    expect(back.question).toBe("Which HTTP client should the ingest lane adopt?");
    expect([...back.options]).toEqual(["bun's fetch", "undici"]);
    expect(back.context).toBe("The lane needs connection pooling and HTTP/2.");
    expect(back.createdAt).toBe("2026-10-01T09:00:00Z");
    expect(back.resolvedAt).toBeNull();
    expect(back.discardedAt).toBeNull();
    expect(back.choice).toBeNull();
    expect(back.decision).toBeNull();
    expect(back.agent).toBe("tester");
  });

  test("a question differing only in case and whitespace is a typed duplicate naming the existing id", () => {
    openDecision(vault, baseInput());
    let caught: unknown;
    try {
      openDecision(
        vault,
        baseInput({ question: "  which HTTP client should THE INGEST lane adopt? " }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OpenDecisionDuplicateError);
    const dup = caught as OpenDecisionDuplicateError;
    expect(dup.message).toContain("open-which-http-client-for-the-ingest-lane");
    expect(dup.existingId).toBe("open-which-http-client-for-the-ingest-lane");
  });

  test("the same wording parks again once its twin has resolved", () => {
    const first = openDecision(vault, baseInput());
    resolveOpenDecision(vault, first.id, { choice: "bun's fetch", actor: "tester", now: T1 });
    const second = openDecision(vault, baseInput({ now: T2 }));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("open");
    expect(
      listOpenDecisions(vault, { status: OPEN_DECISION_STATUS.open }).records.map((r) => r.id),
    ).toEqual([second.id]);
  });

  test("the same wording parks again once its twin was discarded", () => {
    const first = openDecision(vault, baseInput());
    discardOpenDecision(vault, first.id, { reason: "not ours to make", actor: "tester", now: T1 });
    const second = openDecision(vault, baseInput({ now: T2 }));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("open");
  });

  test("a distinct question under the same title slug gets a suffixed filename, not a duplicate refusal", () => {
    const first = openDecision(vault, baseInput());
    const second = openDecision(
      vault,
      baseInput({
        question: "Which HTTP client should the export lane adopt?",
        now: T1,
      }),
    );
    expect(second.slug).not.toBe(first.slug);
    expect(second.id.startsWith("open-")).toBe(true);
    expect(listOpenDecisions(vault).records).toHaveLength(2);
  });

  test("an empty question, empty title or zero options refuses with a typed error", () => {
    expect(() => openDecision(vault, baseInput({ question: "   " }))).toThrow(OpenDecisionError);
    expect(() => openDecision(vault, baseInput({ title: "" }))).toThrow(OpenDecisionError);
    expect(() => openDecision(vault, baseInput({ options: [] }))).toThrow(OpenDecisionError);
    expect(() => openDecision(vault, baseInput({ options: ["  "] }))).toThrow(OpenDecisionError);
    expect(existsSync(decisionsDir(vault))).toBe(false);
  });

  test("creation logs one decision-open event", () => {
    const rec = openDecision(vault, baseInput());
    const log = readLogDay(vault, "2026-10-01");
    const events = log.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionOpen);
    expect(events).toHaveLength(1);
    expect(events[0]!.body["open"]).toBe(`[[${rec.id}]]`);
    expect(events[0]!.body["options"]).toBe("2");
  });
});

describe("heading-shaped free text", () => {
  test("a heading-shaped line in the question or context cannot re-partition the body", () => {
    const rec = openDecision(
      vault,
      baseInput({
        question: "Pick one\n## Options\n- evil",
        context: "Background\n## Question\n- also evil",
      }),
    );
    // The writer indented the injected headings, so the real sections stay put.
    const raw = readFileSync(rec.path, "utf8");
    expect(raw).toContain("Pick one\n ## Options\n- evil");
    expect(raw).toContain("Background\n ## Question\n- also evil");

    const back = showOpenDecision(vault, rec.id)!;
    expect(back.question).toBe("Pick one\n## Options\n- evil");
    expect(back.context).toBe("Background\n## Question\n- also evil");
    expect([...back.options]).toEqual(["bun's fetch", "undici"]);

    // The record resolves by its REAL options, not the injected ones.
    const res = resolveOpenDecision(vault, rec.id, {
      choice: "bun's fetch",
      actor: "tester",
      now: T1,
    });
    expect(res.decision).toBe("decision-which-http-client-for-the-ingest-lane");
  });

  test("a question that begins with a heading round-trips", () => {
    const rec = openDecision(vault, baseInput({ question: "# Not a heading\nbody line" }));
    const back = showOpenDecision(vault, rec.id)!;
    expect(back.question).toBe("# Not a heading\nbody line");
  });

  test("a heading-shaped line that was already indented round-trips byte-faithfully", () => {
    const question = "Pick one\n indented\n ## Sub\n- still prose";
    const rec = openDecision(vault, baseInput({ question }));
    const raw = readFileSync(rec.path, "utf8");
    // The writer indents it one more space; the reader removes exactly that one.
    expect(raw).toContain("indented\n  ## Sub");
    expect(showOpenDecision(vault, rec.id)!.question).toBe(question);
  });
});

describe("hand-edit tolerance", () => {
  test("a hand-edited file with YAML-significant characters round-trips", () => {
    const rec = openDecision(
      vault,
      baseInput({
        title: "Ship: the `quoted` #title",
        question: "Use colons: yes or no?",
        options: ['say "no"', "plain"],
      }),
    );
    const back = showOpenDecision(vault, rec.id);
    expect(back?.title).toBe("Ship: the `quoted` #title");
    expect(back?.question).toBe("Use colons: yes or no?");
    expect([...(back?.options ?? [])]).toEqual(['say "no"', "plain"]);
  });

  test("a record with an unreadable status is named in the unreadable partition, not dropped", () => {
    const rec = openDecision(vault, baseInput());
    writeFileSync(
      rec.path,
      readFileSync(rec.path, "utf8").replace("status: open", "status: vanished"),
      "utf8",
    );
    const listed = listOpenDecisions(vault);
    expect(listed.records).toEqual([]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]!.path).toBe(rec.path);
    expect(listed.unreadable[0]!.reason).toContain("status");
  });

  test("a record whose question body was emptied is unreadable, naming the file", () => {
    const rec = openDecision(vault, baseInput());
    writeFileSync(
      rec.path,
      readFileSync(rec.path, "utf8").replace("Which HTTP client should the ingest lane adopt?", ""),
      "utf8",
    );
    const listed = listOpenDecisions(vault);
    expect(listed.records).toEqual([]);
    expect(listed.unreadable).toHaveLength(1);
    expect(listed.unreadable[0]!.path).toBe(rec.path);
  });

  test("a file without an open_decision id is not an open record and is skipped silently", () => {
    openDecision(vault, baseInput());
    writeFileSync(join(decisionsDir(vault), "operator-notes.md"), "# my own notes\n", "utf8");
    const listed = listOpenDecisions(vault);
    expect(listed.records).toHaveLength(1);
    expect(listed.unreadable).toEqual([]);
  });

  test("an absent question_hash is recomputed from the question body; a malformed one refuses", () => {
    const rec = openDecision(vault, baseInput());
    const withoutHash = readFileSync(rec.path, "utf8").replace(/^question_hash: .*\n/mu, "");
    writeFileSync(rec.path, withoutHash, "utf8");
    const listed = listOpenDecisions(vault);
    expect(listed.unreadable).toEqual([]);
    expect(listed.records[0]!.questionHash).toBe(openQuestionHash(baseInput().question as string));

    const malformed = withoutHash.replace(
      "status: open",
      'status: open\nquestion_hash: "not-a-hash"',
    );
    writeFileSync(rec.path, malformed, "utf8");
    const broken = listOpenDecisions(vault);
    expect(broken.records).toEqual([]);
    expect(broken.unreadable).toHaveLength(1);
    expect(broken.unreadable[0]!.reason).toContain("question_hash");
  });
});

describe("listing", () => {
  test("records sort oldest-first with the id breaking ties, whatever the directory order", () => {
    const a = openDecision(
      vault,
      baseInput({ title: "B question", question: "Question B?", now: T1 }),
    );
    const b = openDecision(
      vault,
      baseInput({ title: "A question", question: "Question A?", now: T0 }),
    );
    const c = openDecision(
      vault,
      baseInput({ title: "C question", question: "Question C?", now: T2 }),
    );
    for (const rec of [a, b, c]) expect(rec.id).toBeTruthy();
    const listed = listOpenDecisions(vault).records.map((r) => r.id);
    expect(listed).toEqual([b!.id, a!.id, c!.id]);
  });

  test("the status filter partitions without hiding unreadable entries", () => {
    openDecision(vault, baseInput({ title: "One", question: "Question one?", now: T0 }));
    const two = openDecision(
      vault,
      baseInput({ title: "Two", question: "Question two?", now: T1 }),
    );
    resolveOpenDecision(vault, two.id, { choice: "bun's fetch", actor: "tester", now: T2 });
    const broken = openDecision(
      vault,
      baseInput({ title: "Broken", question: "Question broken?", now: T2 }),
    );
    writeFileSync(
      broken.path,
      readFileSync(broken.path, "utf8").replace("status: open", "status: gone"),
      "utf8",
    );

    const open = listOpenDecisions(vault, { status: OPEN_DECISION_STATUS.open });
    expect(open.records.map((r) => r.title)).toEqual(["One"]);
    expect(open.unreadable).toHaveLength(1);

    const resolved = listOpenDecisions(vault, { status: OPEN_DECISION_STATUS.resolved });
    expect(resolved.records.map((r) => r.id)).toEqual([two.id]);
  });

  test("a caller-readable predicate excludes records it may not read, like the decision pages", () => {
    const rec = openDecision(vault, baseInput());
    const listed = listOpenDecisions(vault, {
      readable: (rel) => rel !== `${BRAIN_DECISIONS_REL}/${rec.id}.md`,
    });
    expect(listed.records).toEqual([]);
    expect(listed.unreadable).toEqual([]);
    expect(
      showOpenDecision(vault, rec.id, {
        readable: () => false,
      }),
    ).toBeNull();
  });
});

describe("resolveOpenDecision", () => {
  test("mints a real decision page via recordDecision, stamps resolved with the pointer, and lands exactly one open_resolved receipt", () => {
    const rec = openDecision(vault, baseInput());
    const res = resolveOpenDecision(vault, rec.id, {
      choice: "bun's fetch",
      actor: "tester",
      rationale: "zero extra dependency",
      now: T2,
    });
    expect(res.decision).toBe("decision-which-http-client-for-the-ingest-lane");

    // The minted page is a real type: decision record with the chosen option.
    const page = showDecision(vault, "which-http-client-for-the-ingest-lane");
    expect(page).not.toBeNull();
    expect(page!.chosen).toBe("bun's fetch");
    expect(listDecisions(vault)).toHaveLength(1);

    // The open record is stamped resolved, keeps its body, and carries the pointer.
    const stamped = showOpenDecision(vault, rec.id);
    expect(stamped!.status).toBe("resolved");
    expect(stamped!.resolvedAt).toBe("2026-10-03T09:00:00Z");
    expect(stamped!.choice).toBe("bun's fetch");
    expect(stamped!.decision).toBe("[[decision-which-http-client-for-the-ingest-lane]]");
    expect(existsSync(stamped!.path)).toBe(true);

    // Exactly one open_resolved receipt for the open record.
    const history = queryDecisionChangeHistory(vault, { subject: rec.id, limit: 50 });
    const openResolved = history.receipts.filter((r) => r.reason_code === "open-resolved");
    expect(openResolved).toHaveLength(1);
    expect(openResolved[0]!.after).toContain("decision-which-http-client-for-the-ingest-lane");

    // One decision-resolved log event.
    const log = readLogDay(vault, "2026-10-03");
    expect(
      log.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionResolved),
    ).toHaveLength(1);
  });

  test("two same-titled questions both resolve, each minting its own page", () => {
    const first = openDecision(
      vault,
      baseInput({ title: "Pick DB", question: "Which database for the core lane?" }),
    );
    const second = openDecision(
      vault,
      baseInput({ title: "Pick DB", question: "Which database for the analytics lane?", now: T1 }),
    );
    const r1 = resolveOpenDecision(vault, first.id, {
      choice: "bun's fetch",
      actor: "tester",
      now: T1,
    });
    // The title slug is taken by the first record's page, so the second
    // mints from a title carrying its own record id - never a refusal.
    const r2 = resolveOpenDecision(vault, second.id, {
      choice: "undici",
      actor: "tester",
      now: T2,
    });
    expect(r1.decision).toBe("decision-pick-db");
    expect(r2.decision).toBe("decision-pick-db-open-pick-db-2");
    expect(showOpenDecision(vault, second.id)!.status).toBe("resolved");
    expect(showDecision(vault, "pick-db")!.chosen).toBe("bun's fetch");
    expect(showDecision(vault, "pick-db-open-pick-db-2")!.chosen).toBe("undici");
    expect(listDecisions(vault)).toHaveLength(2);
  });

  test("a cap-length title with a foreign page on its slug still resolves, minting at the head-plus-id slug", () => {
    // A title whose slug fills the cap exactly: the derived candidates'
    // distinguishing tail must sit INSIDE that cap, or every candidate
    // slugifies identically and the mint walk never terminates.
    const longTitle =
      "Decide the retention window for transient session checkpoints across " +
      "every managed device and offline co-editor before the next quarterly storage review";
    expect(slugify(longTitle).length).toBe(64);
    // A foreign decision page (no provenance of this record) occupies the
    // bare title slug the mint walk tries first.
    recordDecision(vault, {
      title: longTitle,
      chosen: "keep",
      assumption: "prior art",
      reviewDate: "2026-10-01",
      agent: "tester",
      now: T0,
    });
    const rec = openDecision(
      vault,
      baseInput({ title: longTitle, question: "A different long question entirely?" }),
    );
    const res = resolveOpenDecision(vault, rec.id, {
      choice: "bun's fetch",
      actor: "tester",
      now: T2,
    });
    // The mint landed beside the foreign page, not on it, with the record's
    // own id riding inside the cap: head slug first, then the open id.
    const mintedSlug = res.decision.slice("decision-".length);
    expect(mintedSlug).not.toBe(slugify(longTitle));
    expect(mintedSlug.length).toBeLessThanOrEqual(64);
    expect(mintedSlug).toContain("open-");
    expect(mintedSlug.startsWith("decide-the-retention-window-for-")).toBe(true);
    const page = showDecision(vault, mintedSlug);
    expect(page).not.toBeNull();
    expect(page!.chosen).toBe("bun's fetch");
    expect(page!.notes).toContain(`[[${rec.id}]]`);
    const stamped = showOpenDecision(vault, rec.id)!;
    expect(stamped.status).toBe("resolved");
    expect(stamped.decision).toBe(`[[${res.decision}]]`);
  }, 20000);

  test("two same-titled cap-length questions both resolve, each minting its own page", () => {
    const longTitle =
      "Decide the retention window for transient session checkpoints across " +
      "every managed device and offline co-editor before the next quarterly storage review";
    const first = openDecision(
      vault,
      baseInput({ title: longTitle, question: "Question one under the long title?" }),
    );
    const second = openDecision(
      vault,
      baseInput({
        title: longTitle,
        question: "Question two under the long title?",
        now: T1,
      }),
    );
    const r1 = resolveOpenDecision(vault, first.id, {
      choice: "bun's fetch",
      actor: "tester",
      now: T1,
    });
    // The bare title slug is taken by the first record's page, so the
    // second mints from a candidate carrying its own record id inside the
    // slug cap - never a refusal, never a hang.
    const r2 = resolveOpenDecision(vault, second.id, {
      choice: "undici",
      actor: "tester",
      now: T2,
    });
    expect(r1.decision).not.toBe(r2.decision);
    expect(showOpenDecision(vault, first.id)!.status).toBe("resolved");
    expect(showOpenDecision(vault, second.id)!.status).toBe("resolved");
    expect(showDecision(vault, r1.decision.slice("decision-".length))!.chosen).toBe("bun's fetch");
    expect(showDecision(vault, r2.decision.slice("decision-".length))!.chosen).toBe("undici");
    expect(listDecisions(vault)).toHaveLength(2);
  }, 20000);

  test("a resolve that crashed after minting the page converges on the next attempt", () => {
    const rec = openDecision(vault, baseInput());
    resolveOpenDecision(vault, rec.id, {
      choice: "bun's fetch",
      actor: "tester",
      rationale: "zero extra dependency",
      now: T1,
    });
    // Simulate the crash: rewind the record to its open shape, leaving the
    // minted page (whose body names this record) in place.
    writeFileSync(
      rec.path,
      readFileSync(rec.path, "utf8")
        .replace("status: resolved", "status: open")
        .replace(/^resolved_at: .*\n/mu, "")
        .replace(/^choice: .*\n/mu, "")
        .replace(/^decision: .*\n/mu, ""),
      "utf8",
    );
    expect(showOpenDecision(vault, rec.id)!.status).toBe("open");

    const again = resolveOpenDecision(vault, rec.id, {
      choice: "bun's fetch",
      actor: "tester",
      now: T2,
    });
    expect(again.decision).toBe("decision-which-http-client-for-the-ingest-lane");
    const stamped = showOpenDecision(vault, rec.id)!;
    expect(stamped.status).toBe("resolved");
    expect(stamped.decision).toBe("[[decision-which-http-client-for-the-ingest-lane]]");
    // The crashed attempt minted the one page; the retry minted no second.
    expect(listDecisions(vault)).toHaveLength(1);
  });

  test("a throwing decision-resolved log mirror does not fail the resolve nor skip the receipt", () => {
    const rec = openDecision(vault, baseInput());
    failResolvedLogMirror = true;
    try {
      const res = resolveOpenDecision(vault, rec.id, {
        choice: "bun's fetch",
        actor: "tester",
        now: T1,
      });
      expect(res.decision).toBe("decision-which-http-client-for-the-ingest-lane");
      expect(showOpenDecision(vault, rec.id)!.status).toBe("resolved");
      const history = queryDecisionChangeHistory(vault, { subject: rec.id, limit: 50 });
      expect(history.receipts.filter((r) => r.reason_code === "open-resolved")).toHaveLength(1);
    } finally {
      failResolvedLogMirror = false;
    }
    // The mirror alone went down: the log day carries the mint's
    // decision-record event but no decision_resolved one.
    const log = readLogDay(vault, "2026-10-02");
    expect(
      log.entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionResolved),
    ).toHaveLength(0);
  });

  test("a choice outside the enumerated options refuses naming the options", () => {
    const rec = openDecision(vault, baseInput());
    expect(() =>
      resolveOpenDecision(vault, rec.id, { choice: "axios", actor: "tester", now: T1 }),
    ).toThrow(/axios/);
    const back = showOpenDecision(vault, rec.id);
    expect(back!.status).toBe("open");
  });

  test("resolving a terminal record refuses; resolving an unknown id is a typed error", () => {
    const rec = openDecision(vault, baseInput());
    resolveOpenDecision(vault, rec.id, { choice: "bun's fetch", actor: "tester", now: T1 });
    expect(() =>
      resolveOpenDecision(vault, rec.id, { choice: "undici", actor: "tester", now: T2 }),
    ).toThrow(OpenDecisionError);
    expect(() =>
      resolveOpenDecision(vault, "open-nowhere", { choice: "undici", actor: "tester", now: T2 }),
    ).toThrow(/open-nowhere/);
  });

  test("an unknown-id refusal names unreadable siblings instead of claiming absence", () => {
    const broken = openDecision(vault, baseInput({ title: "Broken" }));
    writeFileSync(
      broken.path,
      readFileSync(broken.path, "utf8").replace("status: open", "status: gone"),
      "utf8",
    );
    const open = openDecision(vault, baseInput({ title: "Healthy", now: T1 }));
    expect(() =>
      resolveOpenDecision(vault, "open-broken", { choice: "x", actor: "tester", now: T2 }),
    ).toThrow(/could not be read/);
    void open;
  });

  test("the minted page carries the rationale as the assumption and the resolve date as review date", () => {
    const rec = openDecision(vault, baseInput());
    resolveOpenDecision(vault, rec.id, {
      choice: "undici",
      actor: "tester",
      now: T2,
    });
    const page = showDecision(vault, "which-http-client-for-the-ingest-lane");
    expect(page!.chosen).toBe("undici");
    expect(page!.reviewDate).toBe("2026-10-03");
    expect(page!.assumption).toContain("open-which-http-client-for-the-ingest-lane");
  });
});

describe("discardOpenDecision", () => {
  test("records the reason and keeps the terminal record in place", () => {
    const rec = openDecision(vault, baseInput());
    discardOpenDecision(vault, rec.id, {
      reason: "superseded by the panel verdict",
      actor: "tester",
      now: T1,
    });
    const back = showOpenDecision(vault, rec.id);
    expect(back!.status).toBe("discarded");
    expect(back!.discardedAt).toBe("2026-10-02T09:00:00Z");
    expect(back!.discardReason).toBe("superseded by the panel verdict");
    expect(existsSync(back!.path)).toBe(true);

    const log = readLogDay(vault, "2026-10-02");
    const events = log.entries.filter(
      (e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionDiscarded,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.body["reason"]).toBe("superseded by the panel verdict");
  });

  test("discarding a resolved record, a terminal record, or an unknown id refuses with typed errors", () => {
    const rec = openDecision(vault, baseInput());
    resolveOpenDecision(vault, rec.id, { choice: "bun's fetch", actor: "tester", now: T1 });
    expect(() =>
      discardOpenDecision(vault, rec.id, { reason: "again", actor: "tester", now: T2 }),
    ).toThrow(OpenDecisionError);
    expect(() =>
      discardOpenDecision(vault, "open-nowhere", { reason: "x", actor: "tester", now: T2 }),
    ).toThrow(/open-nowhere/);
  });

  test("an empty reason refuses before anything is written", () => {
    const rec = openDecision(vault, baseInput());
    expect(() =>
      discardOpenDecision(vault, rec.id, { reason: "  ", actor: "tester", now: T1 }),
    ).toThrow(OpenDecisionError);
    expect(showOpenDecision(vault, rec.id)!.status).toBe("open");
  });
});

describe("serialization", () => {
  test("writers serialize under the decisions directory lock", () => {
    const rec = openDecision(vault, baseInput());
    const release = lockfile.lockSync(decisionsDir(vault), {
      stale: OPEN_LOCK_STALE_MS,
      realpath: false,
    });
    try {
      expect(() =>
        resolveOpenDecision(vault, rec.id, { choice: "bun's fetch", actor: "tester", now: T1 }),
      ).toThrow();
      expect(() =>
        discardOpenDecision(vault, rec.id, { reason: "x", actor: "tester", now: T1 }),
      ).toThrow();
      expect(() => openDecision(vault, baseInput({ title: "Second", now: T1 }))).toThrow();
    } finally {
      release();
    }
    expect(showOpenDecision(vault, rec.id)!.status).toBe("open");
    expect(listOpenDecisions(vault).records).toHaveLength(1);
  });
});

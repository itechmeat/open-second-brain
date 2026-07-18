import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { listObligations } from "../../../../src/core/brain/obligations.ts";
import { queryByTopic } from "../../../../src/core/brain/query.ts";
import {
  DECISION_TYPE,
  DecisionError,
  backfillOutcome,
  compareDecisions,
  findSimilarDecisions,
  listDecisions,
  listRatedDecisions,
  recordDecision,
  showDecision,
  updateRating,
} from "../../../../src/core/brain/decisions/record.ts";
import {
  DECISION_CHANGE_REASON,
  queryDecisionChangeHistory,
} from "../../../../src/core/brain/decisions/receipts.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-decision-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const NOW = new Date("2026-07-18T12:00:00Z");

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Adopt Bun as the primary runtime",
    chosen: "Bun",
    assumption: "Bun stays API-compatible with our Node usage",
    reviewDate: "2026-10-01",
    agent: "tester",
    now: NOW,
    ...overrides,
  };
}

describe("recordDecision", () => {
  test("writes a type: decision note with the captured fields and empty outcome", () => {
    const res = recordDecision(vault, baseInput({ premortem: "Bun ships a breaking change" }));
    expect(res.record.type).toBe(DECISION_TYPE);
    expect(res.record.chosen).toBe("Bun");
    expect(res.record.assumption).toBe("Bun stays API-compatible with our Node usage");
    expect(res.record.reviewDate).toBe("2026-10-01");
    expect(res.record.outcome).toBe("");
    expect(res.record.premortem).toBe("Bun ships a breaking change");
    expect(existsSync(res.record.path)).toBe(true);

    const [meta] = parseFrontmatter(res.record.path);
    expect(meta["type"]).toBe("decision");
    expect(meta["chosen"]).toBe("Bun");
    expect(meta["review_date"]).toBe("2026-10-01");
    expect(meta["outcome"]).toBe("");
  });

  test("premortem is optional", () => {
    const res = recordDecision(vault, baseInput());
    expect(res.record.premortem).toBeNull();
  });

  test("review_date opens exactly one obligation, idempotently", () => {
    const res = recordDecision(vault, baseInput());
    expect(res.obligationCreated).toBe(true);
    const obligations = listObligations(vault);
    expect(obligations.length).toBe(1);
    expect(obligations[0]!.nextDue).toBe("2026-10-01");
  });

  test("logs a decision-record event", () => {
    const res = recordDecision(vault, baseInput());
    const { entries } = readLogDay(vault, "2026-07-18");
    const recorded = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionRecord);
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.body["decision"]).toContain(res.record.id);
  });

  test("refuses to clobber an existing decision", () => {
    recordDecision(vault, baseInput());
    expect(() => recordDecision(vault, baseInput())).toThrow(DecisionError);
  });

  test("rejects malformed input with a typed error", () => {
    expect(() => recordDecision(vault, baseInput({ title: "   " }))).toThrow(DecisionError);
    expect(() => recordDecision(vault, baseInput({ chosen: "" }))).toThrow(DecisionError);
    expect(() => recordDecision(vault, baseInput({ reviewDate: "not-a-date" }))).toThrow(
      DecisionError,
    );
  });
});

describe("backfillOutcome", () => {
  test("mutates the note outcome and logs the mutation", () => {
    const res = recordDecision(vault, baseInput());
    const updated = backfillOutcome(vault, {
      slug: res.record.slug,
      outcome: "Bun worked out; kept it",
      agent: "tester",
      now: new Date("2026-11-01T09:00:00Z"),
    });
    expect(updated.outcome).toBe("Bun worked out; kept it");
    const [meta] = parseFrontmatter(res.record.path);
    expect(meta["outcome"]).toBe("Bun worked out; kept it");

    const { entries } = readLogDay(vault, "2026-11-01");
    const outcomes = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionOutcome);
    expect(outcomes.length).toBe(1);
  });

  test("rejects an unknown decision", () => {
    expect(() => backfillOutcome(vault, { slug: "nope", outcome: "x", agent: "tester" })).toThrow(
      DecisionError,
    );
  });

  test("rejects an empty outcome", () => {
    const res = recordDecision(vault, baseInput());
    expect(() =>
      backfillOutcome(vault, { slug: res.record.slug, outcome: "  ", agent: "tester" }),
    ).toThrow(DecisionError);
  });
});

describe("showDecision / listDecisions", () => {
  test("round-trips a stored decision", () => {
    const res = recordDecision(vault, baseInput({ premortem: "risk" }));
    const shown = showDecision(vault, res.record.slug);
    expect(shown).not.toBeNull();
    expect(shown!.title).toBe("Adopt Bun as the primary runtime");
    expect(shown!.premortem).toBe("risk");
  });

  test("lists decisions sorted by slug", () => {
    recordDecision(vault, baseInput({ title: "Zeta choice", chosen: "z" }));
    recordDecision(vault, baseInput({ title: "Alpha choice", chosen: "a" }));
    const all = listDecisions(vault);
    expect(all.map((d) => d.slug)).toEqual(["alpha-choice", "zeta-choice"]);
  });

  test("returns empty when no decisions dir exists", () => {
    expect(listDecisions(vault)).toEqual([]);
    expect(showDecision(vault, "missing")).toBeNull();
  });
});

describe("rating and rationale (B2)", () => {
  test("captures rating and rationale at record time", () => {
    const res = recordDecision(vault, baseInput({ rating: 4, rationale: "worked well" }));
    expect(res.record.rating).toBe(4);
    expect(res.record.rationale).toBe("worked well");
    const [meta] = parseFrontmatter(res.record.path);
    // The flat frontmatter parser returns scalars as strings.
    expect(meta["rating"]).toBe("4");
    expect(meta["rationale"]).toBe("worked well");
  });

  test("unrated decisions render without rating fields (byte-identical shape)", () => {
    const res = recordDecision(vault, baseInput());
    expect(res.record.rating).toBeNull();
    expect(res.record.rationale).toBe("");
    const raw = readFileSync(res.record.path, "utf8");
    expect(raw).not.toContain("rating:");
    expect(raw).not.toContain("rationale:");
  });

  test("updateRating sets the rating, logs it, and rejects out-of-range values", () => {
    const res = recordDecision(vault, baseInput());
    const updated = updateRating(vault, {
      slug: res.record.slug,
      rating: 5,
      rationale: "great in hindsight",
      agent: "tester",
      now: new Date("2026-11-02T09:00:00Z"),
    });
    expect(updated.rating).toBe(5);
    expect(updated.rationale).toBe("great in hindsight");

    const { entries } = readLogDay(vault, "2026-11-02");
    const rated = entries.filter((e) => e.eventType === BRAIN_LOG_EVENT_KIND.decisionRating);
    expect(rated.length).toBe(1);

    expect(() =>
      updateRating(vault, { slug: res.record.slug, rating: 6, agent: "tester" }),
    ).toThrow(DecisionError);
    expect(() =>
      updateRating(vault, { slug: res.record.slug, rating: 0, agent: "tester" }),
    ).toThrow(DecisionError);
  });

  test("listRatedDecisions returns only rated decisions, sorted by rating desc", () => {
    recordDecision(vault, baseInput({ title: "low one", chosen: "a", rating: 2 }));
    recordDecision(vault, baseInput({ title: "high one", chosen: "b", rating: 5 }));
    recordDecision(vault, baseInput({ title: "unrated one", chosen: "c" }));
    const rated = listRatedDecisions(vault);
    expect(rated.map((d) => d.rating)).toEqual([5, 2]);
  });

  test("compareDecisions returns the requested decisions side by side", () => {
    const a = recordDecision(vault, baseInput({ title: "opt a", chosen: "a", rating: 3 }));
    const b = recordDecision(vault, baseInput({ title: "opt b", chosen: "b", rating: 4 }));
    const compared = compareDecisions(vault, [a.record.slug, b.record.slug]);
    expect(compared.map((d) => d.slug)).toEqual([a.record.slug, b.record.slug]);
    expect(compared[1]!.rating).toBe(4);
  });

  test("rated decisions do not pollute signal/preference recall", () => {
    recordDecision(vault, baseInput({ title: "deploy runtime choice", chosen: "Bun", rating: 5 }));
    const recall = queryByTopic(vault, "deploy");
    expect(recall.signals.length).toBe(0);
    expect(recall.preference).toBeNull();
  });
});

describe("findSimilarDecisions", () => {
  test("surfaces historically similar decisions with their outcomes", () => {
    const prior = recordDecision(
      vault,
      baseInput({ title: "Adopt Bun runtime for the CLI", chosen: "Bun" }),
    );
    backfillOutcome(vault, {
      slug: prior.record.slug,
      outcome: "Great decision",
      agent: "tester",
      now: NOW,
    });
    const hits = findSimilarDecisions(vault, {
      title: "Adopt Bun runtime for the server",
      chosen: "Bun",
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.slug).toBe(prior.record.slug);
    expect(hits[0]!.outcome).toBe("Great decision");
  });

  test("excludes an exact-slug self match", () => {
    const res = recordDecision(vault, baseInput());
    const hits = findSimilarDecisions(vault, {
      title: res.record.title,
      chosen: res.record.chosen,
      excludeSlug: res.record.slug,
    });
    expect(hits.find((h) => h.slug === res.record.slug)).toBeUndefined();
  });
});

describe("decision-change receipts (B4 trail)", () => {
  test("record -> outcome -> rate emits one receipt per mutation in order", () => {
    const rec = recordDecision(vault, baseInput({ now: new Date("2026-07-18T12:00:00Z") }));
    const subject = `[[${rec.record.id}]]`;

    backfillOutcome(vault, {
      slug: rec.record.slug,
      outcome: "held up",
      agent: "tester",
      now: new Date("2026-07-18T12:00:01Z"),
    });
    updateRating(vault, {
      slug: rec.record.slug,
      rating: 5,
      rationale: "worked well",
      agent: "tester",
      now: new Date("2026-07-18T12:00:02Z"),
    });

    const page = queryDecisionChangeHistory(vault, { subject });
    expect(page.total).toBe(3);
    expect(page.receipts.map((r) => r.reason_code)).toEqual([
      DECISION_CHANGE_REASON.record,
      DECISION_CHANGE_REASON.outcome,
      DECISION_CHANGE_REASON.rating,
    ]);

    // The creation receipt carries an explicit absent before-state.
    const [created, outcome, rated] = page.receipts;
    expect(created!.before).toBe("(absent)");
    expect(created!.after).toContain("Bun");
    expect(outcome!.after).toContain("held up");
    expect(rated!.after).toContain("5");
    // Every receipt in the trail shares the one decision subject.
    expect(page.receipts.every((r) => r.subject === subject)).toBe(true);
  });

  test("replaying an identical mutation is idempotent (no duplicate receipt)", () => {
    const rec = recordDecision(vault, baseInput({ now: new Date("2026-07-18T12:00:00Z") }));
    backfillOutcome(vault, {
      slug: rec.record.slug,
      outcome: "held up",
      agent: "tester",
      now: new Date("2026-07-18T12:00:01Z"),
    });
    // Same before/after -> same idempotency key -> no new receipt.
    backfillOutcome(vault, {
      slug: rec.record.slug,
      outcome: "held up",
      agent: "tester",
      now: new Date("2026-07-18T12:00:05Z"),
    });
    const page = queryDecisionChangeHistory(vault, { subject: `[[${rec.record.id}]]` });
    expect(
      page.receipts.filter((r) => r.reason_code === DECISION_CHANGE_REASON.outcome).length,
    ).toBe(1);
  });
});

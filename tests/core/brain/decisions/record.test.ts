import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../../../../src/core/vault.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { listObligations } from "../../../../src/core/brain/obligations.ts";
import {
  DECISION_TYPE,
  DecisionError,
  backfillOutcome,
  findSimilarDecisions,
  listDecisions,
  recordDecision,
  showDecision,
} from "../../../../src/core/brain/decisions/record.ts";

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

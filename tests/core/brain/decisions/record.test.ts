import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, slugify } from "../../../../src/core/vault.ts";
import { readLogDay } from "../../../../src/core/brain/log-jsonl.ts";
import { BRAIN_LOG_EVENT_KIND } from "../../../../src/core/brain/types.ts";
import { listObligations } from "../../../../src/core/brain/obligations.ts";
import { queryByRuleTopic } from "../../../../src/core/brain/query.ts";
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

describe("a decision title in any script", () => {
  test("the non-Latin words of a title stay in its slug, so two projects' titles do not collide", () => {
    const first = recordDecision(vault, baseInput({ title: "Проект release checklist format s1" }));
    const second = recordDecision(
      vault,
      baseInput({ title: "Тема-три release checklist format s1" }),
    );
    expect(first.record.slug).toBe("проект-release-checklist-format-s1");
    expect(second.record.slug).toBe("тема-три-release-checklist-format-s1");
    // Each decision opens its own review obligation: the obligation's slug
    // comes from the same title, so it must not collide either.
    expect(second.obligationCreated).toBe(true);
    expect(listObligations(vault)).toHaveLength(2);
  });

  test("a title with no Latin character keys whole and reads back by its slug", () => {
    const res = recordDecision(vault, baseInput({ title: "Формат страницы релиза" }));
    expect(res.record.slug).toBe("формат-страницы-релиза");
    expect(showDecision(vault, res.record.slug)?.title).toBe("Формат страницы релиза");
    expect(listDecisions(vault).map((d) => d.slug)).toEqual(["формат-страницы-релиза"]);
    const updated = backfillOutcome(vault, {
      slug: res.record.slug,
      outcome: "kept",
      agent: "tester",
    });
    expect(updated.outcome).toBe("kept");
  });

  test("a decomposed title (as a macOS file system hands it over) keys like the composed one", () => {
    recordDecision(vault, baseInput({ title: "Выбор й" }));
    expect(() => recordDecision(vault, baseInput({ title: "Выбор \u0438\u0306" }))).toThrow(
      DecisionError,
    );
  });

  test("a Latin title keeps the slug it always had", () => {
    const res = recordDecision(vault, baseInput({ title: "Adopt Bun: the primary runtime (v2)!" }));
    expect(res.record.slug).toBe("adopt-bun-the-primary-runtime-v2");
  });
});

/** Record `title`, then move its page to the name an older release gave it. */
function storeUnderOldSlug(title: string, oldSlug: string): void {
  const res = recordDecision(vault, baseInput({ title }));
  const dir = join(vault, "Brain", "decisions");
  renameSync(join(dir, `decision-${res.record.slug}.md`), join(dir, `decision-${oldSlug}.md`));
}

describe("a decision stored under its old Latin-only slug", () => {
  // Before titles kept letters of any script, "Проект release checklist
  // format" was written as decision-release-checklist-format.md and a
  // title with no Latin letter as decision-unnamed-<hash>.md. Such pages
  // stay where they are; the lookup must still find them by their title.
  test("its title finds it for show, compare, backfill and rating", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    const title = "Проект release checklist format";
    expect(showDecision(vault, title)?.slug).toBe("release-checklist-format");
    expect(compareDecisions(vault, [title]).map((d) => d.slug)).toEqual([
      "release-checklist-format",
    ]);
    const backfilled = backfillOutcome(vault, { slug: title, outcome: "kept", agent: "tester" });
    expect(backfilled.path).toBe(
      join(vault, "Brain", "decisions", "decision-release-checklist-format.md"),
    );
    const rated = updateRating(vault, { slug: title, rating: 4, agent: "tester" });
    expect(rated.outcome).toBe("kept");
    expect(rated.rating).toBe(4);
    // Its stored slug still finds it too.
    expect(showDecision(vault, "release-checklist-format")?.title).toBe(title);
  });

  test("a title with no Latin letter finds the page its hashed fallback named", () => {
    const title = "Формат страницы релиза";
    storeUnderOldSlug(title, slugify(title));
    expect(slugify(title)).toMatch(/^unnamed-[0-9a-f]{8}$/u);
    expect(showDecision(vault, title)?.title).toBe(title);
  });

  test("another title that shared the old slug does not reach the page", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    expect(showDecision(vault, "Тема-три release checklist format")).toBeNull();
    expect(() =>
      backfillOutcome(vault, {
        slug: "Тема-три release checklist format",
        outcome: "x",
        agent: "tester",
      }),
    ).toThrow(DecisionError);
  });

  test("recording the same title again is refused, as it was before the slug changed", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    expect(() =>
      recordDecision(vault, baseInput({ title: "Проект release checklist format" })),
    ).toThrow(/decision already exists: release-checklist-format/);
    expect(listDecisions(vault)).toHaveLength(1);
  });

  test("a review obligation an older release stored under its old slug is not opened twice", () => {
    const title = "Проект release checklist format";
    storeUnderOldSlug(title, "release-checklist-format");
    const [review] = listObligations(vault);
    const dir = join(vault, "Brain", "obligations");
    renameSync(join(dir, `${review!.slug}.md`), join(dir, `${slugify(review!.title)}.md`));
    // The decision page is removed by hand, the obligation stays; recording
    // the title again reuses that obligation.
    rmSync(join(vault, "Brain", "decisions", "decision-release-checklist-format.md"));
    const again = recordDecision(vault, baseInput({ title }));
    expect(again.obligationCreated).toBe(false);
    expect(listObligations(vault)).toHaveLength(1);
  });

  test("a new decision keeps the new slug next to an old page", () => {
    storeUnderOldSlug("Проект release checklist format", "release-checklist-format");
    const res = recordDecision(vault, baseInput({ title: "Тема-три release checklist format" }));
    expect(res.record.slug).toBe("тема-три-release-checklist-format");
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
    const recall = queryByRuleTopic(vault, "deploy");
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

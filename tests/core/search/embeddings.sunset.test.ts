/**
 * The sunset survey, and the three statements it is allowed to make.
 *
 * The distinction this file exists to hold is between "no decommission has
 * been announced for this model" and "this model is outside the survey, so
 * no statement was made about it". They are different facts and the second
 * is the NORMAL case - `embedding_model` is a free string with no
 * validation and this tool's own onboarding text recommends a preview
 * model that is in no catalog here. Collapsing them into silence is the
 * misleading-silence defect the codebase has already ruled on twice, for
 * the input window (`declaredInputWindowTokens`) and for the
 * `window-undeclared` census verdict.
 *
 * The third statement is the one a static catalog owes: a NEGATIVE is a
 * claim about the world and it expires. Past the horizon, "nothing
 * announced" becomes `undetermined` with `survey_stale` rather than
 * staying a confident negative that nobody has re-checked.
 */

import { describe, expect, test } from "bun:test";

import {
  classifyEmbeddingSunset,
  EMBEDDING_SUNSET,
  EMBEDDING_SUNSET_SOURCE,
  EMBEDDING_SUNSET_STATES,
  EMBEDDING_SUNSET_SURVEY,
  EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS,
  EMBEDDING_SUNSET_UNDETERMINED_REASON,
  EMBEDDING_SUNSET_UNDETERMINED_REASONS,
  isEmbeddingSunsetState,
  isEmbeddingSunsetUndeterminedReason,
  type EmbeddingSunsetSurvey,
} from "../../../src/core/search/embeddings/sunset.ts";
import { isValidIsoInstant, parseIsoUtc } from "../../../src/core/brain/health/iso-time.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
/** A model string no shipped row carries, so a fixture owns it outright. */
const MODEL_A = "vendor/model-x";

/** A survey under this test's control, reviewed the day before `NOW`. */
function survey(entries: EmbeddingSunsetSurvey["entries"]): EmbeddingSunsetSurvey {
  return { reviewedAt: "2026-05-31", entries };
}

describe("a declared decommission date is reported with its date", () => {
  test("a date in the future yields `announced` and the days remaining", () => {
    const s = survey([
      { model: "vendor/model-x", sunsetAt: "2026-07-01", source: "unit fixture", note: "" },
    ]);
    const verdict = classifyEmbeddingSunset("vendor/model-x", NOW, s);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.announced);
    expect(verdict.sunset_at).toBe("2026-07-01");
    expect(verdict.days_remaining).toBe(30);
    expect(verdict.reason).toBeNull();
  });

  test("a date already past is still `announced`, with a negative remainder", () => {
    const s = survey([
      { model: "vendor/model-x", sunsetAt: "2026-05-01", source: "unit fixture", note: "" },
    ]);
    const verdict = classifyEmbeddingSunset("vendor/model-x", NOW, s);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.announced);
    expect(verdict.days_remaining).toBeLessThan(0);
  });

  test("lookup is by exact model string, with no family inference", () => {
    const s = survey([
      { model: "vendor/model-x", sunsetAt: "2026-07-01", source: "unit fixture", note: "" },
    ]);
    // `vendor/model-x-turbo` is a different checkpoint with a different
    // lifecycle; inferring a date from a shared prefix would invent one.
    expect(classifyEmbeddingSunset("vendor/model-x-turbo", NOW, s).state).toBe(
      EMBEDDING_SUNSET.unsurveyed,
    );
  });
});

describe("`unsurveyed` is never reported as `none_announced`", () => {
  test("a model outside the survey is its own state", () => {
    const verdict = classifyEmbeddingSunset("openrouter/whatever", NOW, survey([]));
    expect(verdict.state).toBe(EMBEDDING_SUNSET.unsurveyed);
    expect(verdict.state).not.toBe(EMBEDDING_SUNSET.noneAnnounced);
    expect(verdict.sunset_at).toBeNull();
  });

  test("a surveyed model with no announcement is the other state", () => {
    const s = survey([
      { model: "vendor/model-y", sunsetAt: null, source: "unit fixture", note: "" },
    ]);
    expect(classifyEmbeddingSunset("vendor/model-y", NOW, s).state).toBe(
      EMBEDDING_SUNSET.noneAnnounced,
    );
  });

  test("the tool's own recommended onboarding model is unsurveyed, not clean", () => {
    // `src/cli/main.ts` recommends a preview model that no catalog here
    // carries. That is the normal case, and it must read as "no statement
    // was made" rather than as a clean bill of health.
    const verdict = classifyEmbeddingSunset("google/gemini-embedding-2-preview", NOW);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.unsurveyed);
  });
});

describe("a negative expires; the survey's own age bounds what it may claim", () => {
  test("past the horizon, `none_announced` degrades to undetermined", () => {
    const s = survey([
      { model: "vendor/model-y", sunsetAt: null, source: "unit fixture", note: "" },
    ]);
    const later =
      parseIsoUtc(s.reviewedAt) + (EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS + 1) * MS_PER_DAY;
    const verdict = classifyEmbeddingSunset("vendor/model-y", later, s);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.undetermined);
    expect(verdict.reason).toBe(EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyStale);
  });

  test("a declared date survives a stale survey - a shutdown that was announced happened", () => {
    const s = survey([
      { model: "vendor/model-x", sunsetAt: "2030-01-01", source: "unit fixture", note: "" },
    ]);
    const later =
      parseIsoUtc(s.reviewedAt) + (EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS + 1) * MS_PER_DAY;
    expect(classifyEmbeddingSunset("vendor/model-x", later, s).state).toBe(
      EMBEDDING_SUNSET.announced,
    );
  });

  test("every verdict carries the review date it rests on", () => {
    const s = survey([]);
    expect(classifyEmbeddingSunset("anything", NOW, s).surveyed_at).toBe(s.reviewedAt);
  });
});

describe("what the classifier cannot establish", () => {
  test("no configured model is undetermined, never `none_announced`", () => {
    const verdict = classifyEmbeddingSunset(null, NOW, survey([]));
    expect(verdict.state).toBe(EMBEDDING_SUNSET.undetermined);
    expect(verdict.reason).toBe(EMBEDDING_SUNSET_UNDETERMINED_REASON.modelUnresolved);
  });

  test("a malformed date in the survey is refused loudly, never read as absent", () => {
    const s = survey([
      { model: "vendor/model-z", sunsetAt: "not-a-date", source: "unit fixture", note: "" },
    ]);
    const verdict = classifyEmbeddingSunset("vendor/model-z", NOW, s);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.undetermined);
    expect(verdict.reason).toBe(EMBEDDING_SUNSET_UNDETERMINED_REASON.surveyEntryMalformed);
  });
});

describe("the clock is a parameter", () => {
  test("two instants over one survey give two verdicts", () => {
    const s = survey([
      { model: "vendor/model-y", sunsetAt: null, source: "unit fixture", note: "" },
    ]);
    const early = classifyEmbeddingSunset("vendor/model-y", parseIsoUtc(s.reviewedAt), s);
    const late = classifyEmbeddingSunset(
      "vendor/model-y",
      parseIsoUtc(s.reviewedAt) + (EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS + 1) * MS_PER_DAY,
      s,
    );
    expect(early.state).not.toBe(late.state);
  });
});

describe("an operator declaration layers OVER the survey", () => {
  const DECLARED = "2026-09-01";

  test("it answers for a model the survey never heard of", () => {
    const verdict = classifyEmbeddingSunset("vendor-q/private-embed", NOW, survey([]), {
      model: "vendor-q/private-embed",
      sunsetAt: DECLARED,
    });
    expect(verdict.state).toBe(EMBEDDING_SUNSET.announced);
    expect(verdict.sunset_at).toBe(DECLARED);
    expect(verdict.source).toBe(EMBEDDING_SUNSET_SOURCE.declaration);
    expect(verdict.overrode_survey).toBe(false);
  });

  test("it WINS over a survey row that names a different date, and says so", () => {
    const s = survey([
      { model: MODEL_A, sunsetAt: "2027-01-01", source: "unit fixture", note: "" },
    ]);
    const verdict = classifyEmbeddingSunset(MODEL_A, NOW, s, {
      model: MODEL_A,
      sunsetAt: DECLARED,
    });
    // The declaration exists BECAUSE the static table goes stale, so the
    // operator who just read the vendor's notice outranks a table frozen
    // at release. The disagreement is carried, never erased.
    expect(verdict.sunset_at).toBe(DECLARED);
    expect(verdict.source).toBe(EMBEDDING_SUNSET_SOURCE.declaration);
    expect(verdict.overrode_survey).toBe(true);
    expect(verdict.survey_sunset_at).toBe("2027-01-01");
  });

  test("it WINS over a surveyed negative, and the contradiction is visible", () => {
    const s = survey([{ model: MODEL_A, sunsetAt: null, source: "unit fixture", note: "" }]);
    const verdict = classifyEmbeddingSunset(MODEL_A, NOW, s, {
      model: MODEL_A,
      sunsetAt: DECLARED,
    });
    expect(verdict.state).toBe(EMBEDDING_SUNSET.announced);
    expect(verdict.overrode_survey).toBe(true);
    // `null` is the survey's answer, not an absence of one.
    expect(verdict.survey_sunset_at).toBeNull();
  });

  test("the SURVEY wins when the declaration is about another model", () => {
    // The other direction. A declaration names its model explicitly, so a
    // stale one cannot silently re-target itself at whatever the operator
    // configured next.
    const s = survey([
      { model: MODEL_A, sunsetAt: "2027-01-01", source: "unit fixture", note: "" },
    ]);
    const verdict = classifyEmbeddingSunset(MODEL_A, NOW, s, {
      model: "some-other/model",
      sunsetAt: DECLARED,
    });
    expect(verdict.sunset_at).toBe("2027-01-01");
    expect(verdict.source).toBe(EMBEDDING_SUNSET_SOURCE.survey);
    expect(verdict.overrode_survey).toBe(false);
  });

  test("a verdict from neither layer names neither", () => {
    const verdict = classifyEmbeddingSunset("nobody/knows", NOW, survey([]));
    expect(verdict.state).toBe(EMBEDDING_SUNSET.unsurveyed);
    expect(verdict.source).toBe(EMBEDDING_SUNSET_SOURCE.none);
  });

  test("a declaration this build cannot parse is a caller's error, not a vault's verdict", () => {
    // It used to be `undetermined/declaration_malformed`: a reported
    // state, with its own vocabulary member and its own four-sentence
    // operator message, that no vault could produce. `sunset_at` is
    // validated by `parseEmbeddingsBlock` - the only producer of
    // `BrainConfig.embeddings` - which throws a `BrainConfigError` naming
    // the key at load time, and that refusal is pinned in
    // `tests/core/brain/policy/embeddings-block.test.ts`. What is left
    // here is an invariant over an exported function, and it says so
    // rather than inventing an instant.
    expect(() =>
      classifyEmbeddingSunset(MODEL_A, NOW, survey([]), {
        model: MODEL_A,
        sunsetAt: "next tuesday",
      }),
    ).toThrow(TypeError);
  });
});

describe("the shipped survey reaches the `announced` arm in production", () => {
  test("it carries at least one positive row - the code has a real producer", () => {
    // The reason this assertion exists: a registered doctor code whose
    // only producer is a table with no positive rows is a declared
    // surface with nothing behind it, which is the defect this release
    // hunts in other people's code.
    const positives = EMBEDDING_SUNSET_SURVEY.entries.filter((e) => e.sunsetAt !== null);
    expect(positives.length).toBeGreaterThan(0);
  });

  test("a first-generation OpenAI model resolves to its real shutdown date", () => {
    // No injected fixture: this is the shipped table answering.
    const verdict = classifyEmbeddingSunset("text-search-ada-doc-001", NOW);
    expect(verdict.state).toBe(EMBEDDING_SUNSET.announced);
    expect(verdict.sunset_at).toBe("2024-01-04");
    // The date is in the past, so an operator restoring an old config is
    // told the model is already gone rather than finding out at index time.
    expect(verdict.days_remaining).toBeLessThan(0);
  });

  test("a live sibling of a shut-down model is NOT reported as shut down", () => {
    // `text-search-ada-doc-001` is gone and `text-embedding-ada-002` is
    // not; a prefix rule over "ada" would report a working model dead.
    expect(classifyEmbeddingSunset("text-embedding-ada-002", NOW).state).toBe(
      EMBEDDING_SUNSET.noneAnnounced,
    );
  });
});

describe("the shipped survey is well formed", () => {
  test("every row records where its answer came from", () => {
    const unsourced = EMBEDDING_SUNSET_SURVEY.entries
      .filter((e) => e.source.trim().length === 0)
      .map((e) => e.model);
    expect(unsourced.join("\n")).toBe("");
  });

  test("every POSITIVE row cites a retrievable source", () => {
    // A date is a claim about somebody else's product. An entry that
    // cannot be checked against the announcement it came from is exactly
    // the invented value this design refuses.
    const uncitable = EMBEDDING_SUNSET_SURVEY.entries
      .filter((e) => e.sunsetAt !== null && !e.source.includes("https://"))
      .map((e) => e.model);
    expect(uncitable.join("\n")).toBe("");
  });

  test("its review date is a real ISO date", () => {
    expect(isValidIsoInstant(EMBEDDING_SUNSET_SURVEY.reviewedAt)).toBe(true);
  });

  test("no model is surveyed twice", () => {
    const models = EMBEDDING_SUNSET_SURVEY.entries.map((e) => e.model);
    expect(new Set(models).size).toBe(models.length);
  });

  test("every declared date parses, and every entry says where it came from", () => {
    const bad: string[] = [];
    for (const entry of EMBEDDING_SUNSET_SURVEY.entries) {
      if (entry.sunsetAt !== null && !isValidIsoInstant(entry.sunsetAt)) {
        bad.push(`${entry.model}: unparseable sunsetAt ${entry.sunsetAt}`);
      }
      if (entry.source.trim().length === 0) bad.push(`${entry.model}: empty source`);
    }
    expect(bad.join("\n")).toBe("");
  });
});

describe("the vocabularies are closed and carry the could-not-tell member", () => {
  test("`undetermined` is a member", () => {
    expect(EMBEDDING_SUNSET_STATES).toContain(EMBEDDING_SUNSET.undetermined);
  });

  test("a reason is never readable back as a state", () => {
    for (const reason of EMBEDDING_SUNSET_UNDETERMINED_REASONS) {
      expect(`${reason} is a state: ${isEmbeddingSunsetState(reason)}`).toBe(
        `${reason} is a state: false`,
      );
    }
    for (const state of EMBEDDING_SUNSET_STATES) {
      expect(`${state} is a reason: ${isEmbeddingSunsetUndeterminedReason(state)}`).toBe(
        `${state} is a reason: false`,
      );
    }
  });
});

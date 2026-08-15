/**
 * The doctor half of the sunset warning (t_e7a226ce).
 *
 * The classifier is tested next door; what this file pins is the check's
 * own judgements: which verdicts become a warning, which reach the
 * uncertain stream, which are silence, and that the message never claims
 * to name a vendor.
 *
 * The last one is not a style rule. The resolved `provider` is one of four
 * TRANSPORT kinds - `openai-compat` says nothing about whose endpoint it
 * is - and vendor identity exists only inside a free-form
 * `embedding_base_url` that nothing in the tree maps. A message naming a
 * vendor would be inferring it from a URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import {
  EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE,
  EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE,
  EMBEDDING_MODEL_SUNSET_UNSURVEYED_CODE,
  EMBEDDING_SUNSET_WARNING_WINDOW_DAYS,
  makeEmbeddingSunsetCheck,
} from "../../../../src/core/brain/doctor/embedding-sunset-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import type { EmbeddingSunsetSurvey } from "../../../../src/core/search/embeddings/sunset.ts";
import { EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS } from "../../../../src/core/search/embeddings/sunset.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const MODEL = "vendor-x/embed-v1";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sunset-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-sunset-cfg-"));
  configPath = join(configHome, "config.yaml");
  bootstrapBrain(vault);
  configure(MODEL);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

/** Semantic search on, an openai-compatible endpoint, and `model`. */
function configure(model: string | null): void {
  const lines = [
    `vault: ${vault}`,
    `search_semantic_enabled: "true"`,
    `embedding_provider: "openai-compat"`,
    `embedding_base_url: "https://example.invalid/v1"`,
  ];
  if (model !== null) lines.push(`embedding_model: "${model}"`);
  writeFileSync(configPath, lines.join("\n") + "\n");
}

function surveyWith(sunsetAt: string | null): EmbeddingSunsetSurvey {
  return {
    reviewedAt: "2026-05-31",
    entries: [{ model: MODEL, sunsetAt, source: "unit fixture", note: "" }],
  };
}

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(survey: EmbeddingSunsetSurvey, now: Date = NOW): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  makeEmbeddingSunsetCheck(survey).run(
    { vault, now, configPath } as unknown as DoctorCheckContext,
    { issues, uncertain },
  );
  return { issues, uncertain };
}

/** Every code the run reported, on either stream. */
function reportedCodes(result: RunResult): ReadonlyArray<string> {
  return [...result.issues, ...result.uncertain].map((e) => e.code);
}

function announced(result: RunResult): ReadonlyArray<DoctorIssue> {
  return result.issues.filter((i) => i.code === EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE);
}

/** Days before `NOW`, as the `YYYY-MM-DD` a survey entry carries. */
function inDays(days: number): string {
  return new Date(NOW.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

describe("a declared date inside the window is a warning naming model and date", () => {
  test("the warning carries both facts", () => {
    const date = inDays(EMBEDDING_SUNSET_WARNING_WINDOW_DAYS - 10);
    const issues = announced(run(surveyWith(date)));
    expect(issues.length).toBe(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.message).toContain(MODEL);
    expect(issues[0]!.message).toContain(date);
  });

  test("a date beyond the window is not yet a finding", () => {
    const date = inDays(EMBEDDING_SUNSET_WARNING_WINDOW_DAYS + 30);
    const result = run(surveyWith(date));
    expect(announced(result)).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("a date already past is still the warning", () => {
    const issues = announced(run(surveyWith(inDays(-5))));
    expect(issues.length).toBe(1);
  });

  test("the message never claims to name a vendor", () => {
    const message = announced(run(surveyWith(inDays(10))))[0]!.message;
    // The four transport kinds and the base URL are all things the check
    // COULD have reached for and must not present as a vendor identity.
    for (const forbidden of ["openai-compat", "zeroentropy", "example.invalid"]) {
      expect(`${forbidden} in message: ${message.includes(forbidden)}`).toBe(
        `${forbidden} in message: false`,
      );
    }
  });
});

describe("a model unknown to the survey is distinguishable from a clean one", () => {
  test("unsurveyed reaches the uncertain stream under its own code", () => {
    const result = run({ reviewedAt: "2026-05-31", entries: [] });
    expect(announced(result)).toEqual([]);
    const entry = result.uncertain.find((e) => e.code === EMBEDDING_MODEL_SUNSET_UNSURVEYED_CODE);
    expect(entry).toBeDefined();
    expect(entry!.message).toContain(MODEL);
  });

  test("a surveyed model with no announcement produces nothing at all", () => {
    const result = run(surveyWith(null));
    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });

  test("the two states never share a code", () => {
    const unknown = run({ reviewedAt: "2026-05-31", entries: [] });
    const clean = run(surveyWith(null));
    expect(reportedCodes(unknown)).not.toEqual(reportedCodes(clean));
  });
});

describe("what the check cannot establish reaches the uncertain stream", () => {
  test("a stale survey stops the negative being reported as clean", () => {
    const survey = surveyWith(null);
    const late = new Date(
      Date.parse(`${survey.reviewedAt}T00:00:00Z`) +
        (EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS + 1) * MS_PER_DAY,
    );
    const result = run(survey, late);
    expect(result.uncertain.some((e) => e.code === EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE)).toBe(
      true,
    );
  });

  test("semantic search enabled with no model resolved is uncertain", () => {
    configure(null);
    const result = run(surveyWith(null));
    expect(result.uncertain.some((e) => e.code === EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE)).toBe(
      true,
    );
  });

  test("semantic search switched off says nothing - there is no model in use", () => {
    writeFileSync(configPath, `vault: ${vault}\nsearch_semantic_enabled: "false"\n`);
    const result = run(surveyWith(inDays(1)));
    expect(result.issues).toEqual([]);
    expect(result.uncertain).toEqual([]);
  });
});

describe("the clock is injected, never read", () => {
  test("two clocks over one configuration give two verdicts", () => {
    const survey = surveyWith(inDays(EMBEDDING_SUNSET_WARNING_WINDOW_DAYS + 30));
    const early = run(survey, NOW);
    const late = run(survey, new Date(NOW.getTime() + 60 * MS_PER_DAY));
    expect(announced(early)).toEqual([]);
    expect(announced(late).length).toBe(1);
  });
});

describe("every code is classified exactly once", () => {
  test("the warning code carries a registered command", () => {
    expect(DIAGNOSTIC_SIGNALS.has(EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE)).toBe(true);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(EMBEDDING_MODEL_SUNSET_ANNOUNCED_CODE)).toBe(false);
  });

  test("both uncertain codes carry a written reason instead", () => {
    for (const code of [
      EMBEDDING_MODEL_SUNSET_UNSURVEYED_CODE,
      EMBEDDING_MODEL_SUNSET_UNDETERMINED_CODE,
    ]) {
      expect(`${code} excluded: ${DOCTOR_EXIT_EXCLUSIONS.has(code)}`).toBe(
        `${code} excluded: true`,
      );
      expect(`${code} registered: ${DIAGNOSTIC_SIGNALS.has(code)}`).toBe(
        `${code} registered: false`,
      );
    }
  });
});

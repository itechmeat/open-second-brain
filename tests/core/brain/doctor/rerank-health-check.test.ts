/**
 * The config-only rerank doctor check.
 *
 * Pins the four judgements the check owns: a rerank that is off or not
 * the remote kind is silence; an enabled remote rerank that cannot
 * resolve its endpoint is one error naming every missing piece; an
 * announced decommission inside the warning window (or past) is a
 * warning naming the model and the date; an off-survey model or a stale
 * survey reaches the uncertain stream. The check reads configuration only,
 * so a run with `fetch` replaced by a thrower must still complete.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DIAGNOSTIC_SIGNALS } from "../../../../src/core/brain/diagnostics.ts";
import type { DoctorCheckContext } from "../../../../src/core/brain/doctor/check.ts";
import { EMBEDDING_SUNSET_WARNING_WINDOW_DAYS } from "../../../../src/core/brain/doctor/embedding-sunset-check.ts";
import {
  makeRerankHealthCheck,
  RERANK_ENDPOINT_UNCONFIGURED_CODE,
  RERANK_MODEL_SUNSET_ANNOUNCED_CODE,
  RERANK_MODEL_SUNSET_UNDETERMINED_CODE,
  RERANK_MODEL_SUNSET_UNSURVEYED_CODE,
} from "../../../../src/core/brain/doctor/rerank-health-check.ts";
import type { DoctorUncertainEntry } from "../../../../src/core/brain/doctor/report.ts";
import { DOCTOR_EXIT_EXCLUSIONS } from "../../../../src/core/brain/doctor-exits.ts";
import { runDoctor } from "../../../../src/core/brain/doctor.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import {
  EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS,
  type EmbeddingSunsetSurvey,
} from "../../../../src/core/search/embeddings/sunset.ts";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const MODEL = "vendor-x/rerank-v1";
const BASE_URL = "https://example.invalid/v1";
/** An env var name unique to this file, so no other test can set it. */
const KEY_VAR = "O2B_TEST_RERANK_HEALTH_CHECK_KEY";

let vault: string;
let configHome: string;
let configPath: string;

interface RerankConfig {
  readonly enabled?: boolean;
  readonly kind?: string;
  readonly baseUrl?: string | null;
  readonly model?: string | null;
  readonly envKey?: string | null;
  readonly provider?: string;
  readonly allowInsecureHttp?: boolean;
}

/** Write the `o2b` config; every field defaults to a complete remote rerank. */
function configure(c: RerankConfig = {}): void {
  const lines = [`vault: ${vault}`, `search_rerank_enabled: "${c.enabled ?? true}"`];
  if (c.kind !== undefined) lines.push(`search_rerank_kind: "${c.kind}"`);
  const baseUrl = c.baseUrl === undefined ? BASE_URL : c.baseUrl;
  const model = c.model === undefined ? MODEL : c.model;
  const envKey = c.envKey === undefined ? KEY_VAR : c.envKey;
  if (baseUrl !== null) lines.push(`search_rerank_base_url: "${baseUrl}"`);
  if (model !== null) lines.push(`search_rerank_model: "${model}"`);
  if (envKey !== null) lines.push(`search_rerank_env_key: "${envKey}"`);
  if (c.provider !== undefined) lines.push(`search_rerank_provider: "${c.provider}"`);
  if (c.allowInsecureHttp !== undefined) {
    lines.push(`search_rerank_allow_insecure_http: "${c.allowInsecureHttp}"`);
  }
  writeFileSync(configPath, lines.join("\n") + "\n");
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-rerank-check-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-rerank-check-cfg-"));
  configPath = join(configHome, "config.yaml");
  bootstrapBrain(vault);
  process.env[KEY_VAR] = "test-key";
  configure();
});

afterEach(() => {
  delete process.env[KEY_VAR];
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function surveyWith(
  sunsetAt: string | null,
  reviewedAt = "2026-05-31",
  model = MODEL,
): EmbeddingSunsetSurvey {
  return { reviewedAt, entries: [{ model, sunsetAt, source: "unit fixture", note: "" }] };
}

/** A survey that covers the model with a negative, so sunset says nothing. */
const QUIET_SURVEY = surveyWith(null);

interface RunResult {
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly uncertain: ReadonlyArray<DoctorUncertainEntry>;
}

function run(survey: EmbeddingSunsetSurvey = QUIET_SURVEY, now: Date = NOW): RunResult {
  const issues: DoctorIssue[] = [];
  const uncertain: DoctorUncertainEntry[] = [];
  makeRerankHealthCheck(survey).run({ vault, now, configPath } as unknown as DoctorCheckContext, {
    issues,
    uncertain,
  });
  return { issues, uncertain };
}

function codes(result: RunResult): ReadonlyArray<string> {
  return [...result.issues, ...result.uncertain].map((e) => e.code);
}

function inDays(days: number): string {
  return new Date(NOW.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

describe("silence where rerank is not a remote endpoint", () => {
  test("rerank disabled reports nothing, even with every key missing", () => {
    configure({ enabled: false, baseUrl: null, model: null, envKey: null });
    expect(codes(run())).toEqual([]);
  });

  test("the local and decision-model kinds report nothing", () => {
    for (const kind of ["local", "decision-model"]) {
      configure({ kind, baseUrl: null, model: null, envKey: null });
      expect(codes(run(surveyWith(inDays(-5))))).toEqual([]);
    }
  });

  test("a complete remote rerank on a surveyed negative reports nothing", () => {
    expect(codes(run())).toEqual([]);
  });
});

describe("an enabled remote rerank that cannot resolve its endpoint is one error", () => {
  const cases: ReadonlyArray<readonly [string, RerankConfig, string]> = [
    ["no base URL", { baseUrl: null }, "search_rerank_base_url"],
    ["no model", { model: null }, "search_rerank_model"],
    ["no key variable", { envKey: null }, "search_rerank_env_key"],
  ];
  for (const [name, config, named] of cases) {
    test(name, () => {
      configure(config);
      const { issues, uncertain } = run();
      expect(issues.map((i) => [i.code, i.severity])).toEqual([
        [RERANK_ENDPOINT_UNCONFIGURED_CODE, "error"],
      ]);
      expect(issues[0]!.message).toContain(named);
      expect(uncertain).toEqual([]);
    });
  }

  test("a key variable that is set nowhere names the variable, never a value", () => {
    delete process.env[KEY_VAR];
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain(KEY_VAR);
  });

  test("an unregistered provider name that leaves a field empty is named in the error", () => {
    configure({ provider: "nobody-registered-this", baseUrl: null });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("nobody-registered-this");
  });

  test("an unregistered provider name beside a complete explicit endpoint is no finding", () => {
    // The explicit search_rerank_* values win over a profile, so search
    // works and a fail-closed error would be false.
    configure({ provider: "nobody-registered-this" });
    expect(codes(run())).toEqual([]);
  });

  test("an unregistered provider name is not blamed for an unset key value", () => {
    // A profile supplies the key variable's name, never its value.
    configure({ provider: "nobody-registered-this" });
    delete process.env[KEY_VAR];
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain(KEY_VAR);
    expect(issues[0]!.message).not.toContain("nobody-registered-this");
  });

  test("an unregistered provider name is not blamed for a refused base URL", () => {
    // A profile could have supplied a base URL, but not repaired this one.
    configure({ provider: "nobody-registered-this", baseUrl: "http://example.invalid/v1" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("search_rerank_base_url must be an https endpoint");
    expect(issues[0]!.message).not.toContain("nobody-registered-this");
  });

  test("a key variable set to blank is the error the runtime would raise", () => {
    process.env[KEY_VAR] = "  ";
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain(KEY_VAR);
  });

  test("a blank model is the same error as a missing one", () => {
    configure({ model: " " });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("search_rerank_model");
  });

  test("a base URL the endpoint rule refuses is the same error, naming the rule", () => {
    configure({ baseUrl: "http://example.invalid/v1" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("search_rerank_base_url must be an https endpoint");
  });

  test("a plain-http base URL under the opt-out is accepted without the runtime warning", () => {
    // The once-per-process plain-http warning belongs to the search that
    // sends vault text; doctor must not print it or spend it.
    configure({ baseUrl: "http://rerank-doctor-optout.lan:8080/v1", allowInsecureHttp: true });
    const stderr = spyOn(process.stderr, "write");
    try {
      const { issues } = run();
      expect(issues.map((i) => i.code)).not.toContain(RERANK_ENDPOINT_UNCONFIGURED_CODE);
      const written = stderr.mock.calls.map((call) => String(call[0]));
      expect(written.filter((line) => line.includes("plain http"))).toEqual([]);
    } finally {
      stderr.mockRestore();
    }
  });

  test("a base URL carrying credentials is refused without repeating them", () => {
    // The key travels in a header; a user:password@ part never belongs in
    // the URL, and doctor output is pasted into issues, so it is not echoed.
    configure({ baseUrl: "http://user:s3cret@lan-host.invalid:8080/v1" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain(
      "search_rerank_base_url must not carry user:password@ credentials",
    );
    expect(issues[0]!.message).not.toContain("s3cret");
  });

  test("an unparseable base URL that carries credentials is refused without repeating it", () => {
    // The URL parser rejects the port, so no userinfo is detected; the
    // endpoint rule's own message must not echo the configured value.
    configure({ baseUrl: "http://u:secretpw@h:abc/v1" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("<search_rerank_base_url>");
    expect(issues[0]!.message).not.toContain("secretpw");
  });

  test("a scheme-less base URL that carries credentials is refused without repeating it", () => {
    configure({ baseUrl: "u:secretpw@h/v1" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("<search_rerank_base_url>");
    expect(issues[0]!.message).not.toContain("secretpw");
  });

  test("a base URL that is not a URL is the same error", () => {
    configure({ baseUrl: "not a url" });
    const { issues } = run();
    expect(issues.map((i) => i.code)).toEqual([RERANK_ENDPOINT_UNCONFIGURED_CODE]);
    expect(issues[0]!.message).toContain("search_rerank_base_url is not a URL");
  });

  test("a registered provider name supplies the missing endpoint fields", () => {
    mkdirSync(join(vault, "Brain", "search"), { recursive: true });
    writeFileSync(
      join(vault, "Brain", "search", "rerank-providers.json"),
      JSON.stringify([
        { name: "fixture", baseUrl: BASE_URL, defaultModel: MODEL, envKey: KEY_VAR },
      ]),
    );
    configure({ provider: "fixture", baseUrl: null, model: null, envKey: null });
    expect(codes(run())).toEqual([]);
  });

  test("several missing pieces are still one finding naming each", () => {
    configure({ baseUrl: null, model: null });
    const { issues } = run();
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("search_rerank_base_url");
    expect(issues[0]!.message).toContain("search_rerank_model");
  });
});

describe("an announced decommission is a warning naming model and date", () => {
  test("inside the window", () => {
    const date = inDays(EMBEDDING_SUNSET_WARNING_WINDOW_DAYS - 10);
    const { issues } = run(surveyWith(date));
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      [RERANK_MODEL_SUNSET_ANNOUNCED_CODE, "warning"],
    ]);
    expect(issues[0]!.message).toContain(MODEL);
    expect(issues[0]!.message).toContain(date);
  });

  test("already past", () => {
    const date = inDays(-5);
    const { issues } = run(surveyWith(date));
    expect(issues.map((i) => i.code)).toEqual([RERANK_MODEL_SUNSET_ANNOUNCED_CODE]);
    expect(issues[0]!.message).toContain(date);
  });

  test("beyond the window is not yet a finding", () => {
    expect(codes(run(surveyWith(inDays(EMBEDDING_SUNSET_WARNING_WINDOW_DAYS + 30))))).toEqual([]);
  });
});

describe("what the survey cannot say reaches the uncertain stream", () => {
  test("an off-survey model is unsurveyed", () => {
    const { issues, uncertain } = run(surveyWith(null, "2026-05-31", "some-other-model"));
    expect(issues).toEqual([]);
    expect(uncertain.map((u) => u.code)).toEqual([RERANK_MODEL_SUNSET_UNSURVEYED_CODE]);
    expect(uncertain[0]!.message).toContain(MODEL);
  });

  test("a stale survey is undetermined", () => {
    const stale = new Date(
      new Date("2026-05-31T00:00:00.000Z").getTime() +
        (EMBEDDING_SUNSET_SURVEY_HORIZON_DAYS + 10) * MS_PER_DAY,
    );
    const { issues, uncertain } = run(QUIET_SURVEY, stale);
    expect(issues).toEqual([]);
    expect(uncertain.map((u) => u.code)).toEqual([RERANK_MODEL_SUNSET_UNDETERMINED_CODE]);
  });
});

describe("the check is config-only and registered", () => {
  test("it makes no network call", () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("the rerank doctor check must not reach the network");
    }) as unknown as typeof fetch;
    try {
      run(surveyWith(inDays(-5)));
      run(surveyWith(null, "2026-05-31", "some-other-model"));
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
  });

  test("the doctor pass runs it", () => {
    configure({ baseUrl: null });
    const result = runDoctor(vault, { now: NOW, configPath });
    expect(result.errors.map((e) => e.code)).toContain(RERANK_ENDPOINT_UNCONFIGURED_CODE);
  });

  test("actionable codes carry a command, uncertain codes a reason", () => {
    expect(DIAGNOSTIC_SIGNALS.get(RERANK_ENDPOINT_UNCONFIGURED_CODE)?.nextCommand).toBe(
      "o2b search rerank-provider list",
    );
    expect(DIAGNOSTIC_SIGNALS.get(RERANK_MODEL_SUNSET_ANNOUNCED_CODE)?.nextCommand).toBe(
      "o2b search rerank-provider add",
    );
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RERANK_MODEL_SUNSET_UNSURVEYED_CODE)).toBe(true);
    expect(DOCTOR_EXIT_EXCLUSIONS.has(RERANK_MODEL_SUNSET_UNDETERMINED_CODE)).toBe(true);
  });
});

/**
 * The published `schemas/brain/*.schema.json` contracts, checked against the
 * REAL output of the report generators they describe.
 *
 * These files are the documented shape of the lifecycle-review reports an
 * agent reads (`brain_intent_review`, `brain_retention`, `brain_brief
 * view=monthly`, `o2b brain intent-review|retention|monthly --json`) and of
 * the complexity block in the discipline report. They used to be mirrored
 * by a hand-written TS copy with its own tests, which only proved the copy
 * agreed with itself. Here the generator runs on a temp vault and its
 * output - plus the MCP projection an agent actually receives - is
 * validated against the file on disk, so a drift on either side fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { buildIntentReview } from "../../../src/core/brain/intent-review.ts";
import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { buildMonthlyReview } from "../../../src/core/brain/monthly-review.ts";
import { preferencePath, processedSignalPath, signalPath } from "../../../src/core/brain/paths.ts";
import { moveToRetired, writePreference } from "../../../src/core/brain/preference.ts";
import { buildRetentionReview } from "../../../src/core/brain/retention.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_RETIRED_REASON,
} from "../../../src/core/brain/types.ts";
import {
  buildComplexityReport,
  complexityPathFactors,
} from "../../../src/core/discipline/complexity.ts";
import { BRAIN_TOOLS } from "../../../src/mcp/brain-tools.ts";
import {
  assertSupportedSchema,
  type SchemaNode,
  validateAgainstSchema,
} from "../../helpers/json-schema-subset.ts";

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "..", "schemas", "brain");

/** Every published schema file, and the `$id` it must declare. */
const SCHEMA_IDS: Readonly<Record<string, string>> = {
  "intent-review.schema.json": "brain.intent_review.v1",
  "retention-review.schema.json": "brain.retention_review.v1",
  "monthly-review.schema.json": "brain.monthly_review.v1",
  "complexity-report.schema.json": "brain.complexity_report.v1",
};

function loadSchema(file: string): SchemaNode {
  const raw: unknown = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8"));
  assertSupportedSchema(raw);
  return raw as SchemaNode;
}

/** A JSON round-trip: what a `--json` reader or MCP client actually parses. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function expectValid(schema: SchemaNode, value: unknown): void {
  const result = validateAgainstSchema(schema, asJson(value));
  expect(result.errors).toEqual([]);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = BRAIN_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`tool not registered: ${name}`);
  return tool.handler({ vault, configPath: join(vault, "config.yaml") } as never, args);
}

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-published-schemas-"));
  bootstrapBrain(vault, {});
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("the published schema set", () => {
  test("every file is covered here and declares the id it is known by", () => {
    const files = readdirSync(SCHEMA_DIR)
      .filter((file) => file.endsWith(".schema.json"))
      .toSorted();
    // A new published schema fails here until it gets a generator check below.
    expect(files).toEqual(Object.keys(SCHEMA_IDS).toSorted());
    for (const [file, id] of Object.entries(SCHEMA_IDS)) {
      expect(loadSchema(file).$id).toBe(id);
    }
  });

  test("the validator rejects the drift it exists to catch", () => {
    // Without this the suite could pass on a validator that accepts
    // everything; each case is a real report with one realistic drift.
    const schema = loadSchema("retention-review.schema.json");
    const report = asJson(
      buildRetentionReview(vault, { now: new Date("2026-05-28T00:00:00Z") }),
    ) as Record<string, unknown>;
    expect(validateAgainstSchema(schema, report).ok).toBe(true);

    const extraKey = { ...report, debug: true };
    expect(validateAgainstSchema(schema, extraKey).errors).toContain("debug is not allowed");

    const { summary: _summary, ...missing } = report;
    expect(validateAgainstSchema(schema, missing).errors).toContain("summary is required");

    const badVersion = { ...report, schema_version: 2 };
    expect(validateAgainstSchema(schema, badVersion).errors).toContain(
      "schema_version must be one of 1",
    );

    const badDate = { ...report, generated_at: "yesterday" };
    expect(validateAgainstSchema(schema, badDate).errors).toContain(
      "generated_at must be date-time",
    );

    const negative = { ...report, summary: { keep: -1, improve: 0, park: 0, prune: 0 } };
    expect(validateAgainstSchema(schema, negative).errors).toContain("summary.keep must be >= 0");

    const badAction = {
      ...report,
      recommendations: [
        { id: "x", artifact_type: "processed_signal", action: "delete", reason: "r", path: "p" },
      ],
    };
    expect(validateAgainstSchema(schema, badAction).errors[0]).toContain(
      "recommendations[0].action",
    );
  });

  test("an unsupported keyword is refused rather than silently skipped", () => {
    expect(() => assertSupportedSchema({ type: "string", pattern: "^x$" })).toThrow(
      'unsupported schema keyword "pattern"',
    );
    expect(() => assertSupportedSchema({ type: "string", format: "uri" })).toThrow(
      'unsupported format "uri"',
    );
  });
});

describe("brain.intent_review.v1", () => {
  function signal(topic: string, sign: "positive" | "negative", index: number): void {
    writeSignal(vault, {
      topic,
      signal: sign,
      agent: index % 2 === 0 ? "claude" : "codex",
      principle: `${topic} ${sign} principle`,
      created_at: `2026-05-2${index}T10:00:00Z`,
      date: `2026-05-2${index}`,
      slug: `${topic}-${index}`,
    });
  }

  beforeEach(() => {
    signal("ready-topic", "positive", 1);
    signal("ready-topic", "positive", 2);
    signal("ready-topic", "positive", 3);
    signal("weak-topic", "negative", 1);
    signal("conflicted-topic", "positive", 1);
    signal("conflicted-topic", "negative", 2);
  });

  test("buildIntentReview output matches the published schema", () => {
    const report = buildIntentReview(vault, { now: new Date("2026-05-28T00:00:00Z") });
    // Guard against a vacuous pass on an empty review list.
    expect(new Set(report.reviews.map((r) => r.decision)).size).toBeGreaterThanOrEqual(3);
    expectValid(loadSchema("intent-review.schema.json"), report);
  });

  test("the brain_intent_review MCP payload matches the published schema", async () => {
    const out = await callTool("brain_intent_review", { now: "2026-05-28T00:00:00Z" });
    expect((out as { reviews: unknown[] }).reviews.length).toBe(3);
    expectValid(loadSchema("intent-review.schema.json"), out);
  });
});

describe("brain.retention_review.v1", () => {
  beforeEach(() => {
    writePreference(vault, {
      slug: "useful-rule",
      topic: "useful-rule",
      principle: "keep useful retired rules visible",
      created_at: "2026-05-01T00:00:00Z",
      unconfirmed_until: "2026-05-08T00:00:00Z",
      confirmed_at: "2026-05-08T00:00:00Z",
      status: "confirmed",
      evidenced_by: [],
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-20T00:00:00Z",
    });
    moveToRetired(
      vault,
      preferencePath(vault, "useful-rule"),
      BRAIN_RETIRED_REASON.staleNoEvidence,
      {
        now: new Date("2026-05-21T00:00:00Z"),
        retired_by: "test",
        evidenceApplied: [],
        evidenceViolated: [],
      },
    );
    writeSignal(vault, {
      topic: "discarded-signal",
      signal: "negative",
      agent: "test",
      principle: "old one-off signal",
      created_at: "2026-04-01T00:00:00Z",
      date: "2026-04-01",
      slug: "discarded-signal",
    });
    renameSync(
      signalPath(vault, "2026-04-01", "discarded-signal"),
      processedSignalPath(vault, "2026-04-01", "discarded-signal"),
    );
  });

  test("buildRetentionReview output matches the published schema", () => {
    const report = buildRetentionReview(vault, { now: new Date("2026-05-28T00:00:00Z") });
    expect(report.recommendations.map((r) => r.artifact_type).toSorted()).toEqual([
      "processed_signal",
      "retired_preference",
    ]);
    expectValid(loadSchema("retention-review.schema.json"), report);
  });

  test("the brain_retention MCP payload matches the published schema", async () => {
    const out = await callTool("brain_retention", { now: "2026-05-28T00:00:00Z" });
    expect((out as { recommendations: unknown[] }).recommendations.length).toBeGreaterThan(0);
    expectValid(loadSchema("retention-review.schema.json"), out);
  });
});

describe("brain.monthly_review.v1", () => {
  beforeEach(() => {
    appendLogEvent(vault, {
      timestamp: "2026-05-10T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.dream,
      body: {
        confirmed: ["[[pref-use-tests|Use tests]]"],
        retired: ["[[ret-old-rule|Old rule]] (stale-no-evidence)"],
      },
    });
    appendLogEvent(vault, {
      timestamp: "2026-05-11T10:00:00Z",
      eventType: BRAIN_LOG_EVENT_KIND.applyEvidence,
      body: {
        preference: "[[pref-use-tests]]",
        artifact: "[[src/core/example.ts]]",
        result: BRAIN_APPLY_RESULT.violated,
      },
    });
  });

  test("buildMonthlyReview output matches the published schema", () => {
    const report = buildMonthlyReview(vault, {
      month: "2026-05",
      now: new Date("2026-06-01T00:00:00Z"),
      expectedAreas: ["writing"],
    });
    expect(report.summary.events).toBe(2);
    expect(report.summary.neglected_areas.length).toBeGreaterThan(0);
    expectValid(loadSchema("monthly-review.schema.json"), report);
  });

  test("the brain_brief view=monthly MCP payload matches the published schema", async () => {
    // brain_monthly_review was folded into brain_brief in 1.0.0; the
    // monthly view still returns this contract's shape.
    const out = await callTool("brain_brief", { view: "monthly", month: "2026-05" });
    expect((out as { summary: { events: number } }).summary.events).toBe(2);
    expectValid(loadSchema("monthly-review.schema.json"), out);
  });
});

describe("brain.complexity_report.v1", () => {
  test("buildComplexityReport over real changed paths matches the published schema", () => {
    mkdirSync(join(vault, "Templates", "deep", "nested"), { recursive: true });
    writeFileSync(join(vault, "Templates", "deep", "nested", "daily.md"), "#alpha #beta\n");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    writeFileSync(join(vault, ".obsidian", "app.json"), "{}\n");
    const factors = complexityPathFactors([
      { root: vault, relativePath: "Templates/deep/nested/daily.md" },
      { root: vault, relativePath: ".obsidian/app.json" },
      { root: vault, relativePath: "Brain/_brain.yaml" },
    ]);

    const report = buildComplexityReport(
      { thinkingActivity: 3, structuralFilesChanged: 12, ...factors },
      { now: new Date("2026-05-28T00:00:00Z") },
    );
    // A non-integer ratio and a raised warning exercise the number and
    // boolean branches, not just the quiet-day zeros.
    expect(Number.isInteger(report.ratio)).toBe(false);
    expect(report.warning).toBe(true);
    expect(report.factors.length).toBe(5);
    expectValid(loadSchema("complexity-report.schema.json"), report);
  });

  test("a quiet day (no factors, no activity) still matches", () => {
    const report = buildComplexityReport(
      { thinkingActivity: 0, structuralFilesChanged: 0 },
      { now: new Date("2026-05-28T00:00:00Z") },
    );
    expect(report.factors).toEqual([]);
    expectValid(loadSchema("complexity-report.schema.json"), report);
  });
});

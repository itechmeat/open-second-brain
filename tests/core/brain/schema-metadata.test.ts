import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  moveToRetired,
  parsePreference,
  parseRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { resolveSchemaVocabulary } from "../../../src/core/brain/schema-vocab.ts";
import { parseSignal, writeSignal } from "../../../src/core/brain/signal.ts";
import {
  BRAIN_CONFIDENCE,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
} from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-schema-meta-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: "research",
    principle: `Principle for ${slug}`,
    created_at: "2026-05-30T12:00:00Z",
    unconfirmed_until: "2026-06-06T12:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: [],
    confirmed_at: "2026-05-30T13:00:00Z",
    confidence: BRAIN_CONFIDENCE.low,
    pinned: false,
    ...overrides,
  };
}

describe("Brain artifact schema metadata", () => {
  test("preference writer omits schema_type unless supplied", () => {
    const res = writePreference(vault, basePref("legacy"));
    const text = readFileSync(res.path, "utf8");

    expect(text).not.toContain("schema_type:");
    expect(parsePreference(res.path).schema_type).toBeUndefined();
  });

  test("preference writer and parser round-trip schema_type", () => {
    const vocab = resolveSchemaVocabulary({ preference_types: ["research"] });
    const res = writePreference(
      vault,
      basePref("custom", {
        schema_type: "Research",
      } as Partial<WritePreferenceInput>),
    );

    expect(readFileSync(res.path, "utf8")).toContain("schema_type: research");
    expect(
      parsePreference(res.path, { schemaVocabulary: vocab }).schema_type,
    ).toBe("research");
  });

  test("preference parser rejects schema_type unknown to a provided vocabulary", () => {
    const path = join(vault, "Brain", "preferences", "pref-unknown.md");
    writeFileSync(
      path,
      [
        "---",
        "kind: brain-preference",
        "id: pref-unknown",
        "created_at: 2026-05-30T12:00:00Z",
        "_confirmed_at: 2026-05-30T13:00:00Z",
        "unconfirmed_until: 2026-06-06T12:00:00Z",
        "tags: [brain, brain/preference, brain/topic/research]",
        "topic: research",
        "_status: confirmed",
        "principle: unknown schema type",
        "_evidenced_by: []",
        "_applied_count: 0",
        "_violated_count: 0",
        '_last_evidence_at: "null"',
        "_confidence: low",
        '_confidence_value: "null"',
        "pinned: false",
        "schema_type: unknown",
        "---",
      ].join("\n"),
      "utf8",
    );

    const vocab = resolveSchemaVocabulary({ preference_types: ["research"] });
    expect(() => parsePreference(path, { schemaVocabulary: vocab })).toThrow(
      "schema_type",
    );
  });

  test("moveToRetired preserves schema_type metadata", () => {
    const vocab = resolveSchemaVocabulary({ preference_types: ["research"] });
    const res = writePreference(
      vault,
      basePref("retire-me", {
        schema_type: "research",
      } as Partial<WritePreferenceInput>),
    );

    const retired = moveToRetired(
      vault,
      res.path,
      BRAIN_RETIRED_REASON.userRejected,
      {
        now: new Date("2026-06-01T00:00:00Z"),
        retired_by: "[[Brain/log/2026-06-01]]",
        user_rejected_reason: "test",
      },
    );

    expect(
      parseRetired(retired.path, { schemaVocabulary: vocab }).schema_type,
    ).toBe("research");
  });

  test("signal writer and parser round-trip schema_type", () => {
    const vocab = resolveSchemaVocabulary({ signal_types: ["observation"] });
    const res = writeSignal(vault, {
      topic: "research",
      signal: BRAIN_SIGNAL_SIGN.positive,
      agent: "tester",
      principle: "capture observations",
      created_at: "2026-05-30T12:00:00Z",
      date: "2026-05-30",
      slug: "observation",
      schema_type: "Observation",
    });

    expect(readFileSync(res.path, "utf8")).toContain(
      "schema_type: observation",
    );
    expect(parseSignal(res.path, { schemaVocabulary: vocab }).schema_type).toBe(
      "observation",
    );
  });
});

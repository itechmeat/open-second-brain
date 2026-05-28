import { describe, expect, test } from "bun:test";

import {
  BRAIN_SCHEMA_CONTRACTS,
  getBrainSchemaContract,
  validateSchemaContract,
} from "../../src/core/brain/schema-contracts.ts";

describe("Brain schema contracts", () => {
  test("registers lifecycle review schemas in stable order", () => {
    expect(BRAIN_SCHEMA_CONTRACTS.map((schema) => schema.id)).toEqual([
      "brain.intent_review.v1",
      "brain.retention_review.v1",
      "brain.monthly_review.v1",
      "brain.complexity_report.v1",
    ]);
    expect(getBrainSchemaContract("brain.retention_review.v1")?.title).toBe(
      "Brain Retention Review v1",
    );
  });

  test("validates a retention review envelope", () => {
    const schema = getBrainSchemaContract("brain.retention_review.v1");
    expect(schema).toBeDefined();
    const valid = validateSchemaContract(schema!, {
      schema_version: 1,
      generated_at: "2026-05-28T12:00:00.000Z",
      summary: {
        keep: 1,
        improve: 0,
        park: 0,
        prune: 0,
      },
      recommendations: [
        {
          id: "ret-old-rule",
          artifact_type: "retired_preference",
          action: "keep",
          reason: "recently retired with evidence trail",
          path: "Brain/retired/ret-old-rule.md",
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateSchemaContract(schema!, {
      schema_version: 1,
      generated_at: "2026-05-28T12:00:00.000Z",
      summary: {
        keep: 1,
        improve: 0,
        park: 0,
        prune: 0,
      },
      recommendations: [
        {
          id: "ret-old-rule",
          artifact_type: "retired_preference",
          action: "delete",
          reason: "unsupported action",
          path: "Brain/retired/ret-old-rule.md",
        },
      ],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors[0]).toContain("recommendations[0].action");
  });
});

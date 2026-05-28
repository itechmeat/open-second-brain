export type SchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean";

export interface SchemaNode {
  readonly type?: SchemaType;
  readonly title?: string;
  readonly description?: string;
  readonly enum?: ReadonlyArray<unknown>;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly additionalProperties?: boolean;
}

export interface BrainSchemaContract extends SchemaNode {
  readonly id: string;
  readonly title: string;
  readonly schema_version: 1;
}

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
}

const INTENT_REVIEW_SCHEMA: BrainSchemaContract = {
  id: "brain.intent_review.v1",
  title: "Brain Intent Review v1",
  schema_version: 1,
  type: "object",
  required: ["schema_version", "generated_at", "reviews"],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", enum: [1] },
    generated_at: { type: "string" },
    reviews: {
      type: "array",
      items: {
        type: "object",
        required: ["topic", "decision", "signal_count", "risk_band", "risk_score", "reasons"],
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          decision: {
            type: "string",
            enum: [
              "ready_for_main_review",
              "needs_more_evidence",
              "blocked_conflicted",
              "suppressed_by_rejected_retired",
            ],
          },
          signal_count: { type: "integer" },
          risk_band: { type: "string", enum: ["low", "medium", "high"] },
          risk_score: { type: "integer" },
          reasons: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

const RETENTION_REVIEW_SCHEMA: BrainSchemaContract = {
  id: "brain.retention_review.v1",
  title: "Brain Retention Review v1",
  schema_version: 1,
  type: "object",
  required: ["schema_version", "generated_at", "summary", "recommendations"],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", enum: [1] },
    generated_at: { type: "string" },
    summary: {
      type: "object",
      required: ["keep", "improve", "park", "prune"],
      additionalProperties: false,
      properties: {
        keep: { type: "integer" },
        improve: { type: "integer" },
        park: { type: "integer" },
        prune: { type: "integer" },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "artifact_type", "action", "reason", "path"],
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          artifact_type: { type: "string", enum: ["retired_preference", "processed_signal"] },
          action: { type: "string", enum: ["keep", "improve", "park", "prune"] },
          reason: { type: "string" },
          path: { type: "string" },
        },
      },
    },
  },
};

const MONTHLY_REVIEW_SCHEMA: BrainSchemaContract = {
  id: "brain.monthly_review.v1",
  title: "Brain Monthly Review v1",
  schema_version: 1,
  type: "object",
  required: ["schema_version", "generated_at", "month", "window", "summary"],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", enum: [1] },
    generated_at: { type: "string" },
    month: { type: "string" },
    window: {
      type: "object",
      required: ["since", "until"],
      additionalProperties: false,
      properties: {
        since: { type: "string" },
        until: { type: "string" },
      },
    },
    summary: {
      type: "object",
      required: ["events", "status_transitions", "retired", "contradictions", "neglected_areas"],
      additionalProperties: false,
      properties: {
        events: { type: "integer" },
        status_transitions: { type: "integer" },
        retired: { type: "integer" },
        contradictions: { type: "integer" },
        neglected_areas: { type: "array", items: { type: "string" } },
      },
    },
  },
};

const COMPLEXITY_REPORT_SCHEMA: BrainSchemaContract = {
  id: "brain.complexity_report.v1",
  title: "Brain Complexity Report v1",
  schema_version: 1,
  type: "object",
  required: [
    "schema_version",
    "generated_at",
    "score",
    "ratio",
    "thinking_activity",
    "structural_complexity",
    "warning",
    "factors",
  ],
  additionalProperties: false,
  properties: {
    schema_version: { type: "integer", enum: [1] },
    generated_at: { type: "string" },
    score: { type: "integer" },
    ratio: { type: "number" },
    thinking_activity: { type: "integer" },
    structural_complexity: { type: "integer" },
    warning: { type: "boolean" },
    factors: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "value", "weight"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          value: { type: "integer" },
          weight: { type: "integer" },
        },
      },
    },
  },
};

export const BRAIN_SCHEMA_CONTRACTS: ReadonlyArray<BrainSchemaContract> = Object.freeze([
  INTENT_REVIEW_SCHEMA,
  RETENTION_REVIEW_SCHEMA,
  MONTHLY_REVIEW_SCHEMA,
  COMPLEXITY_REPORT_SCHEMA,
]);

export function getBrainSchemaContract(id: string): BrainSchemaContract | undefined {
  return BRAIN_SCHEMA_CONTRACTS.find((schema) => schema.id === id);
}

export function validateSchemaContract(
  schema: SchemaNode,
  value: unknown,
): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, "", errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

function validateNode(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${formatPath(path)} must be ${schema.type}`);
    return;
  }

  if (schema.enum !== undefined && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(`${formatPath(path)} must be one of ${schema.enum.map(formatEnumValue).join(", ")}`);
    return;
  }

  if (schema.type === "object") {
    validateObject(schema, value, path, errors);
    return;
  }

  if (schema.type === "array") {
    validateArray(schema, value, path, errors);
  }
}

function validateObject(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) return;
  const properties = schema.properties ?? {};
  for (const requiredKey of schema.required ?? []) {
    if (!(requiredKey in value)) {
      errors.push(`${formatPath(appendPath(path, requiredKey))} is required`);
    }
  }
  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = properties[key];
    if (childSchema === undefined) {
      if (schema.additionalProperties === false) {
        errors.push(`${formatPath(appendPath(path, key))} is not allowed`);
      }
      continue;
    }
    validateNode(childSchema, childValue, appendPath(path, key), errors);
  }
}

function validateArray(
  schema: SchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) return;
  const itemSchema = schema.items;
  if (itemSchema === undefined) return;
  for (let index = 0; index < value.length; index++) {
    validateNode(itemSchema, value[index], `${path}[${index}]`, errors);
  }
}

function matchesType(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

function formatPath(path: string): string {
  return path.length === 0 ? "<root>" : path;
}

function formatEnumValue(value: unknown): string {
  return JSON.stringify(value);
}

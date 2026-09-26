/**
 * A minimal JSON Schema validator for the published `schemas/brain/*.schema.json`
 * contracts - exactly the keyword subset those files use, and no more.
 *
 * It began life as `src/core/brain/schema-contracts.ts`, a hand-written TS
 * mirror of the published schemas with no production consumer. The mirror
 * could drift from the published files without anything noticing (and had:
 * it declared `format: date-time` on fields the published schemas leave as
 * plain strings). What survives is the validator alone, now pointed at the
 * published files themselves, so a contract test checks the real generator
 * output against the real contract.
 *
 * An unsupported keyword is an error, not a silent pass: a schema that grows
 * a keyword this subset does not check must fail the contract test until the
 * validator learns it, or the test would claim a guarantee it does not give.
 */

export type SchemaType = "object" | "array" | "string" | "integer" | "number" | "boolean";

export interface SchemaNode {
  readonly $schema?: string;
  readonly $id?: string;
  readonly type?: SchemaType;
  readonly title?: string;
  readonly description?: string;
  readonly format?: "date-time";
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: ReadonlyArray<unknown>;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly items?: SchemaNode;
  readonly additionalProperties?: boolean;
}

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<string>;
}

const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "$schema",
  "$id",
  "type",
  "title",
  "description",
  "format",
  "minimum",
  "maximum",
  "enum",
  "required",
  "properties",
  "items",
  "additionalProperties",
]);

const SUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "object",
  "array",
  "string",
  "integer",
  "number",
  "boolean",
]);

/**
 * Throws when `schema` uses a keyword, type, or format this validator does
 * not implement. Run it over every published schema before trusting a
 * validation result.
 */
export function assertSupportedSchema(schema: unknown, path = ""): void {
  if (!isRecord(schema)) throw new Error(`${formatPath(path)}: schema node must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new Error(`${formatPath(path)}: unsupported schema keyword ${JSON.stringify(key)}`);
    }
  }
  const type = schema["type"];
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_TYPES.has(type))) {
    throw new Error(`${formatPath(path)}: unsupported type ${JSON.stringify(type)}`);
  }
  const format = schema["format"];
  if (format !== undefined && format !== "date-time") {
    throw new Error(`${formatPath(path)}: unsupported format ${JSON.stringify(format)}`);
  }
  const additional = schema["additionalProperties"];
  if (additional !== undefined && typeof additional !== "boolean") {
    throw new Error(`${formatPath(path)}: additionalProperties must be a boolean here`);
  }
  const properties = schema["properties"];
  if (properties !== undefined) {
    if (!isRecord(properties)) throw new Error(`${formatPath(path)}: properties must be an object`);
    for (const [key, child] of Object.entries(properties)) {
      assertSupportedSchema(child, appendPath(path, key));
    }
  }
  if (schema["items"] !== undefined) assertSupportedSchema(schema["items"], `${path}[]`);
}

export function validateAgainstSchema(schema: SchemaNode, value: unknown): SchemaValidationResult {
  const errors: string[] = [];
  validateNode(schema, value, "", errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

function validateNode(schema: SchemaNode, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined && !matchesType(schema.type, value)) {
    errors.push(`${formatPath(path)} must be ${schema.type}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    errors.push(
      `${formatPath(path)} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
    );
    return;
  }
  if (schema.format === "date-time" && typeof value === "string") {
    if (!Number.isFinite(Date.parse(value))) errors.push(`${formatPath(path)} must be date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${formatPath(path)} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${formatPath(path)} must be <= ${schema.maximum}`);
    }
  }
  if (schema.type === "object" && isRecord(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${formatPath(appendPath(path, key))} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${formatPath(appendPath(path, key))} is not allowed`);
        }
        continue;
      }
      validateNode(childSchema, child, appendPath(path, key), errors);
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index++) {
      validateNode(schema.items, value[index], `${path}[${index}]`, errors);
    }
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

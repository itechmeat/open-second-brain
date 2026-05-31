export type OutputSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

export interface OutputSchema {
  readonly type?: OutputSchemaType;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, OutputSchema>>;
  readonly items?: OutputSchema;
  readonly enum?: ReadonlyArray<unknown>;
  readonly additionalProperties?: boolean | OutputSchema;
}

export function validateOutputContract(schema: OutputSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (schema.enum && !schema.enum.some((expected) => Object.is(expected, value))) {
    errors.push(`${path}: expected one of ${schema.enum.map(String).join(", ")}`);
    return errors;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
    return errors;
  }

  if (schema.type === "object" || schema.properties || schema.required) {
    if (!isRecord(value)) {
      if (!schema.type) errors.push(`${path}: expected object`);
      return errors;
    }

    for (const requiredKey of schema.required ?? []) {
      if (!hasOwn(value, requiredKey)) {
        errors.push(`${path}: missing required property '${requiredKey}'`);
      }
    }

    const properties = schema.properties ?? {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, key)) {
        errors.push(...validateOutputContract(childSchema, value[key], `${path}.${key}`));
      }
    }

    const additional = schema.additionalProperties;
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(properties, key)) errors.push(`${path}: unexpected property '${key}'`);
      }
    } else if (typeof additional === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        if (!hasOwn(properties, key)) {
          errors.push(...validateOutputContract(additional, childValue, `${path}.${key}`));
        }
      }
    }
  }

  if (schema.type === "array" || schema.items) {
    if (!Array.isArray(value)) {
      if (!schema.type) errors.push(`${path}: expected array`);
      return errors;
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateOutputContract(schema.items!, item, `${path}[${index}]`));
      });
    }
  }

  return errors;
}

export function assertOutputContract(
  toolName: string,
  schema: OutputSchema | undefined,
  value: unknown,
): void {
  if (!schema) return;
  const errors = validateOutputContract(schema, value);
  if (errors.length > 0) {
    throw new Error(`${toolName} output contract failed: ${errors.join("; ")}`);
  }
}

function matchesType(value: unknown, type: OutputSchemaType): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

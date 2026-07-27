/**
 * Response-shape validation for model-authored write paths
 * (signals-that-survive, unit 8, t_80b01448).
 *
 * Three write paths accept a payload the calling agent authored - distilled
 * claims, a derived fact, a synthesized research report - and commit it
 * straight into the vault. Loose parsing there does not surface as an error:
 * it surfaces later as corrupted knowledge. This module is the ingress gate
 * those paths validate against BEFORE any normalization runs.
 *
 * The validator is the JSON-subset checker the Model Context Protocol output
 * contract has always used, promoted here so there is exactly ONE definition;
 * `src/mcp/output-contract.ts` now consumes it rather than owning a twin.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   - Validation is UNCONDITIONAL. This module reads no settings and no
 *     environment. A gate that can be switched off is a gate the write path
 *     cannot rely on, and one defaulting to today's tolerance would ship the
 *     strict path inert - the silent no-op this project forbids.
 *   - Descriptors stay SHALLOW: required keys, primitive types, arrays of
 *     objects. Over-constraining an extraction payload degrades recall, which
 *     is the failure this layer must not cause.
 *
 * The layer is named for response *shape* throughout, and never borrows the
 * noun the knowledge vocabulary already owns, so the two cannot be confused
 * with each other - a test pins that naming so it cannot drift back.
 */

/** Value kinds a descriptor can require. */
export const SHAPE_TYPES = Object.freeze([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const);

export type ShapeType = (typeof SHAPE_TYPES)[number];

/** The complete set of keys a descriptor node may declare. */
export const SHAPE_DESCRIPTOR_KEYS = Object.freeze([
  "type",
  "required",
  "properties",
  "items",
  "enum",
  "additionalProperties",
  "nonBlank",
] as const);

/**
 * One node of a response-shape descriptor. Anything outside
 * {@link SHAPE_DESCRIPTOR_KEYS} is not expressible here - by design: a
 * descriptor a reader can hold in their head is a descriptor that stays
 * accurate.
 */
export interface ShapeDescriptor {
  readonly type?: ShapeType;
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Readonly<Record<string, ShapeDescriptor>>;
  readonly items?: ShapeDescriptor;
  readonly enum?: ReadonlyArray<unknown>;
  readonly additionalProperties?: boolean | ShapeDescriptor;
  /**
   * String values only: an empty or whitespace-only string is a violation.
   * A key can be present and still carry no content, and on these write paths
   * a blank string is not a value - it is a missing one wearing the right
   * type. Declaring that here keeps `required` about presence and lets the
   * descriptor say what the parsers it replaced said.
   */
  readonly nonBlank?: boolean;
}

/** Stable codes a violation is classified under; never assembled from prose. */
export const SHAPE_VIOLATION_CODES = Object.freeze({
  typeMismatch: "shape_type_mismatch",
  missingProperty: "shape_missing_property",
  unexpectedProperty: "shape_unexpected_property",
  disallowedValue: "shape_disallowed_value",
  blankString: "shape_blank_string",
} as const);

/** Wording of a blank-string violation, kept as the parsers it replaced read. */
const BLANK_STRING_MESSAGE = "must be a non-empty string";

export type ShapeViolationCode = (typeof SHAPE_VIOLATION_CODES)[keyof typeof SHAPE_VIOLATION_CODES];

/** One structural defect, located by path and classified by code. */
export interface ShapeViolation {
  readonly code: ShapeViolationCode;
  /** JSON-path-ish location, e.g. `$.findings[0].sources`. */
  readonly path: string;
  /** The defect, without the path - callers render `<path>: <message>`. */
  readonly message: string;
}

/** Path assigned to the payload root. */
export const SHAPE_ROOT_PATH = "$";

/** Render one violation as the single line a caller prints or joins. */
export function formatShapeViolation(violation: ShapeViolation): string {
  return `${violation.path}: ${violation.message}`;
}

/**
 * Check `value` against `descriptor`, returning every violation found. An
 * empty array means the payload conforms. Pure: reads nothing but its
 * arguments, so the same payload always produces the same verdict.
 */
export function checkResponseShape(
  descriptor: ShapeDescriptor,
  value: unknown,
  path: string = SHAPE_ROOT_PATH,
): ShapeViolation[] {
  const violations: ShapeViolation[] = [];

  if (descriptor.enum && !descriptor.enum.some((allowed) => Object.is(allowed, value))) {
    violations.push(
      makeViolation(
        SHAPE_VIOLATION_CODES.disallowedValue,
        path,
        `expected one of ${descriptor.enum.map(String).join(", ")}`,
      ),
    );
    return violations;
  }

  if (descriptor.type && !matchesType(value, descriptor.type)) {
    violations.push(typeViolation(path, descriptor.type));
    return violations;
  }

  if (descriptor.nonBlank === true && typeof value === "string" && value.trim().length === 0) {
    violations.push(makeViolation(SHAPE_VIOLATION_CODES.blankString, path, BLANK_STRING_MESSAGE));
    return violations;
  }

  if (descriptor.type === "object" || descriptor.properties || descriptor.required) {
    if (!isRecord(value)) {
      if (!descriptor.type) violations.push(typeViolation(path, "object"));
      return violations;
    }

    for (const requiredKey of descriptor.required ?? []) {
      if (!hasOwn(value, requiredKey)) {
        violations.push(
          makeViolation(
            SHAPE_VIOLATION_CODES.missingProperty,
            path,
            `missing required property '${requiredKey}'`,
          ),
        );
      }
    }

    const properties = descriptor.properties ?? {};
    for (const [key, childDescriptor] of Object.entries(properties)) {
      if (hasOwn(value, key)) {
        violations.push(...checkResponseShape(childDescriptor, value[key], `${path}.${key}`));
      }
    }

    const additional = descriptor.additionalProperties;
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (!hasOwn(properties, key)) {
          violations.push(
            makeViolation(
              SHAPE_VIOLATION_CODES.unexpectedProperty,
              path,
              `unexpected property '${key}'`,
            ),
          );
        }
      }
    } else if (typeof additional === "object") {
      for (const [key, childValue] of Object.entries(value)) {
        if (!hasOwn(properties, key)) {
          violations.push(...checkResponseShape(additional, childValue, `${path}.${key}`));
        }
      }
    }
  }

  if (descriptor.type === "array" || descriptor.items) {
    if (!Array.isArray(value)) {
      if (!descriptor.type) violations.push(typeViolation(path, "array"));
      return violations;
    }
    const items = descriptor.items;
    if (items) {
      value.forEach((item, index) => {
        violations.push(...checkResponseShape(items, item, `${path}[${index}]`));
      });
    }
  }

  return violations;
}

/**
 * An agent-authored payload did not match the shape its write path declares.
 * Carries the defect structurally - `code`, `path`, and the full violation
 * list - so a caller routes on fields rather than parsing the message.
 * Nothing has been written when this is thrown.
 */
export class ResponseShapeError extends Error {
  /** Code of the first violation; the full set is on {@link violations}. */
  readonly code: ShapeViolationCode;
  /** Path of the first violation. */
  readonly path: string;
  /** The write path that declared the descriptor, e.g. `distill_claims`. */
  readonly surface: string;
  readonly violations: ReadonlyArray<ShapeViolation>;

  constructor(surface: string, violations: ReadonlyArray<ShapeViolation>) {
    const first = violations[0];
    if (first === undefined) {
      throw new TypeError("ResponseShapeError requires at least one violation");
    }
    super(`${surface} response shape violated: ${violations.map(formatShapeViolation).join("; ")}`);
    this.name = "ResponseShapeError";
    this.code = first.code;
    this.path = first.path;
    this.surface = surface;
    this.violations = Object.freeze([...violations]);
  }
}

/**
 * Fail-closed gate: return silently when the payload conforms, throw
 * {@link ResponseShapeError} otherwise. There is no tolerant mode and no key
 * that relaxes it - a violating payload is never coerced, never partially
 * accepted, and never dropped.
 */
export function assertResponseShape(
  surface: string,
  descriptor: ShapeDescriptor,
  value: unknown,
): void {
  const violations = checkResponseShape(descriptor, value);
  if (violations.length > 0) throw new ResponseShapeError(surface, violations);
}

// ----- Declared descriptors, one per model-authored write path -------------

/** Surface label of the source-distillation claims payload. */
export const DISTILL_CLAIMS_SURFACE = "distill_claims";
/** Surface label of the derived-fact payload. */
export const DERIVED_FACT_SURFACE = "derived_fact";
/** Surface label of the research-report synthesis payload. */
export const RESEARCH_REPORT_SURFACE = "research_report";

const STRING_SHAPE: ShapeDescriptor = { type: "string" };
const STRING_LIST_SHAPE: ShapeDescriptor = { type: "array", items: STRING_SHAPE };
/** A string that must carry content - the previous parsers' `requiredString`. */
const FILLED_STRING_SHAPE: ShapeDescriptor = { type: "string", nonBlank: true };
const FILLED_STRING_LIST_SHAPE: ShapeDescriptor = {
  type: "array",
  items: FILLED_STRING_SHAPE,
};

/**
 * Atomic claims distilled from one source. Deliberately open to extra keys:
 * a claim carrying a field this version does not read is not a reason to
 * reject the whole distillation.
 */
export const DISTILL_CLAIMS_SHAPE: ShapeDescriptor = freezeDescriptor({
  type: "array",
  items: {
    type: "object",
    required: ["text"],
    properties: { text: STRING_SHAPE, block: STRING_SHAPE },
  },
});

/**
 * A second-order conclusion plus the premises it was reasoned from. `level`
 * is checked as a string here; the derivation vocabulary itself is owned by
 * `provenance.ts` and narrowed there, so it is never duplicated.
 */
export const DERIVED_FACT_SHAPE: ShapeDescriptor = freezeDescriptor({
  type: "object",
  required: ["slug", "topic", "principle", "premises", "level"],
  properties: {
    slug: STRING_SHAPE,
    topic: STRING_SHAPE,
    principle: STRING_SHAPE,
    premises: STRING_LIST_SHAPE,
    level: STRING_SHAPE,
  },
});

/**
 * A synthesized report: consulted sources plus findings that cite them.
 *
 * Every string here is required to carry content. The citation contract is
 * checked by SET MEMBERSHIP - a finding's source must be one of the consulted
 * sources - so a blank source satisfies a blank citation and an uncited claim
 * passes as a cited one. That contract can only be as strong as the strings it
 * compares, which is why the constraint belongs here rather than downstream.
 */
export const RESEARCH_REPORT_SHAPE: ShapeDescriptor = freezeDescriptor({
  type: "object",
  required: ["title", "sources", "findings"],
  properties: {
    title: FILLED_STRING_SHAPE,
    sources: FILLED_STRING_LIST_SHAPE,
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["statement", "sources"],
        properties: { statement: FILLED_STRING_SHAPE, sources: FILLED_STRING_LIST_SHAPE },
      },
    },
  },
});

/**
 * Every declared descriptor, by surface. The registry exists so the shallow-
 * and-expressible discipline can be asserted over the whole set at once
 * rather than one descriptor at a time.
 */
export const MODEL_AUTHORED_SHAPES: Readonly<Record<string, ShapeDescriptor>> = Object.freeze({
  [DISTILL_CLAIMS_SURFACE]: DISTILL_CLAIMS_SHAPE,
  [DERIVED_FACT_SURFACE]: DERIVED_FACT_SHAPE,
  [RESEARCH_REPORT_SURFACE]: RESEARCH_REPORT_SHAPE,
});

// ----- Internals ----------------------------------------------------------

function makeViolation(code: ShapeViolationCode, path: string, message: string): ShapeViolation {
  return Object.freeze({ code, path, message });
}

function typeViolation(path: string, type: ShapeType): ShapeViolation {
  return makeViolation(SHAPE_VIOLATION_CODES.typeMismatch, path, `expected ${type}`);
}

/** Freeze a declared descriptor all the way down, so it cannot drift at runtime. */
function freezeDescriptor<T>(descriptor: T): T {
  if (descriptor !== null && typeof descriptor === "object") {
    for (const child of Object.values(descriptor)) freezeDescriptor(child);
    Object.freeze(descriptor);
  }
  return descriptor;
}

function matchesType(value: unknown, type: ShapeType): boolean {
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

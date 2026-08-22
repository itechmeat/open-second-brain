/**
 * Semantic checks for model-authored payloads
 * (salience-lifecycle-enrichment, unit 0).
 *
 * `response-shape.ts` validates one value at a time against a descriptor
 * that is deliberately shallow, because over-constraining an extraction
 * payload degrades recall. That flatness has a cost: a constraint reading
 * more than one value at once - "exactly one alternative is recommended",
 * "every finding cites a consulted source", "at most N items per session" -
 * is not expressible there, and deepening the descriptor language to fit it
 * would trade the property the shape layer exists to keep.
 *
 * Those constraints live here instead, beside it rather than inside it,
 * following the precedent the research report already set: its citation
 * contract is a set-membership check written next to its descriptor
 * (see `research/research.ts`), not a descriptor key. This module is that
 * pattern given a registry, so every lane in the wave writes its cross-item
 * rule the same way and every refusal reaches the caller named.
 *
 * Two properties are load-bearing:
 *
 *   - The gate is FAIL-CLOSED. Asserting a surface nobody registered throws.
 *     A registry that answered "no check, therefore fine" would turn a
 *     forgotten registration into a silently unvalidated write path, which
 *     is the failure this layer exists to prevent.
 *   - Every violation is NAMED from a frozen vocabulary. A check returning a
 *     code outside it is itself refused, so no caller ever has to parse
 *     prose to learn what went wrong.
 *
 * The path vocabulary is the shape layer's, so a caller rendering both kinds
 * of violation is reading one language.
 */

import { SHAPE_ROOT_PATH } from "./response-shape.ts";

/**
 * Stable codes a semantic violation is classified under. The set is closed
 * on purpose: a check names the KIND of rule it broke here and the specifics
 * in the message, so callers route on the code.
 */
export const SEMANTIC_VIOLATION_CODES = Object.freeze({
  /** Wrong number of items satisfying a rule (exactly one, at least one, ...). */
  cardinality: "semantic_cardinality",
  /** An item contradicts another item of the same payload. */
  crossItem: "semantic_cross_item",
  /** A value a payload references is absent from the set it must come from. */
  setMembership: "semantic_set_membership",
  /** A count, size, or score outside the limit the surface declares. */
  threshold: "semantic_threshold",
  /** No check is registered for the asserted surface (fail-closed). */
  unregistered: "semantic_check_unregistered",
} as const);

export type SemanticViolationCode =
  (typeof SEMANTIC_VIOLATION_CODES)[keyof typeof SEMANTIC_VIOLATION_CODES];

const SEMANTIC_VIOLATION_CODE_SET: ReadonlySet<string> = new Set(
  Object.values(SEMANTIC_VIOLATION_CODES),
);

/** One semantic defect, located by path and classified by code. */
export interface SemanticViolation {
  readonly code: SemanticViolationCode;
  /** JSON-path-ish location, in the shape layer's vocabulary. */
  readonly path: string;
  /** The defect, without the path - callers render `<path>: <message>`. */
  readonly message: string;
}

/**
 * One surface's semantic rules. Pure by contract: it reads the payload and
 * returns every violation it finds, an empty array meaning the payload
 * conforms. It never throws and never writes - {@link assertResponseCheck}
 * owns the refusal.
 */
export type ResponseCheck = (payload: unknown) => ReadonlyArray<SemanticViolation>;

/** Build one violation, frozen, so a check cannot hand back a mutable verdict. */
export function semanticViolation(
  code: SemanticViolationCode,
  path: string,
  message: string,
): SemanticViolation {
  return Object.freeze({ code, path, message });
}

/** Render one violation as the single line a caller prints or joins. */
export function formatSemanticViolation(violation: SemanticViolation): string {
  return `${violation.path}: ${violation.message}`;
}

/**
 * An agent-authored payload broke a rule its write path declares. Carries
 * the defect structurally - `code`, `path`, and the full violation list - so
 * a caller routes on fields rather than parsing the message. Nothing has
 * been written when this is thrown.
 */
export class ResponseCheckError extends Error {
  /** Code of the first violation; the full set is on {@link violations}. */
  readonly code: SemanticViolationCode;
  /** Path of the first violation. */
  readonly path: string;
  /** The write path whose checks were run, e.g. `design_note`. */
  readonly surface: string;
  readonly violations: ReadonlyArray<SemanticViolation>;

  constructor(surface: string, violations: ReadonlyArray<SemanticViolation>) {
    const first = violations[0];
    if (first === undefined) {
      throw new TypeError("ResponseCheckError requires at least one violation");
    }
    super(
      `${surface} response checks violated: ${violations.map(formatSemanticViolation).join("; ")}`,
    );
    this.name = "ResponseCheckError";
    this.code = first.code;
    this.path = first.path;
    this.surface = surface;
    this.violations = Object.freeze([...violations]);
  }
}

const REGISTRY = new Map<string, ResponseCheck>();

/**
 * Declare the semantic rules of one surface. A surface may be registered
 * once: a second registration throws rather than replacing the first, so a
 * duplicated name surfaces as a startup failure instead of one lane quietly
 * validating another lane's payload.
 */
export function registerResponseCheck(surface: string, check: ResponseCheck): void {
  if (surface.trim().length === 0) {
    throw new TypeError("a response check needs a non-empty surface name");
  }
  if (REGISTRY.has(surface)) {
    throw new TypeError(`a response check is already registered for surface '${surface}'`);
  }
  REGISTRY.set(surface, check);
}

/** The check declared for `surface`, or undefined when none is. */
export function getResponseCheck(surface: string): ResponseCheck | undefined {
  return REGISTRY.get(surface);
}

/** Every registered surface, sorted, so the listing is stable to read. */
export function listResponseCheckSurfaces(): ReadonlyArray<string> {
  return Object.freeze([...REGISTRY.keys()].toSorted());
}

/**
 * Fail-closed gate: return silently when the payload satisfies the surface's
 * semantic rules, throw {@link ResponseCheckError} otherwise. Asserting a
 * surface with no registered check is itself a violation - an unchecked
 * payload is never reported as a checked one.
 */
export function assertResponseCheck(surface: string, payload: unknown): void {
  const check = REGISTRY.get(surface);
  if (check === undefined) {
    throw new ResponseCheckError(surface, [
      semanticViolation(
        SEMANTIC_VIOLATION_CODES.unregistered,
        SHAPE_ROOT_PATH,
        "no semantic check is registered for this surface",
      ),
    ]);
  }
  const violations = check(payload);
  if (violations.length === 0) return;
  for (const violation of violations) {
    if (!SEMANTIC_VIOLATION_CODE_SET.has(violation.code)) {
      throw new TypeError(
        `response check for surface '${surface}' returned an unnamed violation code: ${violation.code}`,
      );
    }
  }
  throw new ResponseCheckError(surface, violations);
}

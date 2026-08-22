/**
 * Semantic-checker registry (salience-lifecycle-enrichment, unit 0).
 *
 * `ShapeDescriptor` is deliberately shallow, so constraints that read more
 * than one value at a time - cardinality, cross-item rules, caps and floors
 * - cannot be written there without deepening the descriptor language the
 * response-shape layer keeps flat on purpose. They live here instead, beside
 * it, following the research citation check that already validates set
 * membership next to its descriptor. What this suite pins:
 *
 *  1. A check registers under a surface name and is found by it; the
 *     registry can name every surface it holds.
 *  2. Registration is fail-loud: a second check for the same surface throws
 *     rather than silently replacing the first, and a blank surface is
 *     refused.
 *  3. The gate is FAIL-CLOSED: asserting a surface nobody registered throws
 *     a named refusal. An unchecked surface must never read as a clean one.
 *  4. A conforming payload passes silently, like `assertResponseShape`.
 *  5. A violating payload throws `ResponseCheckError` carrying the surface,
 *     the first violation's code and path, and the complete violation list -
 *     routing is on fields, never on parsed prose.
 *  6. Violation codes come from the frozen vocabulary: a check returning a
 *     code outside it is itself refused, so no refusal reaches a caller
 *     unnamed.
 *  7. The constraints the descriptor language cannot express are expressible
 *     here - a worked cardinality rule (exactly one recommended alternative)
 *     and a worked cross-item rule (every cited source was consulted).
 */

import { expect, test } from "bun:test";

import {
  assertResponseCheck,
  getResponseCheck,
  listResponseCheckSurfaces,
  registerResponseCheck,
  ResponseCheckError,
  SEMANTIC_VIOLATION_CODES,
  semanticViolation,
  type ResponseCheck,
} from "../../../src/core/brain/response-checks.ts";
import { SHAPE_ROOT_PATH } from "../../../src/core/brain/response-shape.ts";

/** Payload shape the worked cardinality example validates. */
interface Alternatives {
  readonly alternatives: ReadonlyArray<{ readonly name: string; readonly recommended: boolean }>;
}

const exactlyOneRecommended: ResponseCheck = (payload) => {
  const alternatives = (payload as Alternatives).alternatives;
  const recommended = alternatives.filter((a) => a.recommended);
  if (recommended.length === 1) return [];
  return [
    semanticViolation(
      SEMANTIC_VIOLATION_CODES.cardinality,
      `${SHAPE_ROOT_PATH}.alternatives`,
      `expected exactly one recommended alternative, found ${recommended.length}`,
    ),
  ];
};

test("a check registers under a surface name and is found by it", () => {
  const surface = "test_lookup";
  registerResponseCheck(surface, exactlyOneRecommended);
  expect(getResponseCheck(surface)).toBe(exactlyOneRecommended);
  expect(listResponseCheckSurfaces()).toContain(surface);
  expect(getResponseCheck("test_never_registered")).toBeUndefined();
});

test("registration is fail-loud: no duplicate surface, no blank surface", () => {
  const surface = "test_duplicate";
  registerResponseCheck(surface, exactlyOneRecommended);
  expect(() => registerResponseCheck(surface, exactlyOneRecommended)).toThrow(/already registered/);
  expect(() => registerResponseCheck("   ", exactlyOneRecommended)).toThrow(/surface/);
});

test("asserting a surface nobody registered is a named refusal, never a clean pass", () => {
  let thrown: unknown;
  try {
    assertResponseCheck("test_unregistered_surface", { anything: true });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ResponseCheckError);
  const error = thrown as ResponseCheckError;
  expect(error.code).toBe(SEMANTIC_VIOLATION_CODES.unregistered);
  expect(error.surface).toBe("test_unregistered_surface");
  expect(error.message).toContain("test_unregistered_surface");
});

test("a conforming payload passes silently", () => {
  const surface = "test_conforming";
  registerResponseCheck(surface, exactlyOneRecommended);
  expect(() =>
    assertResponseCheck(surface, {
      alternatives: [
        { name: "a", recommended: true },
        { name: "b", recommended: false },
      ],
    }),
  ).not.toThrow();
});

test("a violating payload throws with the surface, the code, the path, and every violation", () => {
  const surface = "test_violating";
  registerResponseCheck(surface, exactlyOneRecommended);
  let thrown: unknown;
  try {
    assertResponseCheck(surface, {
      alternatives: [
        { name: "a", recommended: true },
        { name: "b", recommended: true },
      ],
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ResponseCheckError);
  const error = thrown as ResponseCheckError;
  expect(error.name).toBe("ResponseCheckError");
  expect(error.surface).toBe(surface);
  expect(error.code).toBe(SEMANTIC_VIOLATION_CODES.cardinality);
  expect(error.path).toBe("$.alternatives");
  expect(error.violations).toHaveLength(1);
  expect(Object.isFrozen(error.violations)).toBe(true);
  expect(error.message).toBe(
    `${surface} response checks violated: $.alternatives: expected exactly one recommended alternative, found 2`,
  );
});

test("a check returning a code outside the frozen vocabulary is itself refused", () => {
  const surface = "test_unnamed_code";
  registerResponseCheck(surface, () => [
    { code: "made_up_code", path: SHAPE_ROOT_PATH, message: "no" } as never,
  ]);
  expect(() => assertResponseCheck(surface, {})).toThrow(/made_up_code/);
  expect(Object.isFrozen(SEMANTIC_VIOLATION_CODES)).toBe(true);
});

test("cross-item rules the descriptor language cannot express live here", () => {
  const surface = "test_cross_item";
  registerResponseCheck(surface, (payload) => {
    const report = payload as {
      readonly sources: ReadonlyArray<string>;
      readonly findings: ReadonlyArray<{ readonly sources: ReadonlyArray<string> }>;
    };
    const consulted = new Set(report.sources);
    return report.findings.flatMap((finding, index) =>
      finding.sources
        .filter((source) => !consulted.has(source))
        .map((source) =>
          semanticViolation(
            SEMANTIC_VIOLATION_CODES.setMembership,
            `${SHAPE_ROOT_PATH}.findings[${index}].sources`,
            `cites a source not in the consulted set: ${JSON.stringify(source)}`,
          ),
        ),
    );
  });

  expect(() =>
    assertResponseCheck(surface, { sources: ["a"], findings: [{ sources: ["a"] }] }),
  ).not.toThrow();

  let thrown: unknown;
  try {
    assertResponseCheck(surface, {
      sources: ["a"],
      findings: [{ sources: ["a"] }, { sources: ["b", "c"] }],
    });
  } catch (err) {
    thrown = err;
  }
  const error = thrown as ResponseCheckError;
  expect(error.code).toBe(SEMANTIC_VIOLATION_CODES.setMembership);
  expect(error.violations).toHaveLength(2);
  expect(error.path).toBe("$.findings[1].sources");
});

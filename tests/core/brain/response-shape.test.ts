/**
 * Response-shape layer (signals-that-survive, unit 8, t_80b01448).
 *
 * The validator itself, the frozen descriptors declared for the
 * model-authored write paths, and the two discipline rules that keep the
 * layer usable: descriptors stay inside the subset the validator can
 * express, and the layer never borrows the knowledge vocabulary's noun.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as responseShapeModule from "../../../src/core/brain/response-shape.ts";
import {
  DERIVED_FACT_SHAPE,
  DISTILL_CLAIMS_SHAPE,
  MODEL_AUTHORED_SHAPES,
  RESEARCH_REPORT_SHAPE,
  ResponseShapeError,
  SHAPE_DESCRIPTOR_KEYS,
  SHAPE_ROOT_PATH,
  SHAPE_TYPES,
  SHAPE_VIOLATION_CODES,
  assertResponseShape,
  checkResponseShape,
  formatShapeViolation,
  type ShapeDescriptor,
} from "../../../src/core/brain/response-shape.ts";

const MODULE_PATH = join(import.meta.dir, "../../../src/core/brain/response-shape.ts");

/** Object nesting an object descriptor reaches, counting through array items. */
function objectNestingDepth(descriptor: ShapeDescriptor): number {
  if (descriptor.type === "object" || descriptor.properties !== undefined) {
    const children = Object.values(descriptor.properties ?? {});
    return 1 + children.reduce((deepest, child) => Math.max(deepest, objectNestingDepth(child)), 0);
  }
  if (descriptor.items !== undefined) return objectNestingDepth(descriptor.items);
  return 0;
}

/** Every descriptor node reachable from a root, root included. */
function descriptorNodes(descriptor: ShapeDescriptor): ShapeDescriptor[] {
  const nodes = [descriptor];
  for (const child of Object.values(descriptor.properties ?? {})) {
    nodes.push(...descriptorNodes(child));
  }
  if (descriptor.items !== undefined) nodes.push(...descriptorNodes(descriptor.items));
  if (typeof descriptor.additionalProperties === "object") {
    nodes.push(...descriptorNodes(descriptor.additionalProperties));
  }
  return nodes;
}

/** Deepest object nesting a shallow descriptor may declare: object -> array -> object. */
const MAX_OBJECT_NESTING = 2;

describe("checkResponseShape", () => {
  test("accepts a payload that satisfies the descriptor", () => {
    expect(checkResponseShape(DISTILL_CLAIMS_SHAPE, [{ text: "a claim" }])).toEqual([]);
  });

  test("reports a type mismatch with a structured code and path", () => {
    const violations = checkResponseShape(DISTILL_CLAIMS_SHAPE, [{ text: "ok" }, { text: 42 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      code: SHAPE_VIOLATION_CODES.typeMismatch,
      path: "$[1].text",
      message: "expected string",
    });
  });

  test("reports a missing required property", () => {
    const violations = checkResponseShape(DERIVED_FACT_SHAPE, {
      topic: "t",
      principle: "p",
      premises: ["pref-a"],
      level: "deduced",
    });
    expect(violations).toEqual([
      {
        code: SHAPE_VIOLATION_CODES.missingProperty,
        path: SHAPE_ROOT_PATH,
        message: "missing required property 'slug'",
      },
    ]);
  });

  test("renders a violation as the path-prefixed line the callers print", () => {
    const [violation] = checkResponseShape({ type: "string" }, 1);
    expect(formatShapeViolation(violation!)).toBe("$: expected string");
  });
});

describe("assertResponseShape", () => {
  test("returns silently for a conforming payload", () => {
    expect(() =>
      assertResponseShape("demo", RESEARCH_REPORT_SHAPE, {
        title: "T",
        sources: ["a"],
        findings: [{ statement: "s", sources: ["a"] }],
      }),
    ).not.toThrow();
  });

  test("throws a named error carrying code, path and message as fields", () => {
    let caught: unknown;
    try {
      assertResponseShape("demo", RESEARCH_REPORT_SHAPE, {
        title: "T",
        sources: ["a"],
        findings: [{ statement: "s" }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseShapeError);
    const err = caught as ResponseShapeError;
    expect(err.name).toBe("ResponseShapeError");
    expect(err.code).toBe(SHAPE_VIOLATION_CODES.missingProperty);
    expect(err.path).toBe("$.findings[0]");
    expect(err.message).toContain("missing required property 'sources'");
    expect(err.surface).toBe("demo");
    expect(err.violations).toEqual([
      {
        code: SHAPE_VIOLATION_CODES.missingProperty,
        path: "$.findings[0]",
        message: "missing required property 'sources'",
      },
    ]);
  });
});

describe("model-authored descriptors", () => {
  test("one descriptor per model-authored write path, all registered", () => {
    expect(new Set(Object.values(MODEL_AUTHORED_SHAPES))).toEqual(
      new Set([DISTILL_CLAIMS_SHAPE, DERIVED_FACT_SHAPE, RESEARCH_REPORT_SHAPE]),
    );
  });

  test("every descriptor is frozen all the way down", () => {
    for (const [surface, descriptor] of Object.entries(MODEL_AUTHORED_SHAPES)) {
      for (const node of descriptorNodes(descriptor)) {
        expect(Object.isFrozen(node), `${surface} descriptor node is mutable`).toBe(true);
      }
    }
  });

  test("no descriptor uses a construct the subset validator cannot express", () => {
    const allowedKeys = new Set<string>(SHAPE_DESCRIPTOR_KEYS);
    const allowedTypes = new Set<string>(SHAPE_TYPES);
    for (const [surface, descriptor] of Object.entries(MODEL_AUTHORED_SHAPES)) {
      for (const node of descriptorNodes(descriptor)) {
        for (const key of Object.keys(node)) {
          expect(allowedKeys.has(key), `${surface} descriptor declares '${key}'`).toBe(true);
        }
        if (node.type !== undefined) {
          expect(allowedTypes.has(node.type), `${surface} descriptor type '${node.type}'`).toBe(
            true,
          );
        }
      }
    }
  });

  test("descriptors stay shallow: required keys, primitives, arrays of objects", () => {
    for (const [surface, descriptor] of Object.entries(MODEL_AUTHORED_SHAPES)) {
      expect(
        objectNestingDepth(descriptor),
        `${surface} descriptor is too deep`,
      ).toBeLessThanOrEqual(MAX_OBJECT_NESTING);
    }
  });
});

describe("layer discipline", () => {
  test("the knowledge vocabulary's noun never appears in this layer", () => {
    expect(readFileSync(MODULE_PATH, "utf8")).not.toMatch(/schema/i);
    for (const name of Object.keys(responseShapeModule)) {
      expect(name).not.toMatch(/schema/i);
    }
  });

  test("validation reads no configuration, so no key can disable it", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    for (const token of ["config", "guardrail", "policy", "process.env", "loadBrain"]) {
      expect(source, `response-shape must not consult ${token}`).not.toContain(token);
    }
  });
});

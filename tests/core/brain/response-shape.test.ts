/**
 * Response-shape layer (signals-that-survive, unit 8, t_80b01448).
 *
 * The validator itself, the frozen descriptors declared for the
 * model-authored write paths, and the two discipline rules that keep the
 * layer usable: descriptors stay inside the subset the validator can
 * express, and the layer never borrows the knowledge vocabulary's noun.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as responseShapeModule from "../../../src/core/brain/response-shape.ts";
import { parseDistillClaims } from "../../../src/core/brain/distill/distill-source.ts";
import { parseDeriveFactInput } from "../../../src/core/brain/derived-fact.ts";
import { parseResearchReportInput } from "../../../src/core/brain/research/research.ts";
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
  test("the knowledge vocabulary's noun is absent from everything this layer emits", () => {
    // Asserted over the surface a caller can observe - exported names, the
    // descriptor vocabulary, the violation codes and a thrown message - rather
    // than over the module text, where a comment could fail the suite and a
    // borrowed noun in a caller could not.
    for (const name of Object.keys(responseShapeModule)) {
      expect(name).not.toMatch(/schema/i);
    }
    for (const key of SHAPE_DESCRIPTOR_KEYS) expect(key).not.toMatch(/schema/i);
    for (const code of Object.values(SHAPE_VIOLATION_CODES)) {
      expect(code).not.toMatch(/schema/i);
    }
    const thrown = (() => {
      try {
        assertResponseShape("demo", DERIVED_FACT_SHAPE, {});
      } catch (err) {
        return err as ResponseShapeError;
      }
      return null;
    })();
    expect(thrown!.name).not.toMatch(/schema/i);
    expect(thrown!.message).not.toMatch(/schema/i);
  });

  test("no configuration or environment can change a verdict", () => {
    const payload = { title: "T", sources: [""], findings: [{ statement: "s", sources: [""] }] };
    const baseline = checkResponseShape(RESEARCH_REPORT_SHAPE, payload);
    expect(baseline.length).toBeGreaterThan(0);

    const configHome = mkdtempSync(join(tmpdir(), "o2b-response-shape-cfg-"));
    const configPath = join(configHome, "config.yaml");
    // A config declaring every plausible opt-out spelling, at the path the
    // whole codebase resolves settings from, plus the same spellings as env.
    writeFileSync(
      configPath,
      [
        "vault: /nonexistent",
        "response_shape: false",
        "response_shape_enabled: false",
        "response_shape_strict: false",
        "validation: off",
        "",
      ].join("\n"),
      "utf8",
    );
    const hostile: Record<string, string> = {
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      OPEN_SECOND_BRAIN_RESPONSE_SHAPE_ENABLED: "false",
      OPEN_SECOND_BRAIN_RESPONSE_SHAPE: "off",
      NODE_ENV: "production",
    };
    const saved = new Map(Object.keys(hostile).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(hostile)) process.env[key] = value;
      // The validator, and the three ingress functions that own the callers'
      // half of the contract, all still refuse the same payload by the same
      // path - a gate introduced in a caller would break exactly here.
      expect(checkResponseShape(RESEARCH_REPORT_SHAPE, payload)).toEqual(baseline);
      expect(() => assertResponseShape("demo", RESEARCH_REPORT_SHAPE, payload)).toThrow(
        ResponseShapeError,
      );
      expect(() => parseResearchReportInput(payload)).toThrow(ResponseShapeError);
      expect(() => parseDistillClaims([{ text: 1 }])).toThrow(ResponseShapeError);
      expect(() => parseDeriveFactInput({ topic: "t" })).toThrow(ResponseShapeError);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(configHome, { recursive: true, force: true });
    }
  });
});

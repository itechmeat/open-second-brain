/**
 * Activation kernel math (Time-Aware Recall & Activation Suite,
 * t_2bc79017): pure ACT-R-style strength bump and type-aware half-life
 * decay. No I/O, injected ages only.
 */

import { describe, expect, test } from "bun:test";

import {
  ACTIVATION_STRENGTH_MAX,
  ACTIVATION_STRENGTH_STEP,
  DEFAULT_HALF_LIFE_DAYS,
  bumpStrength,
  effectiveActivation,
  halfLifeDays,
  resolveActivationKind,
} from "../../../src/core/search/activation/decay.ts";

describe("half-life table", () => {
  test("preference, decision, and antipattern never decay", () => {
    expect(halfLifeDays("preference")).toBeNull();
    expect(halfLifeDays("decision")).toBeNull();
    expect(halfLifeDays("antipattern")).toBeNull();
  });

  test("project, handoff, session, and note carry the documented half-lives", () => {
    expect(halfLifeDays("project")).toBe(120);
    expect(halfLifeDays("handoff")).toBe(30);
    expect(halfLifeDays("session")).toBe(30);
    expect(halfLifeDays("note")).toBe(DEFAULT_HALF_LIFE_DAYS);
  });

  test("an unknown kind falls back to the note default", () => {
    expect(halfLifeDays("totally-custom-kind")).toBe(DEFAULT_HALF_LIFE_DAYS);
  });
});

describe("resolveActivationKind", () => {
  test("frontmatter kind wins over the path", () => {
    expect(resolveActivationKind("Decision", "Brain/notes/x.md")).toBe("decision");
    expect(resolveActivationKind("handoff", "Brain/preferences/pref-x.md")).toBe("handoff");
  });

  test("the framework brain- prefix is stripped", () => {
    expect(resolveActivationKind("brain-preference", "Brain/preferences/pref-x.md")).toBe(
      "preference",
    );
    expect(resolveActivationKind("Brain-Decision", "Brain/notes/x.md")).toBe("decision");
  });

  test("path prefixes resolve framework directories without frontmatter", () => {
    expect(resolveActivationKind(null, "Brain/preferences/pref-x.md")).toBe("preference");
    expect(resolveActivationKind(null, "Brain/decisions/panels/p.md")).toBe("decision");
  });

  test("everything else defaults to note", () => {
    expect(resolveActivationKind(null, "Projects/atlas/overview.md")).toBe("note");
    expect(resolveActivationKind("", "Daily/2026.06.04.md")).toBe("note");
  });
});

describe("bumpStrength", () => {
  test("adds one step and caps at the maximum", () => {
    expect(bumpStrength(0)).toBeCloseTo(ACTIVATION_STRENGTH_STEP, 10);
    expect(bumpStrength(0.35)).toBeCloseTo(0.45, 10);
    expect(bumpStrength(ACTIVATION_STRENGTH_MAX)).toBe(ACTIVATION_STRENGTH_MAX);
    expect(bumpStrength(0.95)).toBe(ACTIVATION_STRENGTH_MAX);
  });

  test("junk input is treated as zero strength", () => {
    expect(bumpStrength(Number.NaN)).toBeCloseTo(ACTIVATION_STRENGTH_STEP, 10);
    expect(bumpStrength(-5)).toBeCloseTo(ACTIVATION_STRENGTH_STEP, 10);
  });
});

describe("effectiveActivation", () => {
  test("an infinite half-life never decays", () => {
    expect(effectiveActivation(0.8, 0, null)).toBe(0.8);
    expect(effectiveActivation(0.8, 3650, null)).toBe(0.8);
  });

  test("a finite half-life halves the strength every half-life", () => {
    expect(effectiveActivation(0.8, 0, 30)).toBeCloseTo(0.8, 10);
    expect(effectiveActivation(0.8, 30, 30)).toBeCloseTo(0.4, 10);
    expect(effectiveActivation(0.8, 60, 30)).toBeCloseTo(0.2, 10);
  });

  test("future access times clamp to age zero", () => {
    expect(effectiveActivation(0.6, -10, 30)).toBeCloseTo(0.6, 10);
  });

  test("non-finite inputs yield zero", () => {
    expect(effectiveActivation(Number.NaN, 10, 30)).toBe(0);
    expect(effectiveActivation(0.5, Number.POSITIVE_INFINITY, 30)).toBe(0);
  });
});

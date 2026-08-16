/**
 * Census over the runtime-facts population.
 *
 * `RUNTIME_FACTS` answers "what does this build know about the host it is
 * installed into". That answer is only worth reading if it covers every
 * runtime this build can install into, and covers nothing else - a row
 * for a target with no adapter is a fact about a host nobody can reach,
 * and an adapter with no row is a host the ceiling, profile and session
 * questions are silently unanswered for.
 *
 * So the population is DERIVED, from `registerAllAdapters().targets()` -
 * the live registry each adapter registers itself into at import time -
 * and compared against the declared key set in both directions. Neither
 * half may be the source of the other: a table that vouches for its own
 * completeness vouches for nothing.
 *
 * The count is pinned as an equality rather than a floor, for the reason
 * every census here pins one: a registry that stopped being populated
 * would sweep an empty set clean and every assertion below would pass.
 */

import { describe, expect, test } from "bun:test";

import { registerAllAdapters } from "../../../src/core/install/adapters/all.ts";
import {
  INSTALL_TARGET_IDS,
  isInstallTargetId,
  RUNTIME_FACTS,
} from "../../../src/core/runtime/host-facts.ts";

/**
 * Registered adapters today. An equality, so adding an adapter is a
 * deliberate edit here rather than a silent widening of the population.
 */
const REGISTERED_TARGET_COUNT = 10;

const registeredTargets = (): ReadonlyArray<string> => registerAllAdapters().targets();

describe("runtime facts census", () => {
  test("every registered adapter has a row and every row has an adapter", () => {
    // One expectation, whose value NAMES what is missing: asserting the
    // two directions separately would stop at the first and hide the rest.
    const declared = new Set(Object.keys(RUNTIME_FACTS));
    const registered = new Set(registeredTargets());
    const unaccounted = [
      ...[...registered]
        .filter((target) => !declared.has(target))
        .map((target) => `adapter with no RUNTIME_FACTS row: ${target}`),
      ...[...declared]
        .filter((target) => !registered.has(target))
        .map((target) => `RUNTIME_FACTS row with no adapter: ${target}`),
    ];
    expect(unaccounted.toSorted().join("\n")).toBe("");
  });

  test("every row's label is the adapter's own label, as the field claims", () => {
    // `RuntimeFacts.label` is documented as "matching the adapter's own
    // label" and nothing in `src/` read it - `--friction` prints
    // `adapter.label`. A declared fact with no reader and no assertion is
    // free to drift into a second, quietly wrong name for the same host,
    // which is the defect this release exists to remove. This is the
    // reader: not a consumer of the value, but the binding that makes the
    // claim true or fails.
    const mismatched = registerAllAdapters()
      .list()
      .filter((adapter) => RUNTIME_FACTS[adapter.target].label !== adapter.label)
      .map(
        (adapter) =>
          `${adapter.target}: row says '${RUNTIME_FACTS[adapter.target].label}', ` +
          `adapter says '${adapter.label}'`,
      );
    expect(mismatched.toSorted().join("\n")).toBe("");
  });

  test("the vocabulary and the row keys are the same set", () => {
    // The third corner: a member with no row would type-check everywhere
    // and resolve to `undefined` at the one call site that reads it.
    const declared: ReadonlyArray<string> = INSTALL_TARGET_IDS;
    expect(declared.toSorted()).toEqual(Object.keys(RUNTIME_FACTS).toSorted());
  });

  test("every registered target is a vocabulary member", () => {
    const strangers = registeredTargets().filter((target) => !isInstallTargetId(target));
    expect(strangers.toSorted().join("\n")).toBe("");
  });

  test("the census is not vacuous", () => {
    // A registry that registered nothing, or a barrel that lost its
    // side-effect imports, would make every comparison above trivially
    // true. Pin the measurement, not only its verdict.
    expect(registeredTargets().length).toBe(REGISTERED_TARGET_COUNT);
    expect(Object.keys(RUNTIME_FACTS).length).toBe(REGISTERED_TARGET_COUNT);
  });
});

/**
 * Contract item 3 (truth-correctable-time-aware, Task 15): the
 * serve-with-correction coupling predicate.
 *
 * A retired-but-serveable row is served only beside its chain-tip
 * correction; an unresolved or out-of-reach successor drops the row
 * fail-closed, so a withheld page stays indistinguishable from an
 * absent one. Every serving surface consumes this predicate, so the
 * rule table here is the single spelling of the guarantee.
 */

import { describe, expect, test } from "bun:test";

import { chainVerdict, couplingVerdict } from "../../../src/core/search/correction-coupling.ts";

const PREDECESSOR = "Brain/preferences/pref-old-rule.md";
const SUCCESSOR = "Brain/preferences/pref-new-rule.md";

describe("couplingVerdict", () => {
  test("a resolved and readable successor serves the row beside its correction", () => {
    expect(
      couplingVerdict({
        predecessorPath: PREDECESSOR,
        successorPath: SUCCESSOR,
        successorReadable: true,
      }),
    ).toEqual({ action: "serve_coupled", correctionPath: SUCCESSOR });
  });

  test("an unresolved successor (null path) drops the row", () => {
    expect(
      couplingVerdict({
        predecessorPath: PREDECESSOR,
        successorPath: null,
        successorReadable: true,
      }),
    ).toEqual({ action: "drop" });
  });

  test("a successor out of the caller's reach drops the row", () => {
    expect(
      couplingVerdict({
        predecessorPath: PREDECESSOR,
        successorPath: SUCCESSOR,
        successorReadable: false,
      }),
    ).toEqual({ action: "drop" });
  });

  test("an unresolved AND unreadable successor drops the row", () => {
    expect(
      couplingVerdict({
        predecessorPath: PREDECESSOR,
        successorPath: null,
        successorReadable: false,
      }),
    ).toEqual({ action: "drop" });
  });

  test("the verdict carries the successor path verbatim as the correction path", () => {
    const nested = "Brain/decisions/nested/correction-page.md";
    const verdict = couplingVerdict({
      predecessorPath: PREDECESSOR,
      successorPath: nested,
      successorReadable: true,
    });
    expect(verdict).toEqual({ action: "serve_coupled", correctionPath: nested });
  });

  test("the predicate is pure and deterministic: same input, same verdict", () => {
    const input = {
      predecessorPath: PREDECESSOR,
      successorPath: SUCCESSOR,
      successorReadable: true,
    };
    expect(couplingVerdict(input)).toEqual(couplingVerdict(input));
    expect(couplingVerdict({ ...input, successorReadable: false })).toEqual(
      couplingVerdict({ ...input, successorReadable: false }),
    );
  });

  test("the predicate performs no I/O: it answers for pages that do not exist", () => {
    // Paths that name no file anywhere still resolve a verdict - the
    // predicate reads nothing, callers resolve readability before asking.
    const nowhere = "Brain/nowhere/neither-page.md";
    expect(
      couplingVerdict({
        predecessorPath: nowhere,
        successorPath: nowhere,
        successorReadable: false,
      }),
    ).toEqual({ action: "drop" });
  });
});

describe("chainVerdict", () => {
  test("a fully resolved chain serves the row beside the resolved tip", () => {
    expect(chainVerdict(PREDECESSOR, { resolvedAll: true, cycle: false, tip: SUCCESSOR })).toEqual({
      action: "serve_coupled",
      correctionPath: SUCCESSOR,
    });
  });

  test("a dangling successor hop drops the row fail-closed", () => {
    expect(chainVerdict(PREDECESSOR, { resolvedAll: false, cycle: false, tip: SUCCESSOR })).toEqual(
      { action: "drop" },
    );
  });

  test("a cyclic chain drops the row fail-closed", () => {
    expect(chainVerdict(PREDECESSOR, { resolvedAll: true, cycle: true, tip: PREDECESSOR })).toEqual(
      { action: "drop" },
    );
  });
});

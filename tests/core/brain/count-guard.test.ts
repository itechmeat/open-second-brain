import { expect, test } from "bun:test";

import { CountGuardError, assertExpectedCount } from "../../../src/core/brain/count-guard.ts";

test("a matching --expect passes", () => {
  expect(() => assertExpectedCount({ matched: 3, expect: 3, willMutate: true })).not.toThrow();
});

test("a mismatched --expect throws with the matched count and match list", () => {
  let err: CountGuardError | null = null;
  try {
    assertExpectedCount({
      matched: 5,
      expect: 3,
      willMutate: true,
      matchList: ["a.md", "b.md", "c.md", "d.md", "e.md"],
    });
  } catch (e) {
    err = e as CountGuardError;
  }
  expect(err).toBeInstanceOf(CountGuardError);
  expect(err!.matched).toBe(5);
  expect(err!.expected).toBe(3);
  expect(err!.message).toContain("5");
  expect(err!.message).toContain("3");
  // The match list is surfaced so the operator sees exactly what would change.
  expect(err!.message).toContain("a.md");
  expect(err!.matchList).toEqual(["a.md", "b.md", "c.md", "d.md", "e.md"]);
});

test("--strict refuses a guardless mutation (no --expect)", () => {
  let err: CountGuardError | null = null;
  try {
    assertExpectedCount({ matched: 2, strict: true, willMutate: true });
  } catch (e) {
    err = e as CountGuardError;
  }
  expect(err).toBeInstanceOf(CountGuardError);
  expect(err!.message.toLowerCase()).toContain("strict");
});

test("--strict with an explicit --expect that matches passes", () => {
  expect(() =>
    assertExpectedCount({ matched: 2, expect: 2, strict: true, willMutate: true }),
  ).not.toThrow();
});

test("--strict does not fire on a dry-run (no mutation)", () => {
  expect(() => assertExpectedCount({ matched: 2, strict: true, willMutate: false })).not.toThrow();
});

test("with neither guard the call is a no-op (default off)", () => {
  expect(() => assertExpectedCount({ matched: 99, willMutate: true })).not.toThrow();
});

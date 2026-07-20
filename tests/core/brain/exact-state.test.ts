import { test, expect, beforeEach, afterEach } from "bun:test";
import { readdirSync } from "node:fs";

import {
  clearExactState,
  ExactStateError,
  listExactState,
  readExactState,
  writeExactState,
} from "../../../src/core/brain/exact-state.ts";
import { brainStateDir } from "../../../src/core/brain/paths.ts";
import { createTempVault } from "../../helpers/search-fixtures.ts";

let vault: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("exact-state");
  vault = v.vault;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

test("writing an aspect stores its canonical value", () => {
  const entry = writeExactState(vault, "deploy-target", "staging cluster eu-west-1");
  expect(entry.aspect).toBe("deploy-target");
  expect(entry.value).toBe("staging cluster eu-west-1");
  expect(readExactState(vault, "deploy-target")?.value).toBe("staging cluster eu-west-1");
});

test("overwriting an aspect replaces its value with no history accumulation", () => {
  writeExactState(vault, "deploy-target", "staging cluster eu-west-1");
  writeExactState(vault, "deploy-target", "production cluster us-east-1");

  // Only the latest value survives.
  expect(readExactState(vault, "deploy-target")?.value).toBe("production cluster us-east-1");

  // Exactly one file for the aspect - no history sidecars, no versioned copies.
  const files = readdirSync(brainStateDir(vault));
  expect(files).toEqual(["deploy-target.md"]);
});

test("listing returns every aspect sorted deterministically", () => {
  writeExactState(vault, "branch", "feat/x");
  writeExactState(vault, "aspect-a", "value a");
  const entries = listExactState(vault);
  expect(entries.map((e) => e.aspect)).toEqual(["aspect-a", "branch"]);
});

test("clearing an aspect removes it and reports whether it existed", () => {
  writeExactState(vault, "branch", "feat/x");
  expect(clearExactState(vault, "branch")).toBe(true);
  expect(readExactState(vault, "branch")).toBeNull();
  expect(clearExactState(vault, "branch")).toBe(false);
});

test("reading a missing aspect returns null", () => {
  expect(readExactState(vault, "never-written")).toBeNull();
});

test("an over-budget value is rejected with a typed error, not truncated", () => {
  const huge = "x".repeat(20_001);
  expect(() => writeExactState(vault, "big", huge)).toThrow(ExactStateError);
  // Nothing was written.
  expect(readExactState(vault, "big")).toBeNull();
});

test("an empty aspect slug is rejected", () => {
  expect(() => writeExactState(vault, "   ", "value")).toThrow();
});

test("an invalid aspect slug is a typed ExactStateError, not a generic Error", () => {
  // A path separator is rejected by the slug guard; it must surface as a
  // typed invalid_aspect failure so the CLI catch handles it instead of
  // crashing.
  for (const call of [
    () => writeExactState(vault, "bad/aspect", "value"),
    () => readExactState(vault, "bad/aspect"),
    () => clearExactState(vault, "bad/aspect"),
  ]) {
    let caught: unknown;
    try {
      call();
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(ExactStateError);
    expect((caught as ExactStateError).code).toBe("invalid_aspect");
  }
});

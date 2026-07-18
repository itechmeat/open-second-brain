import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitObservedUse } from "../../../../src/core/brain/observed-use.ts";
import {
  CURATOR_HIGH_USE_MIN_DEFAULT,
  curatorSlices,
} from "../../../../src/core/brain/lifecycle/curator.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-curator-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function record(
  entries: Array<{ path: string; verdict: "USED" | "IGNORED" | "CONTRADICTED" }>,
): void {
  emitObservedUse(vault, {
    host: "test",
    entries: entries.map((e) => ({ id: e.path, path: e.path, verdict: e.verdict })),
  });
}

test("curatorSlices reports injected-never-used memories", () => {
  record([{ path: "a.md", verdict: "IGNORED" }]);
  record([{ path: "a.md", verdict: "IGNORED" }]);
  record([{ path: "b.md", verdict: "USED" }]);

  const slices = curatorSlices(vault);
  const neverUsed = slices.injectedNeverUsed.map((e) => e.key);
  expect(neverUsed).toContain("a.md");
  expect(neverUsed).not.toContain("b.md");
});

test("curatorSlices reports contradicted memories", () => {
  record([{ path: "c.md", verdict: "CONTRADICTED" }]);
  record([{ path: "d.md", verdict: "USED" }]);

  const slices = curatorSlices(vault);
  expect(slices.contradicted.map((e) => e.key)).toEqual(["c.md"]);
});

test("curatorSlices reports high-used memories above the threshold", () => {
  for (let i = 0; i < CURATOR_HIGH_USE_MIN_DEFAULT; i++)
    record([{ path: "hot.md", verdict: "USED" }]);
  record([{ path: "cold.md", verdict: "USED" }]);

  const slices = curatorSlices(vault);
  expect(slices.highUsed.map((e) => e.key)).toContain("hot.md");
  expect(slices.highUsed.map((e) => e.key)).not.toContain("cold.md");
});

test("curatorSlices honours an explicit high-use minimum", () => {
  record([{ path: "one.md", verdict: "USED" }]);
  const slices = curatorSlices(vault, { highUseMin: 1 });
  expect(slices.highUsed.map((e) => e.key)).toContain("one.md");
});

test("curatorSlices returns empty slices for an empty vault", () => {
  const slices = curatorSlices(vault);
  expect(slices.injectedNeverUsed).toEqual([]);
  expect(slices.contradicted).toEqual([]);
  expect(slices.highUsed).toEqual([]);
});

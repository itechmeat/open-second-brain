import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyObservedUse,
  emitObservedUse,
  observedReuseRates,
} from "../../src/core/brain/observed-use.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-observed-use-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

test("classifyObservedUse marks a memory USED when a later turn echoes it", () => {
  const verdicts = classifyObservedUse(
    [{ id: "1", path: "ml.md", content: "gradient descent optimizes the loss surface" }],
    ["Earlier we applied gradient descent to optimize the model."],
  );
  expect(verdicts[0]!.verdict).toBe("USED");
});

test("classifyObservedUse marks an unreferenced memory IGNORED", () => {
  const verdicts = classifyObservedUse(
    [{ id: "1", content: "green turtles migrate across oceans" }],
    ["The build pipeline failed on the lint step."],
  );
  expect(verdicts[0]!.verdict).toBe("IGNORED");
});

test("classifyObservedUse marks a stance flip CONTRADICTED", () => {
  const verdicts = classifyObservedUse(
    [{ id: "1", content: "the production deploy is safe" }],
    ["Actually the production deploy is not safe right now."],
  );
  expect(verdicts[0]!.verdict).toBe("CONTRADICTED");
});

test("observedReuseRates folds verdicts into a per-artifact score", () => {
  emitObservedUse(vault, {
    host: "t",
    entries: [
      { id: "a", path: "a.md", verdict: "USED" },
      { id: "b", path: "b.md", verdict: "IGNORED" },
    ],
  });
  emitObservedUse(vault, {
    host: "t",
    entries: [
      { id: "a", path: "a.md", verdict: "USED" },
      { id: "c", path: "c.md", verdict: "CONTRADICTED" },
    ],
  });
  const rates = observedReuseRates(vault);
  expect(rates.get("a.md")!.used).toBe(2);
  expect(rates.get("a.md")!.score).toBe(1); // 2 used / 2 total
  expect(rates.get("b.md")!.score).toBe(0); // ignored only
  expect(rates.get("c.md")!.score).toBe(0); // contradicted demotes to 0
});

test("a contradicted-heavy artifact scores below a used one", () => {
  emitObservedUse(vault, {
    host: "t",
    entries: [
      { id: "x", path: "x.md", verdict: "USED" },
      { id: "x", path: "x.md", verdict: "CONTRADICTED" },
    ],
  });
  const r = observedReuseRates(vault).get("x.md")!;
  expect(r.used).toBe(1);
  expect(r.contradicted).toBe(1);
  expect(r.score).toBe(0); // (1 - 1) / 2
});

test("an empty vault yields an empty reuse map (byte-identical ranking)", () => {
  expect(observedReuseRates(vault).size).toBe(0);
});

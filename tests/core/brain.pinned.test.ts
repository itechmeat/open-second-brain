import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainPinnedPath } from "../../src/core/brain/paths.ts";
import {
  MAX_PINNED_CONTEXT_LEN,
  PinnedBatchError,
  applyPinnedOperations,
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
} from "../../src/core/brain/pinned.ts";
import { PRIVATE_REGION_PLACEHOLDER } from "../../src/core/redactor.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-pinned-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("pinned context paths", () => {
  test("uses Brain/pinned.md under the vault", () => {
    expect(brainPinnedPath(vault)).toBe(join(vault, "Brain", "pinned.md"));
  });
});

describe("pinned context core", () => {
  test("reads missing pinned context as empty", () => {
    const pinned = readPinnedContext(vault);
    expect(pinned.present).toBe(false);
    expect(pinned.content).toBe("");
    expect(pinned.path).toBe(brainPinnedPath(vault));
  });

  test("writes sanitised content atomically", () => {
    const pinned = writePinnedContext(
      vault,
      "Remember api_key=abc\n<private>do not store this</private>",
    );
    expect(pinned.present).toBe(true);
    expect(pinned.content).toContain("api_key=***REDACTED***");
    expect(pinned.content).toContain(PRIVATE_REGION_PLACEHOLDER);
    expect(pinned.content).not.toContain("do not store this");
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe(`${pinned.content}\n`);
  });

  test("appends content with a blank-line separator", () => {
    writePinnedContext(vault, "First fact");
    const pinned = appendPinnedContext(vault, "Second fact");
    expect(pinned.content).toBe("First fact\n\nSecond fact");
  });

  test("clear leaves an empty pinned file", () => {
    writePinnedContext(vault, "Temporary fact");
    const pinned = clearPinnedContext(vault);
    expect(pinned.present).toBe(true);
    expect(pinned.content).toBe("");
    expect(existsSync(brainPinnedPath(vault))).toBe(true);
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe("");
  });
});

describe("pinned context batch operations", () => {
  test("applies write/append/replace operations in order, all-or-nothing", () => {
    const result = applyPinnedOperations(vault, [
      { op: "write", content: "alpha" },
      { op: "append", content: "beta" },
      { op: "replace", find: "alpha", replace: "ALPHA" },
    ]);
    expect(result.content).toBe("ALPHA\n\nbeta");
    expect(result.applied).toBe(3);
    expect(result.done).toBe(true);
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe("ALPHA\n\nbeta\n");
  });

  test("clear inside a batch resets accumulated content", () => {
    writePinnedContext(vault, "old");
    const result = applyPinnedOperations(vault, [
      { op: "append", content: "transient" },
      { op: "clear" },
      { op: "write", content: "fresh" },
    ]);
    expect(result.content).toBe("fresh");
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe("fresh\n");
  });

  test("a malformed middle operation leaves the pinned file byte-for-byte unchanged", () => {
    writePinnedContext(vault, "seed content");
    const before = readFileSync(brainPinnedPath(vault), "utf8");

    expect(() =>
      applyPinnedOperations(vault, [
        { op: "append", content: "should-not-persist" },
        { op: "bogus" as unknown as "write" },
        { op: "append", content: "also-should-not-persist" },
      ]),
    ).toThrow(PinnedBatchError);

    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe(before);
    expect(readPinnedContext(vault).content).toBe("seed content");
  });

  test("a replace whose target is absent aborts the whole batch without writing", () => {
    writePinnedContext(vault, "seed content");
    const before = readFileSync(brainPinnedPath(vault), "utf8");

    let captured: PinnedBatchError | undefined;
    try {
      applyPinnedOperations(vault, [
        { op: "append", content: "more" },
        { op: "replace", find: "NOT-PRESENT", replace: "x" },
      ]);
    } catch (err) {
      captured = err as PinnedBatchError;
    }
    expect(captured).toBeInstanceOf(PinnedBatchError);
    expect(captured?.code).toBe("replace_target_missing");
    expect(captured?.index).toBe(1);
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe(before);
  });

  test("an over-budget final projection is rejected without writing", () => {
    writePinnedContext(vault, "seed");
    const before = readFileSync(brainPinnedPath(vault), "utf8");
    const huge = "x".repeat(MAX_PINNED_CONTEXT_LEN + 100);

    let captured: PinnedBatchError | undefined;
    try {
      applyPinnedOperations(vault, [{ op: "write", content: huge }]);
    } catch (err) {
      captured = err as PinnedBatchError;
    }
    expect(captured).toBeInstanceOf(PinnedBatchError);
    expect(captured?.code).toBe("budget_exceeded");
    expect(readFileSync(brainPinnedPath(vault), "utf8")).toBe(before);
  });

  test("rejects an empty operations array without writing", () => {
    expect(() => applyPinnedOperations(vault, [])).toThrow(PinnedBatchError);
    expect(existsSync(brainPinnedPath(vault))).toBe(false);
  });
});

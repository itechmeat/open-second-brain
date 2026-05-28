import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brainPinnedPath } from "../../src/core/brain/paths.ts";
import {
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

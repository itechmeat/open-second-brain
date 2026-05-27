import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkInstructionFileCeiling } from "../../../../src/core/brain/trust/instruction-file-ceiling.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ceiling-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("checkInstructionFileCeiling", () => {
  test("no tracked files present -> empty warnings", () => {
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    expect(r).toEqual([]);
  });

  test("CLAUDE.md under ceiling -> no warning", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "line\n".repeat(50));
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    expect(r).toEqual([]);
  });

  test("CLAUDE.md above ceiling -> one warning with exact line count", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "line\n".repeat(300));
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe("CLAUDE.md");
    expect(r[0]?.lines).toBe(300);
    expect(r[0]?.ceiling).toBe(200);
  });

  test("AGENTS.md and GEMINI.md are tracked too", () => {
    writeFileSync(join(vault, "AGENTS.md"), "x\n".repeat(250));
    writeFileSync(join(vault, "GEMINI.md"), "y\n".repeat(250));
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    const paths = [...r].map((w) => w.path).toSorted();
    expect(paths).toEqual(["AGENTS.md", "GEMINI.md"]);
  });

  test("file without trailing newline counts lines correctly", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "a\nb\nc");
    const r = checkInstructionFileCeiling(vault, { maxLines: 2 });
    expect(r).toHaveLength(1);
    expect(r[0]?.lines).toBe(3);
  });

  test("empty file is not a warning", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "");
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    expect(r).toEqual([]);
  });

  test("returned warnings are frozen", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "z\n".repeat(300));
    const r = checkInstructionFileCeiling(vault, { maxLines: 200 });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r[0])).toBe(true);
  });

  test("ceiling=0 catches every non-empty file (degenerate case)", () => {
    writeFileSync(join(vault, "CLAUDE.md"), "single line");
    const r = checkInstructionFileCeiling(vault, { maxLines: 0 });
    expect(r).toHaveLength(1);
  });
});

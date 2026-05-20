import { describe, expect, test } from "bun:test";
import {
  insertManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  extractManagedBlock,
  ManagedBlockError,
  DEFAULT_BEGIN_MARKER,
  DEFAULT_END_MARKER,
} from "../../../src/core/install/managed-block.ts";

describe("managed-block insertManagedBlock", () => {
  test("appends block when no marker present, preserves preceding content", () => {
    const before = `# user config\nkey: value\n`;
    const out = insertManagedBlock(before, "  - path/to/file\n");
    expect(out).toContain(DEFAULT_BEGIN_MARKER);
    expect(out).toContain(DEFAULT_END_MARKER);
    expect(out).toContain("  - path/to/file");
    expect(out.startsWith("# user config\nkey: value\n")).toBe(true);
  });

  test("replaces existing block, leaves surrounding content untouched", () => {
    const before = `# top\n${DEFAULT_BEGIN_MARKER}\nOLD\n${DEFAULT_END_MARKER}\n# bottom\n`;
    const out = insertManagedBlock(before, "NEW\n");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
    expect(out.startsWith("# top\n")).toBe(true);
    expect(out.trimEnd().endsWith("# bottom")).toBe(true);
  });

  test("re-apply is idempotent", () => {
    const before = `# top\n`;
    const once = insertManagedBlock(before, "BODY\n");
    const twice = insertManagedBlock(once, "BODY\n");
    expect(once).toBe(twice);
  });

  test("CRLF input preserves CRLF line endings on write", () => {
    const before = `# top\r\nkey: value\r\n`;
    const out = insertManagedBlock(before, "BODY\n");
    expect(out.includes("\r\n")).toBe(true);
  });

  test("rejects nested begin markers", () => {
    const malformed = `${DEFAULT_BEGIN_MARKER}\n${DEFAULT_BEGIN_MARKER}\n${DEFAULT_END_MARKER}\n`;
    expect(() => insertManagedBlock(malformed, "x")).toThrow(ManagedBlockError);
  });

  test("rejects unterminated block (begin without end)", () => {
    const malformed = `${DEFAULT_BEGIN_MARKER}\nstuff\n`;
    expect(() => insertManagedBlock(malformed, "x")).toThrow(ManagedBlockError);
  });

  test("custom markers parametrised through opts", () => {
    const before = "# top\n";
    const out = insertManagedBlock(before, "X\n", {
      beginMarker: "# >>>>> open-second-brain custom >>>>>",
      endMarker: "# <<<<< open-second-brain custom <<<<<",
    });
    expect(out).toContain("# >>>>> open-second-brain custom >>>>>");
  });
});

describe("managed-block removeManagedBlock", () => {
  test("removes block and markers, normalises blank lines", () => {
    const before = `# top\n\n${DEFAULT_BEGIN_MARKER}\nBODY\n${DEFAULT_END_MARKER}\n\n# bottom\n`;
    const out = removeManagedBlock(before);
    expect(out).not.toContain(DEFAULT_BEGIN_MARKER);
    expect(out).not.toContain("BODY");
    expect(out).toContain("# top");
    expect(out).toContain("# bottom");
    expect(out.includes("\n\n\n")).toBe(false);
  });

  test("noop when no block present", () => {
    const before = `# nothing here\n`;
    expect(removeManagedBlock(before)).toBe(before);
  });
});

describe("managed-block detection helpers", () => {
  test("hasManagedBlock recognises a present block", () => {
    const text = `${DEFAULT_BEGIN_MARKER}\nbody\n${DEFAULT_END_MARKER}\n`;
    expect(hasManagedBlock(text)).toBe(true);
  });

  test("hasManagedBlock false when missing", () => {
    expect(hasManagedBlock("# nothing\n")).toBe(false);
  });

  test("extractManagedBlock returns the body without markers", () => {
    const text = `# x\n${DEFAULT_BEGIN_MARKER}\nLINE1\nLINE2\n${DEFAULT_END_MARKER}\n# y\n`;
    expect(extractManagedBlock(text)).toBe("LINE1\nLINE2");
  });
});

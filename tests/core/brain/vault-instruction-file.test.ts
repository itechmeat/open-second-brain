/**
 * Unit tests for `readVaultInstructionFile` - reads a vault-root
 * user-authored instruction file (default `VAULT.md`) and returns
 * its content plus a vault-relative path. `brain_context` consumes
 * this so agents see operator-curated context alongside the
 * preference-derived active block.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readVaultInstructionFile } from "../../../src/core/brain/vault-instruction-file.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-vault-instruction-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("readVaultInstructionFile - default name", () => {
  test("returns null when VAULT.md is absent", () => {
    const r = readVaultInstructionFile(vault);
    expect(r).toBeNull();
  });

  test("reads VAULT.md content with line count and vault-relative path", () => {
    const body = "# Vault\n\nI work on X.\nDeadlines matter.\n";
    writeFileSync(join(vault, "VAULT.md"), body);
    const r = readVaultInstructionFile(vault);
    expect(r).not.toBeNull();
    expect(r!.content).toBe(body);
    expect(r!.path).toBe("VAULT.md");
    expect(r!.lines).toBe(4);
  });
});

describe("readVaultInstructionFile - configurable name", () => {
  test("reads GUIDE.md when caller passes name override", () => {
    writeFileSync(join(vault, "GUIDE.md"), "# Custom\n");
    const r = readVaultInstructionFile(vault, "GUIDE.md");
    expect(r).not.toBeNull();
    expect(r!.path).toBe("GUIDE.md");
  });

  test("returns null for an override pointing at a nonexistent file", () => {
    const r = readVaultInstructionFile(vault, "MISSING.md");
    expect(r).toBeNull();
  });

  test("rejects absolute-path override with an error", () => {
    expect(() => readVaultInstructionFile(vault, "/etc/passwd")).toThrow();
  });

  test("rejects relative path with .. traversal", () => {
    expect(() => readVaultInstructionFile(vault, "../leak.md")).toThrow();
  });

  test("rejects empty override", () => {
    expect(() => readVaultInstructionFile(vault, "")).toThrow();
  });
});

describe("readVaultInstructionFile - shape", () => {
  test("frozen result object", () => {
    writeFileSync(join(vault, "VAULT.md"), "single line");
    const r = readVaultInstructionFile(vault);
    expect(Object.isFrozen(r!)).toBe(true);
  });

  test("counts newlines correctly for trailing-newline file", () => {
    writeFileSync(join(vault, "VAULT.md"), "line one\nline two\n");
    const r = readVaultInstructionFile(vault);
    expect(r!.lines).toBe(2);
  });

  test("counts newlines correctly for no-trailing-newline file", () => {
    writeFileSync(join(vault, "VAULT.md"), "line one\nline two");
    const r = readVaultInstructionFile(vault);
    expect(r!.lines).toBe(2);
  });

  test("empty file is treated as zero lines", () => {
    writeFileSync(join(vault, "VAULT.md"), "");
    const r = readVaultInstructionFile(vault);
    expect(r!.lines).toBe(0);
    expect(r!.content).toBe("");
  });
});

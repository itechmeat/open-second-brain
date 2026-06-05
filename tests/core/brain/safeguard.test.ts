/**
 * Operation safeguard (t_06784b8d): cooperative deadline + output
 * caps for long-running brain operations. Bun + synchronous SQLite
 * cannot be preempted honestly, so the safeguard is a deadline object
 * whose checkpoint() throws at the next natural iteration boundary
 * past the deadline - no fake async cancellation. Timeouts resolve
 * per-operation key -> global key -> built-in default; 0 disables.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capOutput,
  createSafeguard,
  resolveSafeguardTimeoutMs,
  SAFEGUARD_DEFAULT_TIMEOUT_SECONDS,
  SafeguardTimeoutError,
} from "../../../src/core/brain/safeguard.ts";

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-safeguard-"));
  for (const key of ["OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT", "OPEN_SECOND_BRAIN_CONFIG"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("createSafeguard", () => {
  test("checkpoint passes before the deadline and throws after it", () => {
    let clock = 1_000;
    const guard = createSafeguard({ operation: "dream", timeoutMs: 50, now: () => clock });
    guard.checkpoint();
    clock += 49;
    guard.checkpoint();
    clock += 2;
    expect(() => guard.checkpoint()).toThrow(SafeguardTimeoutError);
  });

  test("the error names the operation and the budget", () => {
    let clock = 0;
    const guard = createSafeguard({ operation: "reindex", timeoutMs: 10, now: () => clock });
    clock = 11;
    try {
      guard.checkpoint();
      throw new Error("expected SafeguardTimeoutError");
    } catch (exc) {
      expect(exc).toBeInstanceOf(SafeguardTimeoutError);
      const e = exc as SafeguardTimeoutError;
      expect(e.operation).toBe("reindex");
      expect(e.timeoutMs).toBe(10);
      expect(e.message).toContain("reindex");
      expect(e.message).toContain("10");
    }
  });

  test("timeoutMs 0 disables the deadline entirely", () => {
    let clock = 0;
    const guard = createSafeguard({ operation: "dream", timeoutMs: 0, now: () => clock });
    clock = Number.MAX_SAFE_INTEGER;
    expect(() => guard.checkpoint()).not.toThrow();
    expect(guard.timeoutMs).toBeNull();
  });

  test("null timeout also disables", () => {
    const guard = createSafeguard({ operation: "dream", timeoutMs: null });
    expect(() => guard.checkpoint()).not.toThrow();
  });
});

describe("resolveSafeguardTimeoutMs", () => {
  function writeConfig(body: string): string {
    const p = join(tmp, "config.yaml");
    writeFileSync(p, body);
    return p;
  }

  test("defaults to the built-in budget with no config", () => {
    const p = writeConfig(`vault: ${tmp}\n`);
    expect(resolveSafeguardTimeoutMs("dream", p)).toBe(SAFEGUARD_DEFAULT_TIMEOUT_SECONDS * 1000);
  });

  test("global key overrides the default", () => {
    const p = writeConfig(`vault: ${tmp}\nsafeguard_timeout_seconds: 120\n`);
    expect(resolveSafeguardTimeoutMs("dream", p)).toBe(120_000);
    expect(resolveSafeguardTimeoutMs("bridges", p)).toBe(120_000);
  });

  test("per-operation key beats the global key", () => {
    const p = writeConfig(
      `vault: ${tmp}\nsafeguard_timeout_seconds: 120\nsafeguard_timeout_dream_seconds: 30\n`,
    );
    expect(resolveSafeguardTimeoutMs("dream", p)).toBe(30_000);
    expect(resolveSafeguardTimeoutMs("reindex", p)).toBe(120_000);
  });

  test("environment mirror beats the config global", () => {
    const p = writeConfig(`vault: ${tmp}\nsafeguard_timeout_seconds: 120\n`);
    process.env["OPEN_SECOND_BRAIN_SAFEGUARD_TIMEOUT"] = "45";
    expect(resolveSafeguardTimeoutMs("clusters", p)).toBe(45_000);
  });

  test("0 disables and resolves to null", () => {
    const p = writeConfig(`vault: ${tmp}\nsafeguard_timeout_seconds: 0\n`);
    expect(resolveSafeguardTimeoutMs("dream", p)).toBeNull();
  });

  test("invalid values fail soft to the default", () => {
    const p = writeConfig(`vault: ${tmp}\nsafeguard_timeout_seconds: soon\n`);
    expect(resolveSafeguardTimeoutMs("dream", p)).toBe(SAFEGUARD_DEFAULT_TIMEOUT_SECONDS * 1000);
  });
});

describe("capOutput", () => {
  test("under the cap is returned unchanged", () => {
    expect(capOutput("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  test("over the cap truncates with an explicit marker inside the budget", () => {
    const out = capOutput("a".repeat(500), 100);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("truncated");
    expect(out.text.startsWith("aaa")).toBe(true);
    // The marker counts against the cap: the total stays within it.
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(100);
  });

  test("multibyte input is not split mid-character", () => {
    const out = capOutput("я".repeat(200), 100);
    expect(out.truncated).toBe(true);
    // Every kept character survives intact (no U+FFFD replacement).
    expect(out.text).not.toContain("�");
    expect(Buffer.byteLength(out.text, "utf8")).toBeLessThanOrEqual(100);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TOKEN_WARN_THRESHOLD_DEFAULT,
  computeTokenFootprint,
} from "../../../src/core/brain/token-footprint.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-token-footprint-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("computeTokenFootprint", () => {
  test("empty vault reports zero with the default threshold", () => {
    const r = computeTokenFootprint(vault);
    expect(r.total).toBe(0);
    expect(r.files).toBe(0);
    expect(r.warnThreshold).toBe(TOKEN_WARN_THRESHOLD_DEFAULT);
    expect(r.exceeded).toBe(false);
  });

  test("counts preferences, retired, inbox, processed, log buckets", () => {
    writeFileSync(join(vault, "Brain", "preferences", "pref-a.md"), "alpha beta gamma\n");
    writeFileSync(join(vault, "Brain", "retired", "ret-b.md"), "delta epsilon\n");
    writeFileSync(join(vault, "Brain", "inbox", "sig-c.md"), "zeta eta theta iota\n");
    writeFileSync(join(vault, "Brain", "inbox", "processed", "sig-d.md"), "kappa lambda\n");
    writeFileSync(join(vault, "Brain", "log", "2026-05-25.md"), "mu nu xi omicron\n");
    const r = computeTokenFootprint(vault);
    expect(r.files).toBe(5);
    const names = r.byCategory.map((c) => c.name);
    expect(names).toContain("preferences");
    expect(names).toContain("retired");
    expect(names).toContain("inbox");
    expect(names).toContain("processed");
    expect(names).toContain("log");
    expect(r.total).toBeGreaterThan(0);
  });

  test("processed pages are NOT double-counted by the inbox walker", () => {
    // The inbox dir contains processed/ as a subdir; the inbox sum
    // would naturally recurse into it. The processed bucket counts
    // those files separately, so the total must equal the sum of
    // both buckets exactly.
    writeFileSync(join(vault, "Brain", "inbox", "sig-a.md"), "alpha beta gamma\n");
    writeFileSync(join(vault, "Brain", "inbox", "processed", "sig-b.md"), "delta epsilon zeta\n");
    const r = computeTokenFootprint(vault);
    const inbox = r.byCategory.find((c) => c.name === "inbox")!.tokens;
    const processed = r.byCategory.find((c) => c.name === "processed")!.tokens;
    expect(r.total).toBe(inbox + processed);
  });

  test("exceeded flag flips when total crosses the threshold", () => {
    writeFileSync(join(vault, "Brain", "preferences", "pref-big.md"), "word ".repeat(50));
    const r = computeTokenFootprint(vault, { warnThreshold: 1 });
    expect(r.exceeded).toBe(true);
  });

  test("env override is honoured", () => {
    const r = computeTokenFootprint(vault, { envWarnThreshold: "5000" });
    expect(r.warnThreshold).toBe(5000);
  });

  test("malformed env value falls back to default", () => {
    const r = computeTokenFootprint(vault, { envWarnThreshold: "garbage" });
    expect(r.warnThreshold).toBe(TOKEN_WARN_THRESHOLD_DEFAULT);
  });

  test("'other' bucket captures stray Brain/*.md files only", () => {
    writeFileSync(join(vault, "Brain", "active.md"), "alpha beta\n");
    const r = computeTokenFootprint(vault);
    const other = r.byCategory.find((c) => c.name === "other")!;
    expect(other.files).toBeGreaterThanOrEqual(1);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packContext } from "../../../src/core/brain/context-pack.ts";
import {
  dismissTension,
  persistTension,
  resolveTension,
} from "../../../src/core/brain/tensions.ts";
import type { NoteContradictionFinding } from "../../../src/core/brain/health/contradiction.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-cp-tensions-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writePref(slug: string, principle: string, body: string) {
  writeFileSync(
    join(vault, "Brain", "preferences", `pref-${slug}.md`),
    [
      "---",
      `id: pref-${slug}`,
      "topic: t",
      `principle: ${principle}`,
      "tier: core",
      "---",
      "",
      body,
    ].join("\n"),
  );
}

function finding(): NoteContradictionFinding {
  return {
    aId: "pref-tabs",
    bId: "pref-spaces",
    subject: "for indentation tabs use",
    jaccard: 0.6,
    aSign: "positive",
    bSign: "negative",
    aQuote: "Always use tabs.",
    bQuote: "Never use tabs.",
    action: "ask_user",
  };
}

describe("packContext tension warnings", () => {
  test("a tension-free vault produces no warnings key (byte-identical)", () => {
    writePref("tabs", "always use tabs", "Always use tabs.");
    const report = packContext(vault, { maxTokens: 1000 });
    expect(report.warnings).toBeUndefined();
  });

  test("injecting a subject note of an unresolved tension emits a warning naming it", () => {
    writePref("tabs", "always use tabs", "Always use tabs.");
    writePref("spaces", "never use tabs", "Never use tabs.");
    const { record } = persistTension(vault, finding(), { agent: "tester" });

    const report = packContext(vault, { maxTokens: 1000 });
    expect(report.warnings).toBeDefined();
    expect(report.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(report.warnings!.some((w) => w.includes(record.id))).toBe(true);
  });

  test("a dismissed tension emits no warning", () => {
    writePref("tabs", "always use tabs", "Always use tabs.");
    writePref("spaces", "never use tabs", "Never use tabs.");
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    dismissTension(vault, record.slug, { agent: "tester" });

    const report = packContext(vault, { maxTokens: 1000 });
    expect(report.warnings).toBeUndefined();
  });

  test("a resolved tension emits no warning", () => {
    writePref("tabs", "always use tabs", "Always use tabs.");
    writePref("spaces", "never use tabs", "Never use tabs.");
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    resolveTension(vault, record.slug, { agent: "tester" });

    const report = packContext(vault, { maxTokens: 1000 });
    expect(report.warnings).toBeUndefined();
  });

  test("a confirmed (still unresolved) tension still warns", () => {
    writePref("tabs", "always use tabs", "Always use tabs.");
    writePref("spaces", "never use tabs", "Never use tabs.");
    const { record } = persistTension(vault, finding(), { agent: "tester" });
    // confirm keeps it unresolved
    const cp = packContext(vault, { maxTokens: 1000 });
    expect(cp.warnings).toBeDefined();
    expect(record.status).toBe("open");
  });
});

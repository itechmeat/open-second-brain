/**
 * SDK llms-txt export surface (facade test).
 *
 * The SDK's `exportPreferencesLlmsTxt` string form carries no denial
 * report - reserved rows leave the text silently. The detailed variant
 * on the facade is what an in-process caller uses to name what stayed
 * out, the same additive report the json lane carries in its envelope.
 * The string form keeps its exact behavior: same text, no report.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrain } from "../../../src/core/brain/sdk.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-sdk-llms-txt-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

/** Hand-add an informal privacy marker, the way an operator does. */
function stampMarker(slug: string, line: string): void {
  const abs = join(vault, "Brain", "preferences", `pref-${slug}.md`);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
}

function seed(slug: string, principle: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: "confirmed",
    evidenced_by: [`[[sig-2026-05-01-${slug}]]`],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: "high",
    confidence_value: 0.8,
    pinned: false,
  });
}

describe("createBrain llms-txt export", () => {
  test("the detailed variant returns the text beside the omissions", () => {
    seed("open", "Open principle");
    seed("reserved", "Reserved principle");
    stampMarker("reserved", "access: private");

    const brain = createBrain(vault);
    const detail = brain.exportPreferencesLlmsTxtDetailed();
    expect(detail.text).toContain("pref-open");
    expect(detail.text).toContain("Open principle");
    expect(detail.text).not.toContain("pref-reserved");
    expect(detail.omitted).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "access" },
    ]);
  });

  test("the string form keeps its behavior and agrees with the detailed text", () => {
    seed("open", "Open principle");
    seed("reserved", "Reserved principle");
    stampMarker("reserved", "access: private");

    const brain = createBrain(vault);
    expect(brain.exportPreferencesLlmsTxt()).toBe(brain.exportPreferencesLlmsTxtDetailed().text);
    expect(brain.exportPreferencesLlmsTxt()).not.toContain("pref-reserved");
  });

  test("an unmarked vault omits nothing", () => {
    seed("plain", "Plain principle");
    const detail = createBrain(vault).exportPreferencesLlmsTxtDetailed();
    expect(detail.omitted).toEqual([]);
    expect(detail.text).toContain("pref-plain");
  });
});

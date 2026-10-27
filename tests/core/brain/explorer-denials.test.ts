/**
 * Tests for `collectExplorerDenials` (§14 explorer, shared-lane
 * withholding report).
 *
 * The live collector keeps every parsed node; this report is what the
 * export narrows by. Pinned here: one list over both node kinds, the
 * denying key named per row, id-sorted determinism, and an empty answer
 * for an unmarked vault.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectExplorerDenials } from "../../../src/core/brain/explorer.ts";
import {
  moveToRetired,
  writePreference,
  type WritePreferenceInput,
} from "../../../src/core/brain/preference.ts";
import { BRAIN_RETIRED_REASON } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-explorer-denials-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

function basePref(
  slug: string,
  overrides: Partial<WritePreferenceInput> = {},
): WritePreferenceInput {
  return {
    slug,
    topic: slug,
    principle: `Principle for ${slug}`,
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
    ...overrides,
  };
}

/** Hand-add a frontmatter line the way an operator does. */
function stampMarker(relPath: string, line: string): void {
  const abs = join(vault, relPath);
  writeFileSync(abs, readFileSync(abs, "utf8").replace(/^---\n/, `---\n${line}\n`));
}

describe("collectExplorerDenials", () => {
  test("an unmarked vault denies nothing", () => {
    writePreference(vault, basePref("plain"));
    expect(collectExplorerDenials(vault)).toEqual([]);
  });

  test("reserved preference and retired nodes are one sorted list, each with its key", () => {
    writePreference(vault, basePref("open"));
    writePreference(vault, basePref("reserved"));
    stampMarker("Brain/preferences/pref-reserved.md", "access: private");

    writePreference(vault, basePref("old"));
    const deadPath = join(vault, "Brain", "preferences", "pref-old.md");
    moveToRetired(vault, deadPath, BRAIN_RETIRED_REASON.staleNoEvidence, {
      now: new Date("2026-05-10T00:00:00Z"),
      retired_by: "[[Brain/log/2026-05-10]]",
    });
    stampMarker("Brain/retired/ret-old.md", "visibility: private");

    const denied = collectExplorerDenials(vault);
    expect(denied).toEqual([
      { id: "pref-reserved", reason: "visibility", denied_by: "access" },
      { id: "ret-old", reason: "visibility", denied_by: "visibility" },
    ]);
  });

  test("the formal reserved token denies under its own key", () => {
    writePreference(vault, basePref("formal", { visibility: ["private"] }));
    const denied = collectExplorerDenials(vault);
    expect(denied).toEqual([{ id: "pref-formal", reason: "visibility", denied_by: "visibility" }]);
  });

  test("an unparsable file denies nothing - the export refuses on it first", () => {
    writePreference(vault, basePref("good"));
    writeFileSync(join(vault, "Brain", "preferences", "pref-broken.md"), "no frontmatter here\n");
    expect(collectExplorerDenials(vault)).toEqual([]);
  });
});

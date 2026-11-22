import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { preferencePath, retiredPath } from "../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-deadline-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function seedTrial(slug: string, evidenceAt: string): void {
  writePreference(vault, {
    slug,
    topic: slug,
    principle: `Trial rule ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T08:00:00Z",
    status: "unconfirmed",
    evidenced_by: [],
  });
  appendApplyEvidence(
    vault,
    { pref_id: slug, artifact: `Daily/${slug}.md`, result: "applied", agent: "test" },
    { now: new Date(evidenceAt) },
  );
}

describe("trial confirmation deadline", () => {
  test("evidence dated before the deadline confirms the trial", () => {
    seedTrial("before-deadline", "2026-05-08T07:00:00Z");

    const result = dream(vault, { now: new Date("2026-05-08T10:00:00Z") });

    expect(result.confirmed).toContain("pref-before-deadline");
    expect(parsePreference(preferencePath(vault, "before-deadline")).status).toBe("confirmed");
  });

  test.each([
    ["morning", "2026-05-08T10:00:00Z"],
    ["evening", "2026-05-08T20:00:00Z"],
  ])("evidence after the deadline stays counted and retires at the %s run", (label, now) => {
    seedTrial(`after-deadline-${label}`, "2026-05-08T09:00:00Z");

    const result = dream(vault, { now: new Date(now) });

    expect(result.confirmed).not.toContain(`pref-after-deadline-${label}`);
    expect(result.retired).toContainEqual({
      id: `ret-after-deadline-${label}`,
      reason: "expired-unconfirmed",
    });
    expect(readFileSync(retiredPath(vault, `after-deadline-${label}`), "utf8")).toContain(
      `Daily/after-deadline-${label}.md`,
    );
  });
});

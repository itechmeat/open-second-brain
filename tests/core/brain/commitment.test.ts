import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRAIN_COMMITMENT_TIER,
  CommitmentError,
  isCommitmentTier,
  readCommitmentTier,
  validateCommitmentTier,
} from "../../../src/core/brain/commitment.ts";
import { regenerateActive } from "../../../src/core/brain/active.ts";
import { brainActivePath } from "../../../src/core/brain/paths.ts";
import { parsePreference, writePreference } from "../../../src/core/brain/preference.ts";
import { recordThesis, showThesis } from "../../../src/core/brain/health/thesis.ts";
import { recordDecision, showDecision } from "../../../src/core/brain/decisions/record.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-commitment-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("commitment vocabulary", () => {
  test("validateCommitmentTier accepts the four tiers and rejects junk", () => {
    for (const tier of Object.values(BRAIN_COMMITMENT_TIER)) {
      expect(validateCommitmentTier(tier)).toBe(tier);
    }
    expect(validateCommitmentTier(undefined)).toBeNull();
    expect(validateCommitmentTier("")).toBeNull();
    expect(() => validateCommitmentTier("committed")).toThrow(CommitmentError);
    expect(() => validateCommitmentTier(3)).toThrow(CommitmentError);
  });

  test("readCommitmentTier tolerates junk", () => {
    expect(readCommitmentTier({ commitment: "locked" })).toBe("locked");
    expect(readCommitmentTier({ commitment: "nonsense" })).toBeNull();
    expect(readCommitmentTier({})).toBeNull();
    expect(isCommitmentTier("decided")).toBe(true);
    expect(isCommitmentTier("x")).toBe(false);
  });
});

function seedPref(slug: string, extra: Record<string, unknown> = {}): string {
  return writePreference(vault, {
    slug,
    topic: slug,
    principle: `principle ${slug}`,
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-30T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-05-02T00:00:00Z",
    evidenced_by: [],
    applied_count: 5,
    violated_count: 0,
    last_evidence_at: "2026-05-09T00:00:00Z",
    confidence: "high",
    confidence_value: 0.87,
    ...extra,
  }).path;
}

describe("commitment round-trip on preferences", () => {
  test("preference frontmatter round-trips a commitment tier", () => {
    const path = seedPref("alpha", { commitment: "locked" });
    const parsed = parsePreference(path);
    expect(parsed.commitment).toBe("locked");
    expect(readFileSync(path, "utf8")).toContain("commitment: locked");
  });

  test("invalid commitment on write rejects with a typed error", () => {
    expect(() => seedPref("beta", { commitment: "committed" })).toThrow(CommitmentError);
  });

  test("unset commitment omits the frontmatter key", () => {
    const path = seedPref("gamma");
    expect(readFileSync(path, "utf8")).not.toContain("commitment:");
    expect(parsePreference(path).commitment).toBeUndefined();
  });
});

describe("active.md renders the tier in place of the confidence float", () => {
  test("tier label replaces the numeric float when set", () => {
    seedPref("locked-one", { commitment: "locked" });
    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    const body = readFileSync(brainActivePath(vault), "utf8");
    expect(body).toContain("confidence: high (locked)");
    expect(body).not.toContain("(0.87)");
  });

  test("byte-identical to today when unset (regression)", () => {
    seedPref("plain-one");
    regenerateActive(vault, { now: new Date("2026-05-15T10:00:00Z") });
    const withoutTier = readFileSync(brainActivePath(vault), "utf8");
    expect(withoutTier).toContain("confidence: high (0.87)");
    expect(withoutTier).not.toContain("(locked)");
  });
});

describe("commitment round-trip on theses and decisions", () => {
  test("thesis frontmatter round-trips a commitment tier", () => {
    const page = recordThesis(vault, {
      statement: "Bun is the right runtime",
      agent: "tester",
      commitment: "decided",
    });
    expect(showThesis(vault, page.slug)!.commitment).toBe("decided");
    expect(readFileSync(page.path, "utf8")).toContain("commitment: decided");
  });

  test("thesis without commitment omits the key", () => {
    const page = recordThesis(vault, { statement: "No tier here", agent: "tester" });
    expect(readFileSync(page.path, "utf8")).not.toContain("commitment:");
    expect(showThesis(vault, page.slug)!.commitment).toBeNull();
  });

  test("decision frontmatter round-trips a commitment tier", () => {
    const res = recordDecision(vault, {
      title: "Adopt Bun",
      chosen: "Bun",
      assumption: "compat",
      reviewDate: "2026-12-01",
      agent: "tester",
      commitment: "leaning",
    });
    expect(showDecision(vault, res.record.slug)!.commitment).toBe("leaning");
    expect(readFileSync(res.record.path, "utf8")).toContain("commitment: leaning");
  });

  test("invalid commitment on a decision rejects", () => {
    expect(() =>
      recordDecision(vault, {
        title: "Bad tier",
        chosen: "x",
        assumption: "y",
        reviewDate: "2026-12-01",
        agent: "tester",
        commitment: "committed" as never,
      }),
    ).toThrow(CommitmentError);
  });
});

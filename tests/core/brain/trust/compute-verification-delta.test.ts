import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DreamRunSummary } from "../../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { writePreference } from "../../../../src/core/brain/preference.ts";
import { computeVerificationDelta } from "../../../../src/core/brain/trust/compute-verification-delta.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-verify-delta-"));
  bootstrapBrain(vault);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function emptyDream(over: Partial<DreamRunSummary> = {}): DreamRunSummary {
  return Object.freeze({
    run_id: "dream-2026-05-25-000000",
    changed: false,
    new_unconfirmed: [],
    confirmed: [],
    retired: [],
    contradictions: [],
    moved_to_processed: [],
    suppressed: [],
    warnings: [],
    uncertain: [],
    quarantined: [],
    ...over,
  }) as DreamRunSummary;
}

describe("computeVerificationDelta", () => {
  test("clean vault, empty dream -> all-zero counts", () => {
    const r = computeVerificationDelta(vault, emptyDream());
    expect(r.summary).toEqual({
      confirmed: 0,
      drift: 0,
      regression: 0,
      missing_evidence: 0,
    });
    expect(r.entries).toEqual([]);
  });

  test("confirmed: pref exists with applied_count > 0", () => {
    writePreference(vault, {
      slug: "test-rule",
      topic: "test-topic",
      principle: "limit X to 10",
      created_at: "2026-05-20T00:00:00Z",
      confirmed_at: "2026-05-21T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-1]]"],
      applied_count: 3,
      violated_count: 0,
      last_evidence_at: "2026-05-22T00:00:00Z",
      confidence: "high",
    });

    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-test-rule"] }),
    );
    expect(r.summary.confirmed).toBe(1);
    expect(r.summary.drift).toBe(0);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]?.state).toBe("confirmed");
    expect(r.entries[0]?.id).toBe("pref-test-rule");
  });

  test("drift: pref exists with applied_count == 0", () => {
    writePreference(vault, {
      slug: "no-evidence",
      topic: "topic-2",
      principle: "limit Y to 5",
      created_at: "2026-05-20T00:00:00Z",
      confirmed_at: "2026-05-21T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-2]]"],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "low",
    });

    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-no-evidence"] }),
    );
    expect(r.summary.drift).toBe(1);
    expect(r.entries[0]?.state).toBe("drift");
  });

  test("missing_evidence: dream cites pref id that no longer exists on disk", () => {
    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-ghost-id"] }),
    );
    expect(r.summary.missing_evidence).toBe(1);
    expect(r.entries[0]?.state).toBe("missing_evidence");
    expect(r.entries[0]?.id).toBe("pref-ghost-id");
  });

  test("mixed scenarios produce distinct counts", () => {
    writePreference(vault, {
      slug: "good",
      topic: "t1",
      principle: "limit A to 100",
      created_at: "2026-05-20T00:00:00Z",
      confirmed_at: "2026-05-21T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-good]]"],
      applied_count: 5,
      violated_count: 0,
      last_evidence_at: "2026-05-22T00:00:00Z",
      confidence: "high",
    });
    writePreference(vault, {
      slug: "drifty",
      topic: "t2",
      principle: "limit B to 50",
      created_at: "2026-05-20T00:00:00Z",
      confirmed_at: "2026-05-21T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-drifty]]"],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: "low",
    });

    const r = computeVerificationDelta(
      vault,
      emptyDream({
        confirmed: ["pref-good", "pref-drifty", "pref-ghost"],
      }),
    );
    expect(r.summary.confirmed).toBe(1);
    expect(r.summary.drift).toBe(1);
    expect(r.summary.missing_evidence).toBe(1);
  });
});

describe("computeVerificationDelta - regression + path contract", () => {
  test("regression: dream cited as confirmed but on-disk status is unconfirmed", () => {
    writePreference(vault, {
      slug: "claim-mismatch",
      topic: "claim-mismatch",
      principle: "limit Z to 10",
      created_at: "2026-05-20T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "unconfirmed",
      evidenced_by: ["[[sig-z]]"],
    });
    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-claim-mismatch"] }),
    );
    expect(r.summary.drift).toBe(1);
    expect(r.entries[0]?.state).toBe("drift");
    expect(r.entries[0]?.note).toMatch(/on-disk status is 'unconfirmed'/);
  });

  test("entries carry vault-relative paths (no absolute host paths leak)", () => {
    writePreference(vault, {
      slug: "path-shape",
      topic: "path-shape",
      principle: "limit P to 5",
      created_at: "2026-05-20T00:00:00Z",
      confirmed_at: "2026-05-21T00:00:00Z",
      unconfirmed_until: "2026-06-03T00:00:00Z",
      status: "confirmed",
      evidenced_by: ["[[sig-p]]"],
      applied_count: 1,
      last_evidence_at: "2026-05-22T00:00:00Z",
    });
    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-path-shape"] }),
    );
    const path = r.entries[0]?.path ?? "";
    // Vault-relative path: starts with `Brain/preferences/`, never
    // with `/tmp/...` or any other absolute host directory.
    expect(path.startsWith("/")).toBe(false);
    expect(path).toBe("Brain/preferences/pref-path-shape.md");
  });

  test("malformed slug surfaces as missing_evidence, not a thrown error", () => {
    // Slug with characters rejected by validateSlug (uppercase, spaces).
    const r = computeVerificationDelta(
      vault,
      emptyDream({ confirmed: ["pref-Invalid Slug!"] }),
    );
    expect(r.summary.missing_evidence).toBe(1);
    expect(r.entries[0]?.state).toBe("missing_evidence");
  });
});

describe("computeVerificationDelta structural invariants", () => {
  test("result is frozen", () => {
    const r = computeVerificationDelta(vault, emptyDream());
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.summary)).toBe(true);
    expect(Object.isFrozen(r.entries)).toBe(true);
  });
});

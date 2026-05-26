import { describe, expect, test } from "bun:test";

import {
  BRAIN_APPLY_RESULT,
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
} from "../../src/core/brain/types.ts";
import type {
  BrainApplyEvidenceLogEvent,
  BrainConfig,
  BrainPreference,
  BrainRetired,
  BrainSignal,
} from "../../src/core/brain/types.ts";

// These tests are a type-checking smoke screen. The `satisfies` operator
// pins each literal to its interface; a regression in the type shape
// would surface as a compile-time error (caught by `bun run typecheck`),
// while the runtime assertions below cover the const enums.

describe("BRAIN_* const enums", () => {
  test("BRAIN_SIGNAL_SIGN values", () => {
    expect(BRAIN_SIGNAL_SIGN.positive).toBe("positive");
    expect(BRAIN_SIGNAL_SIGN.negative).toBe("negative");
  });

  test("BRAIN_PREFERENCE_STATUS values", () => {
    expect(BRAIN_PREFERENCE_STATUS.unconfirmed).toBe("unconfirmed");
    expect(BRAIN_PREFERENCE_STATUS.confirmed).toBe("confirmed");
    expect(BRAIN_PREFERENCE_STATUS.quarantine).toBe("quarantine");
  });

  test("BRAIN_CONFIDENCE values", () => {
    expect(BRAIN_CONFIDENCE.low).toBe("low");
    expect(BRAIN_CONFIDENCE.medium).toBe("medium");
    expect(BRAIN_CONFIDENCE.high).toBe("high");
  });

  test("BRAIN_RETIRED_REASON covers every reason emitted by dream / CLI", () => {
    expect(BRAIN_RETIRED_REASON.staleNoEvidence).toBe("stale-no-evidence");
    expect(BRAIN_RETIRED_REASON.expiredUnconfirmed).toBe("expired-unconfirmed");
    expect(BRAIN_RETIRED_REASON.rebutted).toBe("rebutted");
    expect(BRAIN_RETIRED_REASON.userRejected).toBe("user-rejected");
    expect(BRAIN_RETIRED_REASON.quarantineViolated).toBe("quarantine-violated");
    expect(BRAIN_RETIRED_REASON.supersededByContext).toBe("superseded-by-context");
    expect(BRAIN_RETIRED_REASON.mergedInto).toBe("merged-into");
  });

  test("BRAIN_APPLY_RESULT values", () => {
    expect(BRAIN_APPLY_RESULT.applied).toBe("applied");
    expect(BRAIN_APPLY_RESULT.violated).toBe("violated");
    expect(BRAIN_APPLY_RESULT.outdated).toBe("outdated");
  });

  test("BRAIN_LOG_EVENT_KIND covers every event type listed in §5.5 / §7.4 + capture-extensions §9/§16/§24", () => {
    const expected = new Set<string>([
      "dream",
      "feedback",
      "apply-evidence",
      "force-confirmed",
      "reject",
      "promote",
      "retire",
      "noted-redundant",
      "signal-suppressed",
      "skip-corrupted-frontmatter",
      "pin",
      "unpin",
      "rollback",
      // capture extensions
      "scan-inline",
      "import-session",
      // §12 merge (v0.10.5)
      "merge",
      // §22 upgrade (v0.10.6)
      "upgrade",
      // §3 import-claude-memory (agent-discipline-tail)
      "import-claude-memory",
      // §32B (v0.10.8) brain_note narrative milestones
      "note",
      // v0.12.0 Brain Integrity Suite: content-hash drift on a
      // confirmed preference whose stored _content_hash no longer
      // matches the recomputed hash of its live (principle, scope).
      "drift-detected",
    ]);
    const actual = new Set<string>(Object.values(BRAIN_LOG_EVENT_KIND));
    expect(actual).toEqual(expected);
  });
});

describe("interface shape smoke (compile-time)", () => {
  test("BrainSignal literal satisfies the type", () => {
    const sig = {
      kind: "brain-signal",
      id: "sig-2026-05-14-no-internal-abbrev",
      created_at: "2026-05-14T10:15:00Z",
      tags: ["brain", "brain/signal", "brain/topic/no-internal-abbrev"],
      topic: "no-internal-abbrev",
      scope: "writing",
      signal: BRAIN_SIGNAL_SIGN.negative,
      agent: "claude",
      source: ["[[Daily/2026.05.14]]"],
      principle: "Do not use internal abbreviations",
    } as const satisfies BrainSignal;
    expect(sig.kind).toBe("brain-signal");
    expect(sig.signal).toBe("negative");
  });

  test("BrainPreference allows pinned=false default and confirmed state", () => {
    const unconfirmed = {
      kind: "brain-preference",
      id: "pref-no-internal-abbrev",
      created_at: "2026-05-14T10:42:00Z",
      confirmed_at: null,
      unconfirmed_until: "2026-05-28T10:42:00Z",
      tags: ["brain", "brain/preference"],
      topic: "no-internal-abbrev",
      status: BRAIN_PREFERENCE_STATUS.unconfirmed,
      principle: "Do not use internal abbreviations",
      evidenced_by: ["[[sig-2026-05-13-no-internal-abbrev]]"],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: null,
      confidence: BRAIN_CONFIDENCE.low,
      confidence_value: null,
      pinned: false,
    } as const satisfies BrainPreference;
    expect(unconfirmed.confirmed_at).toBeNull();
    expect(unconfirmed.pinned).toBe(false);
    expect(unconfirmed.status).toBe("unconfirmed");

    const confirmed = {
      ...unconfirmed,
      confirmed_at: "2026-05-15T09:00:00Z",
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      applied_count: 1,
      last_evidence_at: "2026-05-15T09:00:00Z",
      pinned: true,
    } as const satisfies BrainPreference;
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.pinned).toBe(true);
  });

  test("BrainRetired enforces status='retired' and a valid reason", () => {
    const retired = {
      kind: "brain-retired",
      id: "ret-no-internal-abbrev",
      status: "retired",
      retired_at: "2026-08-12T05:00:00Z",
      retired_reason: BRAIN_RETIRED_REASON.staleNoEvidence,
      retired_by: "[[Brain/log/2026-08-12]]",
      created_at: "2026-05-14T10:42:00Z",
      tags: ["brain", "brain/retired"],
      topic: "no-internal-abbrev",
      principle: "Do not use internal abbreviations",
      evidenced_by: ["[[sig-2026-05-14-no-internal-abbrev]]"],
      applied_count: 0,
      violated_count: 0,
      last_evidence_at: "2026-05-14T10:42:00Z",
      confidence: BRAIN_CONFIDENCE.low,
      confidence_value: null,
      pinned: false,
    } as const satisfies BrainRetired;
    expect(retired.status).toBe("retired");
    expect(retired.retired_reason).toBe("stale-no-evidence");
  });

  test("BrainApplyEvidenceLogEvent narrows on `kind`", () => {
    const ev = {
      kind: BRAIN_LOG_EVENT_KIND.applyEvidence,
      at: "2026-05-14T14:22:00Z",
      payload: { result: "applied" },
      preference: "pref-no-internal-abbrev",
      artifact: "[[Daily/2026.05.14#section-blog-post]]",
      agent: "claude",
      result: BRAIN_APPLY_RESULT.applied,
      note: "Expanded OSB on first use",
    } as const satisfies BrainApplyEvidenceLogEvent;
    expect(ev.kind).toBe("apply-evidence");
    expect(ev.result).toBe("applied");
  });

  test("BrainConfig with defaults compiles", () => {
    const cfg = {
      schema_version: 1,
      primary_agent: null,
      dream: {
        candidate_threshold: 3,
        unconfirmed_window_days: 14,
        contradiction_window_days: 14,
      },
      retire: { stale_evidence_days: 90 },
      confidence: {
        low_max_applied: 2,
        medium_min: 0.40,
        high_min: 0.75,
      },
      snapshots: { retention_count: 10 },
    } as const satisfies BrainConfig;
    expect(cfg.schema_version).toBe(1);
    expect(cfg.primary_agent).toBeNull();
    expect(cfg.snapshots.retention_count).toBe(10);
  });
});

import { describe, expect, test } from "bun:test";

import {
  BRAIN_APPLY_RESULT,
  BRAIN_CONFIDENCE,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_LOG_EVENT_KIND_SET,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  BRAIN_SIGNAL_SIGN,
  BRAIN_SNAPSHOT_REASON,
  BRAIN_SNAPSHOT_REASONS,
  isBrainSnapshotReason,
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
      // Brain lifecycle suite (v0.21.0) reconcile-phase open questions
      "reconcile",
      // Runtime lifecycle hooks (v0.26.0)
      "session-lifecycle",
      // Agent Write Contract Suite (v0.41.0) terminal write-session audit
      "write-session",
      // A1 (t_657b365e) entity-label quality gate anchoring skip
      "entity-anchor-skip",
      // today-operator-surface (t_d7be2a0c) marker write-back audit
      "attribute-write",
      // A2 (t_375e98fd) durability gate transient-content skip
      "durability-skip",
      // A4 (t_f79b4fe0) write-time conflict advisory
      "write-conflict-advisory",
      // signals-that-survive unit 4 (t_75597bb9) unroutable-capture hint
      "capture-routing-hint",
      // A5 (t_66c12a67) fact signal retire lifecycle
      "signal-retire",
      // Belief lifecycle suite (t_7d5a3589) cross-type tombstone + supersede
      "tombstone",
      // Belief lifecycle suite (t_3ba9c404) atomic temporal fact-replacement
      "temporal-replace",
      // Belief lifecycle suite (t_d9365884) supersedes-chain decay acceleration
      "chain-decay",
      // Belief lifecycle suite (t_ac03214d) decision-record capture + outcome backfill
      "decision-record",
      "decision-outcome",
      // Belief lifecycle suite (t_6fe43fcc) decision rating update
      "decision-rating",
      // Belief lifecycle suite (t_3547314d) decision-change receipt append
      "decision-change-receipt",
      // Conversation chronology (t_347e8224) authored_at backfill
      "authored-at-backfill",
      // Belief lifecycle suite (t_0e3f2bee) tension object detect + transitions
      "tension",
      // Source pipeline integrity suite (t_a3d1adb0) inline citation promotion
      "source-citation",
      // Source pipeline integrity suite (t_bd6cc4cb) guarded doctor repair
      "doctor-repair",
      // provenance-at-the-boundary unit F (t_76b89833) vector-only backfill
      "vector-backfill",
      // provenance-at-the-boundary (t_ac1c4176) event-anchor-only backfill
      "event-anchor-backfill",
      // silence-is-not-an-answer U7 (t_9d2a5f11) recovery point created —
      // the counterpart `rollback` has had since it shipped
      "snapshot",
    ]);
    const actual = new Set<string>(Object.values(BRAIN_LOG_EVENT_KIND));
    expect(actual).toEqual(expected);
  });
});

/**
 * U7: the snapshot-reason vocabulary.
 *
 * The reason is persisted into a replicated manifest sidecar, so the trio
 * (frozen object, membership list, guard) is not decoration: the guard is
 * what stands between a peer's hand-edited sidecar and a listing that
 * claims a provenance this build does not understand.
 */
describe("BRAIN_SNAPSHOT_REASON", () => {
  test("the membership list covers every declared value", () => {
    expect([...BRAIN_SNAPSHOT_REASONS].toSorted()).toEqual(
      Object.values(BRAIN_SNAPSHOT_REASON).toSorted(),
    );
  });

  test("the five existing destructive call sites each have a member", () => {
    // Each of these is a run-id prefix that already exists on disk today
    // and that nothing parsed back. Pinning the strings keeps a rename
    // from silently orphaning the archives already in `.snapshots/`.
    expect(BRAIN_SNAPSHOT_REASON.dream).toBe("dream");
    expect(BRAIN_SNAPSHOT_REASON.upgrade).toBe("upgrade");
    expect(BRAIN_SNAPSHOT_REASON.importClaudeMemory).toBe("import-claude-memory");
    expect(BRAIN_SNAPSHOT_REASON.deleteBySource).toBe("delete-by-source");
    expect(BRAIN_SNAPSHOT_REASON.entityPrune).toBe("entity-prune");
  });

  test("the three deferred boundary reasons and the manual one are readable", () => {
    // Nothing WRITES these yet (taking snapshots at those boundaries is
    // deferred), and the manifest must still be able to read a reason a
    // later release writes into a sidecar this build then replicates.
    expect(BRAIN_SNAPSHOT_REASON.sessionBoundary).toBe("session-boundary");
    expect(BRAIN_SNAPSHOT_REASON.planBoundary).toBe("plan-boundary");
    expect(BRAIN_SNAPSHOT_REASON.decisionBoundary).toBe("decision-boundary");
    expect(BRAIN_SNAPSHOT_REASON.manual).toBe("manual");
  });

  test("the guard accepts every member and rejects a non-member", () => {
    for (const reason of BRAIN_SNAPSHOT_REASONS) {
      expect(`${reason}: ${isBrainSnapshotReason(reason)}`).toBe(`${reason}: true`);
    }
    for (const outsider of ["", " ", "Dream", "dream ", "rollback", null, undefined, 7, {}]) {
      expect(`${JSON.stringify(outsider)}: ${isBrainSnapshotReason(outsider)}`).toBe(
        `${JSON.stringify(outsider)}: false`,
      );
    }
  });

  test("the snapshot log kind sits in the shared kind set beside rollback", () => {
    // `appendLogEvent` and the JSONL reader both validate against the set,
    // so a kind missing from it is a kind no writer can emit.
    expect(BRAIN_LOG_EVENT_KIND.snapshot).toBe("snapshot");
    expect(BRAIN_LOG_EVENT_KIND_SET.has(BRAIN_LOG_EVENT_KIND.snapshot)).toBe(true);
    expect(BRAIN_LOG_EVENT_KIND_SET.has(BRAIN_LOG_EVENT_KIND.rollback)).toBe(true);
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
        medium_min: 0.4,
        high_min: 0.75,
      },
      snapshots: {
        retention_count: 10,
        include_derived_store: false,
        derived_store_max_bytes: 268_435_456,
      },
    } as const satisfies BrainConfig;
    expect(cfg.schema_version).toBe(1);
    expect(cfg.primary_agent).toBeNull();
    expect(cfg.snapshots.retention_count).toBe(10);
  });
});

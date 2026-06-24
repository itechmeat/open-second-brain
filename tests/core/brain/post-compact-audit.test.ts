import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listContinuityRecords } from "../../../src/core/brain/continuity/store.ts";
import {
  auditPostCompaction,
  deriveProbes,
  detectCompaction,
  REASSERT_HEADER,
} from "../../../src/core/brain/post-compact-audit.ts";
import { readPinnedContext, writePinnedContext } from "../../../src/core/brain/pinned.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-post-compact-audit-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

// A conversation where the "deployment freeze" anchor was demoted into the
// compaction summary, while the "telemetry opt-in" anchor is still alive in
// the active region.
function driftedConversation() {
  return [
    {
      role: "system",
      content:
        "[CONTEXT SUMMARY]: Earlier the operator imposed a deployment freeze " +
        "window over the holidays and we discussed staffing.",
    },
    { role: "user", content: "Remember telemetry stays opt-in for every preset." },
    { role: "assistant", content: "Understood — telemetry remains opt-in across presets." },
  ];
}

describe("detectCompaction", () => {
  test("splits the summary block from the active region", () => {
    const split = detectCompaction(driftedConversation());
    expect(split).not.toBeNull();
    expect(split!.summaryBody).toContain("deployment freeze");
    expect(split!.activeRegion).toContain("telemetry");
    expect(split!.activeRegion).not.toContain("deployment freeze");
  });

  test("returns null with no compaction marker", () => {
    expect(detectCompaction([{ content: "just a normal turn" }])).toBeNull();
    expect(detectCompaction([])).toBeNull();
  });

  test("matches the Unicode and ASCII fallback markers", () => {
    expect(detectCompaction([{ content: "⟦CONTEXT-SUMMARY⟧ folded" }])).not.toBeNull();
    expect(detectCompaction([{ content: "[[CONTEXT-SUMMARY]] folded" }])).not.toBeNull();
  });
});

describe("deriveProbes", () => {
  test("derives locale-agnostic length-based probes, no stopword list", () => {
    expect(deriveProbes("Keep telemetry opt-in for presets")).toContain("telemetry");
    expect(deriveProbes("Keep telemetry opt-in for presets")).toContain("presets");
    // Non-English text still yields probes (no English-only filtering).
    expect(deriveProbes("conserver la télémétrie activée").length).toBeGreaterThan(0);
  });
});

describe("auditPostCompaction", () => {
  test("re-asserts the drifted anchor and leaves the survivor untouched", () => {
    writePinnedContext(
      vault,
      ["- Maintain the deployment freeze window.", "- Keep telemetry opt-in for presets."].join(
        "\n",
      ),
    );

    const result = auditPostCompaction(vault, {
      sessionId: "session-a",
      messages: driftedConversation(),
      createdAt: "2026-06-24T12:00:00.000Z",
    });

    expect(result.compactionDetected).toBe(true);
    expect(result.alreadyAudited).toBe(false);
    expect(result.drifted).toHaveLength(1);
    expect(result.drifted[0]).toContain("deployment freeze");
    expect(result.survived).toBe(1);
    expect(result.reasserted).toBe(true);
    expect(result.reminderBlock).toContain("deployment freeze");
    // The survivor is NOT in the reminder block — survivors cost zero tokens.
    expect(result.reminderBlock).not.toContain("telemetry");

    const pinned = readPinnedContext(vault).content;
    expect(pinned).toContain(REASSERT_HEADER);
    expect(pinned).toContain("Maintain the deployment freeze window.");
  });

  test("records a post_compact_audit continuity record idempotently per summary", () => {
    writePinnedContext(vault, "- Maintain the deployment freeze window.");
    const input = {
      sessionId: "session-b",
      messages: driftedConversation(),
      createdAt: "2026-06-24T12:00:00.000Z",
    };

    const first = auditPostCompaction(vault, input);
    expect(first.record).not.toBeNull();
    expect(first.alreadyAudited).toBe(false);

    const second = auditPostCompaction(vault, input);
    expect(second.alreadyAudited).toBe(true);
    expect(second.reasserted).toBe(false);
    expect(second.record).toBeNull();

    expect(listContinuityRecords(vault, { kind: "post_compact_audit" })).toHaveLength(1);
  });

  test("does not re-assert when reassert is false (dry run)", () => {
    writePinnedContext(vault, "- Maintain the deployment freeze window.");
    const result = auditPostCompaction(vault, {
      sessionId: "session-dry",
      messages: driftedConversation(),
      reassert: false,
      createdAt: "2026-06-24T12:00:00.000Z",
    });
    expect(result.drifted).toHaveLength(1);
    expect(result.reminderBlock).not.toBeNull();
    expect(result.reasserted).toBe(false);
    expect(readPinnedContext(vault).content).not.toContain(REASSERT_HEADER);
  });

  test("no compaction marker is a zero-cost no-op", () => {
    writePinnedContext(vault, "- Maintain the deployment freeze window.");
    const result = auditPostCompaction(vault, {
      sessionId: "session-none",
      messages: [{ content: "no summary here" }],
    });
    expect(result.compactionDetected).toBe(false);
    expect(result.reasserted).toBe(false);
    expect(result.record).toBeNull();
    expect(listContinuityRecords(vault, { kind: "post_compact_audit" })).toHaveLength(0);
  });

  test("fail-open on a malformed conversation, still bounded", () => {
    const result = auditPostCompaction(vault, {
      sessionId: "session-bad",
      messages: undefined as unknown as never,
    });
    expect(result.compactionDetected).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
  });

  test("audits static anchors alongside dynamic pins", () => {
    // No pinned content; the drifted anchor is supplied as a static
    // (config-reseeded) anchor.
    const result = auditPostCompaction(vault, {
      sessionId: "session-static",
      staticAnchors: ["Maintain the deployment freeze window."],
      messages: driftedConversation(),
      createdAt: "2026-06-24T12:00:00.000Z",
    });
    expect(result.drifted).toHaveLength(1);
    expect(result.anchors[0]!.source).toBe("static");
  });
});

import { describe, expect, test } from "bun:test";

import { createWindowContext } from "../../../src/core/brain/dream-replay/window.ts";
import type { ScanResult } from "../../../src/core/brain/dream-plan.ts";

const scan: ScanResult = { signals: [], preferences: [], retired: [], corrupted: [] };
const signalScan: ScanResult = {
  ...scan,
  signals: [
    {
      path: "/tmp/signal.md",
      active: true,
      signal: {
        kind: "brain-signal",
        id: "sig-2026-06-01-rule",
        created_at: "2026-06-01T09:00:00Z",
        tags: [],
        topic: "rule",
        signal: "positive",
        agent: "claude",
        principle: "Prefer specific examples.",
      },
    },
  ],
};

describe("dream window context", () => {
  test("evidence cannot be read before the evidence stage sets it", () => {
    const context = createWindowContext<{ readonly events: readonly string[] }>(
      new Date("2026-06-01T12:00:00Z"),
      scan,
    );

    expect(() => context.evidence).toThrow("dream window evidence has not been set");
    context.setEvidence({ events: [] });
    expect(context.evidence).toEqual({ events: [] });
    expect(() => context.setEvidence({ events: [] })).toThrow(
      "dream window evidence has already been set",
    );
  });

  test("the window records each signal event time", () => {
    const context = createWindowContext(new Date("2026-06-01T12:00:00Z"), signalScan);

    expect(context.signals.signals[0]?.effectiveTime).toBe("2026-06-01T09:00:00Z");
    expect(context.day).toBe("2026-06-01");
    expect(context.final).toBe(true);
  });
});

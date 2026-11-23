import { describe, expect, test } from "bun:test";

import { renderDigestBrief } from "../../../src/core/brain/digest-brief.ts";
import type { BrainLogEntry } from "../../../src/core/brain/log.ts";

function entry(body: BrainLogEntry["body"]): BrainLogEntry {
  return {
    timestamp: "2026-11-22T10:00:00Z",
    eventType: "dream",
    body,
  };
}

describe("dream digest brief", () => {
  test("names changed rules, counts them, and points to the full command", () => {
    const result = renderDigestBrief(
      entry({
        run_id: "dream-2026-11-22-100000",
        new_unconfirmed: ["pref-1: Prefer stable keys", "pref-2: Keep changes small"],
        confirmed: ["pref-3: Read before editing"],
        retired: ["ret-4: Old rule (outdated)"],
      }),
    );
    expect(result?.key).toBe("dream-2026-11-22-100000");
    expect(result?.text).toContain("New 2, confirmed 1, retired 1");
    expect(result?.text).toContain("Prefer stable keys");
    expect(result?.text).toContain("Keep changes small");
    expect(result?.text).toContain("Read before editing");
    expect(result?.text).toContain("o2b brain digest");
    expect(result?.text.length).toBeLessThanOrEqual(600);
  });

  test("bounds rule lines and ignores malformed or unchanged audit events", () => {
    expect(renderDigestBrief(entry({ run_id: "run-1" }))).toBeNull();
    expect(renderDigestBrief(entry({ run_id: "", new_unconfirmed: ["x"] }))).toBeNull();
    const result = renderDigestBrief(
      entry({ run_id: "run-2", new_unconfirmed: Array.from({ length: 9 }, (_, i) => `Rule ${i}`) }),
    );
    expect(result?.text.match(/\n- /gu)?.length).toBeLessThanOrEqual(5);
    expect(result?.text).not.toContain("Rule 5");
  });
});

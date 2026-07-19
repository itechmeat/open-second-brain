import { describe, expect, test } from "bun:test";

import {
  ACTIVITY_MARKER,
  activityMarker,
  renderActivityLine,
  renderActivityTimeline,
  type ActivityItem,
} from "../../../../src/core/brain/render/activity-line.ts";

const NOW = new Date("2026-05-29T12:00:00Z");

describe("activityMarker", () => {
  test("maps each kind to its fixed structural marker", () => {
    expect(activityMarker("preference")).toBe(ACTIVITY_MARKER.preference);
    expect(activityMarker("openQuestion")).toBe(ACTIVITY_MARKER.openQuestion);
    expect(activityMarker("note")).toBe(ACTIVITY_MARKER.note);
  });
});

describe("renderActivityLine", () => {
  test("renders a typed, age-labeled bullet", () => {
    const line = renderActivityLine(
      { kind: "preference", text: "Principle fresh", timestamp: "2026-05-01T00:00:00Z" },
      NOW,
    );
    expect(line).toBe("- [pref] Principle fresh · 4w ago");
  });

  test("omits the age when the timestamp is empty or unparseable", () => {
    expect(renderActivityLine({ kind: "note", text: "n", timestamp: "" }, NOW)).toBe("- [note] n");
    expect(renderActivityLine({ kind: "note", text: "n", timestamp: "not-a-date" }, NOW)).toBe(
      "- [note] n",
    );
  });
});

describe("renderActivityTimeline", () => {
  const items: ReadonlyArray<ActivityItem> = [
    { kind: "preference", text: "Principle fresh", timestamp: "2026-05-01T00:00:00Z" },
    { kind: "openQuestion", text: "commit-style (claims)", timestamp: "2026-05-28T09:00:00Z" },
    { kind: "note", text: "Finished timeline review", timestamp: "2026-05-29T10:00:00Z" },
  ];

  test("orders items most-recent-first with per-item markers and ages", () => {
    const out = renderActivityTimeline(items, NOW);
    expect(out).toBe(
      [
        "- [note] Finished timeline review · 2h ago",
        "- [open] commit-style (claims) · 1d ago",
        "- [pref] Principle fresh · 4w ago",
      ].join("\n"),
    );
  });

  test("returns an empty string for no items", () => {
    expect(renderActivityTimeline([], NOW)).toBe("");
  });

  test("is deterministic and sorts undated items last", () => {
    const withUndated: ReadonlyArray<ActivityItem> = [
      { kind: "note", text: "dated", timestamp: "2026-05-29T10:00:00Z" },
      { kind: "note", text: "undated", timestamp: "" },
    ];
    const out = renderActivityTimeline(withUndated, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toContain("dated");
    expect(lines[1]).toContain("undated");
    // Stable across repeated calls.
    expect(renderActivityTimeline(withUndated, NOW)).toBe(out);
  });
});

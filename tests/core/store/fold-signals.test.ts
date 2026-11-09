/**
 * The signal fold (design D14 item 5): each signal's lifecycle state and
 * frontmatter from its `signal` and `signal-state` records, in any
 * delivery order, and the `signal-state` kind documented in FORMAT.md.
 */
import { describe, expect, test } from "bun:test";

import {
  foldSignals,
  SIGNAL_REMOVED_KIND,
  SIGNAL_STATE_KIND,
  SIGNAL_STATE_VALUES,
} from "../../../src/core/store/fold-signals.ts";
import { shippedFormatDoc } from "../../../src/core/store/format-doc.ts";
import { authored, rec } from "./fixtures/fold-records.ts";

const T = Date.UTC(2026, 10, 6, 12, 0, 0);

const capture = (id: string, physical: number, staged = false) =>
  rec({
    physical,
    kind: "signal",
    body: {
      id,
      path: `Brain/inbox/${id}.md`,
      staged,
      frontmatter: { id, topic: "t", principle: "p", created_at: "2026-11-06T12:00:00Z" },
      raw: null,
    },
  });

const state = (
  id: string,
  physical: number,
  body: Record<string, unknown>,
  authority: "human" | "agent" = "agent",
  device = "dev-a",
) =>
  rec({
    device,
    physical,
    kind: SIGNAL_STATE_KIND,
    body: authored(authority, { signal: id, ...body }),
  });

describe("foldSignals", () => {
  test("a captured signal is active, a staged capture is staged", () => {
    const fold = foldSignals([capture("sig-a", T), capture("sig-b", T, true)]);
    expect(fold.signals.get("sig-a")?.state).toBe("active");
    expect(fold.signals.get("sig-b")?.state).toBe("staged");
  });

  test("consumed and archived signals are told apart from the inbox", () => {
    const fold = foldSignals([
      capture("sig-a", T),
      capture("sig-b", T),
      capture("sig-c", T),
      state("sig-a", T + 1, { state: "consumed" }),
      state("sig-b", T + 1, { state: "archived" }),
    ]);
    expect([...fold.signals.values()].map((s) => [s.id, s.state]).toSorted()).toEqual([
      ["sig-a", "consumed"],
      ["sig-b", "archived"],
      ["sig-c", "active"],
    ]);
  });

  test("the later move wins whoever made it, in any delivery order", () => {
    const records = [
      capture("sig-a", T, true),
      state("sig-a", T + 1, { state: "approved" }, "human"),
      state("sig-a", T + 2, { state: "consumed" }, "agent", "dev-b"),
    ];
    for (const order of [records, records.toReversed()]) {
      expect(foldSignals(order).signals.get("sig-a")?.state).toBe("consumed");
    }
  });

  test("approved makes a staged signal active, rejected takes it out", () => {
    const approved = foldSignals([
      capture("sig-a", T, true),
      state("sig-a", T + 1, { state: "approved" }),
    ]);
    expect(approved.signals.get("sig-a")?.state).toBe("active");
    const rejected = foldSignals([
      capture("sig-a", T, true),
      state("sig-a", T + 1, { state: "rejected" }),
    ]);
    expect(rejected.signals.get("sig-a")?.state).toBe("rejected");
  });

  test("field changes apply over the captured frontmatter; null removes a field", () => {
    const fold = foldSignals([
      capture("sig-a", T),
      state("sig-a", T + 1, { fields: { expiration_date: "2026-12-01" } }),
      state("sig-a", T + 2, { fields: { authored_at: "2026-11-05T09:00:00Z", topic: null } }),
    ]);
    const entry = fold.signals.get("sig-a")!;
    expect(entry.state).toBe("active");
    expect(entry.frontmatter["expiration_date"]).toBe("2026-12-01");
    expect(entry.frontmatter["authored_at"]).toBe("2026-11-05T09:00:00Z");
    expect("topic" in entry.frontmatter).toBe(false);
    expect(entry.history).toHaveLength(3);
  });

  test("malformed state records are not applied and are reported", () => {
    const fold = foldSignals([
      capture("sig-a", T),
      rec({
        physical: T + 1,
        kind: SIGNAL_STATE_KIND,
        body: { signal: "sig-a", state: "consumed" },
      }),
      state("sig-a", T + 2, { state: "vanished" }),
      state("sig-a", T + 3, {}),
    ]);
    expect(fold.signals.get("sig-a")?.state).toBe("active");
    expect(fold.rejected.map((r) => r.reason)).toEqual([
      "missing or invalid authority",
      expect.stringContaining("state must be one of"),
      "a state or fields is required",
    ]);
  });

  test("a state record whose capture has not arrived is kept as an orphan", () => {
    const fold = foldSignals([state("sig-z", T, { state: "consumed" })]);
    expect(fold.signals.size).toBe(0);
    expect(fold.orphans).toHaveLength(1);
  });

  test("signal-removed forgets the signal and its content; the voided lines are named", () => {
    const removed = (id: string, physical: number) =>
      rec({ physical, kind: SIGNAL_REMOVED_KIND, body: authored("human", { signal: id }) });
    const a = capture("sig-a", T);
    const move = state("sig-a", T + 1, { fields: { note: "kept?" } });
    const tomb = removed("sig-a", T + 2);
    const late = state("sig-a", T + 3, { state: "consumed" });
    const fold = foldSignals([late, tomb, move, a, capture("sig-b", T)]);
    expect(fold.signals.has("sig-a")).toBe(false);
    expect([...fold.signals.keys()]).toEqual(["sig-b"]);
    // The capture, the field move and the move after the tombstone are void.
    expect(fold.removed.get("sig-a")).toBe(3);
    expect([...fold.voided].toSorted()).toEqual([a.id, move.id, late.id].toSorted());
    expect(fold.orphans).toEqual([]);
    // A capture after the tombstone is a new signal, without the old fields.
    const again = rec({
      physical: T + 4,
      kind: "signal",
      body: {
        id: "sig-a",
        path: "Brain/inbox/sig-a.md",
        staged: false,
        frontmatter: { id: "sig-a" },
        raw: null,
      },
    });
    const revived = foldSignals([a, move, tomb, again]).signals.get("sig-a")!;
    expect(revived.frontmatter).toEqual({ id: "sig-a" });
    expect(revived.history.map((r) => r.id)).toEqual([again.id]);
    // A move between the tombstone and the re-capture belongs to the
    // forgotten signal: the new one starts active, and the move is void.
    const between = rec({
      physical: T + 3,
      kind: SIGNAL_STATE_KIND,
      body: authored("agent", { signal: "sig-a", state: "consumed", fields: { old: "x" } }),
    });
    const both = foldSignals([a, tomb, between, again]);
    const fresh = both.signals.get("sig-a")!;
    expect(fresh.state).toBe("active");
    expect(fresh.frontmatter).toEqual({ id: "sig-a" });
    expect(both.voided.has(between.id)).toBe(true);
  });

  test("a signal-removed without authority or signal is rejected", () => {
    const bad = rec({ physical: T, kind: SIGNAL_REMOVED_KIND, body: { signal: "sig-a" } });
    expect(foldSignals([capture("sig-a", T - 1), bad]).rejected.map((r) => r.id)).toEqual([bad.id]);
  });
});

describe("FORMAT.md", () => {
  const doc = shippedFormatDoc();

  test("documents the signal-state kind and every state", () => {
    expect(doc).toMatch(new RegExp(`^- \`${SIGNAL_STATE_KIND}\`:`, "m"));
    for (const value of SIGNAL_STATE_VALUES) expect(doc).toContain(`\`${value}\``);
  });

  test("documents the signal-removed kind", () => {
    expect(doc).toMatch(new RegExp(`^- \`${SIGNAL_REMOVED_KIND}\`:`, "m"));
  });
});

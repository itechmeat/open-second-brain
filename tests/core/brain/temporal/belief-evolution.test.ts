/**
 * Task 4: `buildBeliefEvolution(index, vault, target)`.
 *
 * Walks dream summary events for the target preference id appearing in
 * `new_unconfirmed` / `confirmed` / `retired` arrays, plus
 * apply-evidence events for the same id, plus retired/ files in the
 * chain. Returns the frozen envelope.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTimelineIndex } from "../../../../src/core/brain/temporal/build-index.ts";
import { buildBeliefEvolution } from "../../../../src/core/brain/temporal/belief-evolution.ts";

function makeVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "o2b-temporal-belief-"));
  mkdirSync(join(dir, "Brain", "log"), { recursive: true });
  mkdirSync(join(dir, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(dir, "Brain", "retired"), { recursive: true });
  return dir;
}

interface FixtureEvent {
  readonly timestamp: string;
  readonly kind: string;
  readonly body: Record<string, string | ReadonlyArray<string>>;
}

function writeJsonl(
  vault: string,
  date: string,
  events: ReadonlyArray<FixtureEvent>,
): void {
  const lines = events
    .map((e) =>
      JSON.stringify({ ts: e.timestamp, kind: e.kind, payload: e.body }),
    )
    .join("\n");
  writeFileSync(join(vault, "Brain", "log", `${date}.jsonl`), lines + "\n");
}

let VAULT: string;
beforeEach(() => {
  VAULT = makeVault();
});

describe("buildBeliefEvolution by prefId", () => {
  test("empty index - empty envelope, no throw", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { prefId: "pref-foo" });
    expect(evo.target).toEqual({ prefId: "pref-foo" });
    expect(evo.transitions.length).toBe(0);
    expect(evo.evidence.length).toBe(0);
    expect(evo.retirements.length).toBe(0);
    expect(Object.isFrozen(evo)).toBe(true);
  });

  test("creation - promotion - retirement transitions in order", () => {
    writeJsonl(VAULT, "2026-05-01", [
      {
        timestamp: "2026-05-01T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r1",
          new_unconfirmed: ["[[pref-foo|First rule]]"],
        },
      },
    ]);
    writeJsonl(VAULT, "2026-05-10", [
      {
        timestamp: "2026-05-10T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r2",
          confirmed: ["[[pref-foo|First rule]]"],
        },
      },
    ]);
    writeJsonl(VAULT, "2026-05-20", [
      {
        timestamp: "2026-05-20T08:00:00Z",
        kind: "dream",
        body: {
          run_id: "r3",
          retired: ["[[ret-foo|First rule]] (stale-no-evidence)"],
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { prefId: "pref-foo" });
    expect(evo.transitions.map((t) => t.kind)).toEqual([
      "creation",
      "promotion",
      "retirement",
    ]);
    expect(evo.transitions[0]!.at).toBe("2026-05-01T08:00:00Z");
    expect(evo.transitions[2]!.at).toBe("2026-05-20T08:00:00Z");
  });

  test("evidence rollup carries running counts", () => {
    writeJsonl(VAULT, "2026-05-12", [
      {
        timestamp: "2026-05-12T08:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First rule]]",
          artifact: "[[a.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
      {
        timestamp: "2026-05-12T10:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First rule]]",
          artifact: "[[b.ts]]",
          agent: "claude",
          result: "violated",
        },
      },
      {
        timestamp: "2026-05-12T12:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First rule]]",
          artifact: "[[c.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
    ]);
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { prefId: "pref-foo" });
    expect(evo.evidence.length).toBe(3);
    expect(evo.evidence[0]!.runningApplied).toBe(1);
    expect(evo.evidence[0]!.runningViolated).toBe(0);
    expect(evo.evidence[1]!.runningApplied).toBe(1);
    expect(evo.evidence[1]!.runningViolated).toBe(1);
    expect(evo.evidence[2]!.runningApplied).toBe(2);
  });

  test("retirements pick up ret-* file metadata with supersededBy chain", () => {
    writeFileSync(
      join(VAULT, "Brain", "retired", "ret-foo.md"),
      `---\nid: ret-foo\nkind: brain-retired\nstatus: retired\nretired_at: 2026-05-20T08:00:00Z\nretired_reason: superseded\nretired_by: "[[dream-r3]]"\ncreated_at: 2026-04-01T00:00:00Z\ntags: ["brain"]\ntopic: foo\nprinciple: First rule\nevidenced_by: []\nconfidence: medium\nsuperseded_by: "[[pref-foo-v2|First rule v2]]"\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { prefId: "pref-foo" });
    // ret-foo descends from pref-foo and is the retirement target.
    expect(evo.retirements.length).toBe(1);
    expect(evo.retirements[0]!.prefId).toBe("ret-foo");
    expect(evo.retirements[0]!.retiredAt).toBe("2026-05-20T08:00:00Z");
    expect(evo.retirements[0]!.supersededBy).toBe("pref-foo-v2");
  });

  test("envelope is frozen, transitions/evidence arrays frozen", () => {
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { prefId: "pref-foo" });
    expect(Object.isFrozen(evo)).toBe(true);
    expect(Object.isFrozen(evo.transitions)).toBe(true);
    expect(Object.isFrozen(evo.evidence)).toBe(true);
    expect(Object.isFrozen(evo.retirements)).toBe(true);
  });
});

describe("buildBeliefEvolution by topic", () => {
  test("aggregates events for every pref-* / ret-* sharing the topic", () => {
    writeJsonl(VAULT, "2026-05-05", [
      {
        timestamp: "2026-05-05T08:00:00Z",
        kind: "feedback",
        body: {
          signal: "[[sig-2026-05-05-foo]]",
          topic: "foo",
          sign: "positive",
          agent: "claude",
        },
      },
    ]);
    writeJsonl(VAULT, "2026-05-12", [
      {
        timestamp: "2026-05-12T08:00:00Z",
        kind: "apply-evidence",
        body: {
          preference: "[[pref-foo|First rule]]",
          artifact: "[[a.ts]]",
          agent: "claude",
          result: "applied",
        },
      },
    ]);
    writeFileSync(
      join(VAULT, "Brain", "preferences", "pref-foo.md"),
      `---\nid: pref-foo\nkind: brain-preference\nstatus: confirmed\ncreated_at: 2026-05-01T00:00:00Z\nunconfirmed_until: 2026-05-15T00:00:00Z\ntags: ["brain"]\ntopic: foo\nprinciple: First rule\nevidenced_by: []\nconfidence: medium\n---\n`,
    );
    const idx = buildTimelineIndex(VAULT, {});
    const evo = buildBeliefEvolution(idx, VAULT, { topic: "foo" });
    expect(evo.target).toEqual({ topic: "foo" });
    // Evidence is per pref-foo and we count it under the topic too.
    expect(evo.evidence.length).toBe(1);
  });
});

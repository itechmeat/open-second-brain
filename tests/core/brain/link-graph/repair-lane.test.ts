/**
 * Deterministic memory-graph repair lane (G1, t_6832aac6).
 *
 * Candidate edges order by identity strength; a confidence threshold and a
 * hard per-run write cap are named constants; dry-run is the default and
 * writes nothing; apply requires exact confirmation; inferred candidates are
 * opt-in; and an idempotent forward scan makes reruns after apply converge to
 * zero writes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  IDENTITY_STRENGTH,
  REPAIR_CONFIDENCE_THRESHOLD,
  REPAIR_CONFIRM_PHRASE,
  REPAIR_WRITE_CAP,
  RepairConfirmationError,
  runRepairLane,
  type RepairCandidate,
} from "../../../../src/core/brain/link-graph/repair-lane.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-repair-"));
  mkdirSync(join(vault, "Notes"), { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeNote(rel: string, title: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    ["---", "kind: brain-note", `title: ${title}`, "---", "", body, ""].join("\n"),
    "utf8",
  );
}

function noteBody(rel: string): string {
  return readFileSync(join(vault, rel), "utf8");
}

function candidate(overrides: Partial<RepairCandidate>): RepairCandidate {
  return {
    source: "Notes/a.md",
    target: "Notes/b.md",
    strength: IDENTITY_STRENGTH.explicitReference,
    confidence: 0.9,
    reason: "test",
    ...overrides,
  };
}

describe("runRepairLane ordering and gating", () => {
  test("candidates are ordered by identity strength, strongest first", () => {
    writeNote("Notes/a.md", "A", "body");
    const candidates: RepairCandidate[] = [
      candidate({ target: "Notes/inf.md", strength: IDENTITY_STRENGTH.inferred }),
      candidate({ target: "Notes/topic.md", strength: IDENTITY_STRENGTH.sameTopicEvidence }),
      candidate({ target: "Notes/cont.md", strength: IDENTITY_STRENGTH.sessionContinuity }),
      candidate({ target: "Notes/exp.md", strength: IDENTITY_STRENGTH.explicitReference }),
    ];
    const report = runRepairLane(vault, candidates, { includeInferred: true });
    const order = report.decisions.map((d) => d.strength);
    expect(order).toEqual([
      IDENTITY_STRENGTH.explicitReference,
      IDENTITY_STRENGTH.sessionContinuity,
      IDENTITY_STRENGTH.sameTopicEvidence,
      IDENTITY_STRENGTH.inferred,
    ]);
  });

  test("a candidate below the confidence threshold is skipped with a reason", () => {
    writeNote("Notes/a.md", "A", "body");
    const report = runRepairLane(
      vault,
      [candidate({ confidence: REPAIR_CONFIDENCE_THRESHOLD - 0.01 })],
      {},
    );
    expect(report.decisions[0]!.action).toBe("skip-threshold");
    expect(report.written).toBe(0);
  });

  test("inferred candidates are skipped unless opted in", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const inferred = candidate({ strength: IDENTITY_STRENGTH.inferred });
    const off = runRepairLane(vault, [inferred], {});
    expect(off.decisions[0]!.action).toBe("skip-inferred");
    const on = runRepairLane(vault, [inferred], { includeInferred: true });
    expect(on.decisions[0]!.action).toBe("write");
  });

  test("the per-run write cap bounds the number of writes", () => {
    writeNote("Notes/a.md", "A", "body");
    const many: RepairCandidate[] = [];
    for (let i = 0; i < REPAIR_WRITE_CAP + 5; i++) {
      writeNote(`Notes/t${i}.md`, `T${i}`, "body");
      many.push(candidate({ target: `Notes/t${i}.md` }));
    }
    const report = runRepairLane(vault, many, { apply: true, confirm: REPAIR_CONFIRM_PHRASE });
    expect(report.written).toBe(REPAIR_WRITE_CAP);
    expect(report.decisions.some((d) => d.action === "skip-cap")).toBe(true);
  });
});

describe("runRepairLane dry-run vs apply", () => {
  test("dry-run is the default and writes nothing to disk", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const before = noteBody("Notes/a.md");
    const report = runRepairLane(vault, [candidate({})], {});
    expect(report.mode).toBe("dry-run");
    expect(report.decisions[0]!.action).toBe("write");
    expect(noteBody("Notes/a.md")).toBe(before);
  });

  test("apply requires the exact confirmation phrase", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    expect(() => runRepairLane(vault, [candidate({})], { apply: true, confirm: "wrong" })).toThrow(
      RepairConfirmationError,
    );
    // Nothing was written on the refused apply.
    expect(noteBody("Notes/a.md")).not.toContain("[[");
  });

  test("apply writes the edge and a rerun converges to zero writes (idempotent)", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const first = runRepairLane(vault, [candidate({})], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
    });
    expect(first.mode).toBe("apply");
    expect(first.written).toBe(1);
    expect(noteBody("Notes/a.md")).toContain("Notes/b.md");

    const second = runRepairLane(vault, [candidate({})], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
    });
    expect(second.written).toBe(0);
    expect(second.decisions[0]!.action).toBe("skip-existing");
  });
});

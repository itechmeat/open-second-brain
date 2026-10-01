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
  type RepairDecision,
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
    // The full ladder in one table, so the tier order has exactly one owner:
    // area_membership (t_23bd347d) slots between same_topic_evidence and
    // inferred rather than carrying a second ordering test.
    const candidates: RepairCandidate[] = [
      candidate({ target: "Notes/inf.md", strength: IDENTITY_STRENGTH.inferred }),
      candidate({ target: "Notes/area.md", strength: IDENTITY_STRENGTH.areaMembership }),
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
      IDENTITY_STRENGTH.areaMembership,
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

describe("runRepairLane path and endpoint safety", () => {
  test("a candidate that escapes the vault yields a skip decision instead of throwing", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");

    const targetEscape = runRepairLane(vault, [candidate({ target: "../evil.md" })], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
    });
    expect(targetEscape.decisions[0]!.action).toBe("skip-unsafe-path");
    expect(targetEscape.written).toBe(0);

    const sourceEscape = runRepairLane(vault, [candidate({ source: "../evil.md" })], {
      apply: true,
      confirm: REPAIR_CONFIRM_PHRASE,
    });
    expect(sourceEscape.decisions[0]!.action).toBe("skip-unsafe-path");
    expect(sourceEscape.written).toBe(0);
  });

  test("a candidate whose endpoint has no canonical key is refused, never written twice", () => {
    writeNote("Notes/a.md", "A", "body");
    // A file named ".md" has no canonical endpoint key, so an edge to it cannot
    // be deduped or tracked for idempotence. Refuse it rather than re-append it
    // on every run.
    writeNote("Notes/.md", "Blank", "body");
    const cand = candidate({ target: "Notes/.md" });

    const first = runRepairLane(vault, [cand], { apply: true, confirm: REPAIR_CONFIRM_PHRASE });
    expect(first.decisions[0]!.action).toBe("skip-null-endpoint-key");
    expect(first.written).toBe(0);
    expect(noteBody("Notes/a.md")).not.toContain("[[");

    const second = runRepairLane(vault, [cand], { apply: true, confirm: REPAIR_CONFIRM_PHRASE });
    expect(second.decisions[0]!.action).toBe("skip-null-endpoint-key");
    expect(second.written).toBe(0);
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

describe("runRepairLane areaMembership tier (t_23bd347d)", () => {
  test("an area_membership candidate passes the confidence threshold at full confidence", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const report = runRepairLane(
      vault,
      [candidate({ strength: IDENTITY_STRENGTH.areaMembership, confidence: 1 })],
      {},
    );
    expect(report.decisions[0]!.action).toBe("write");
  });
});

/**
 * The ride-along contract for EVERY refusal action the upstream collectors
 * stage today, asserted table-driven over all of them: the inbox-drain hub
 * selection (t_23bd347d) stages skip-no-hub / skip-ambiguous-hub with an
 * empty target, the corpus collector stages skip-ambiguous - and the lane
 * owns ONE contract over the lot. Hub actions get no second, special-cased
 * test: they are rows in the same table, with their production fixture
 * shapes (area_membership strength, target "").
 */
describe("runRepairLane collected refusals", () => {
  const noHub: RepairDecision = {
    ...candidate({ source: "captured/x.md", target: "", reason: "no hub page in scope bucket" }),
    action: "skip-no-hub",
  };
  const ambiguousHub: RepairDecision = {
    ...candidate({
      source: "captured/y.md",
      target: "",
      reason: "2 hub pages in scope bucket (unscoped): a.md, b.md",
    }),
    action: "skip-ambiguous-hub",
  };
  const ambiguous: RepairDecision = {
    ...candidate({ source: "Notes/src.md", target: "Notes/x.md", reason: "ambiguous: Alpha" }),
    action: "skip-ambiguous",
  };
  const allRefusals: RepairDecision[] = [noHub, ambiguousHub, ambiguous];

  test("every refusal action rides verbatim, never re-decided, never counted as writes", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const report = runRepairLane(vault, [candidate({})], { collectedRefusals: allRefusals });
    // Refusals ride AHEAD of the lane's own decisions: the strongest refusal,
    // not the lane's same-strength write, opens the report.
    expect(report.decisions[0]).toEqual(ambiguous);
    for (const refusal of allRefusals) {
      expect(report.decisions).toContainEqual(refusal);
      expect(report.decisions.filter((d) => d.action === refusal.action)).toHaveLength(1);
    }
    expect(report.written).toBe(1);
  });

  test("no refusal action consumes the write cap", () => {
    writeNote("Notes/a.md", "A", "body");
    writeNote("Notes/b.md", "B", "body");
    const report = runRepairLane(vault, [candidate({})], {
      writeCap: 1,
      collectedRefusals: allRefusals,
    });
    // Refusals sort ahead of the candidate: had ANY action been charged to
    // the cap, the write would not have happened.
    expect(report.written).toBe(1);
  });

  test("refusals are ordered by the candidate order, deterministically", () => {
    const second: RepairDecision = {
      ...candidate({ source: "Notes/z.md", target: "Notes/x.md", reason: "ambiguous: Alpha" }),
      action: "skip-ambiguous",
    };
    const first: RepairDecision = {
      ...candidate({ source: "Notes/a.md", target: "Notes/x.md", reason: "ambiguous: Alpha" }),
      action: "skip-ambiguous",
    };
    const report = runRepairLane(vault, [], { collectedRefusals: [second, first] });
    expect(report.decisions.map((d) => d.source)).toEqual(["Notes/a.md", "Notes/z.md"]);
    expect(report.written).toBe(0);
  });
});

/**
 * The seeded take and the hash-order dev/counted split (cycle 20261020,
 * card t_4e1681b3, task C1).
 *
 * The split rule is the preregistration contract: `sha256Hex(seed + ":" + id)`
 * ranks the take ids, the first `ceil(0.3 n)` are dev, the rest counted.
 * The tests below re-derive the ranking from `sha256Hex` directly so a
 * broken implementation cannot pass by agreeing with itself.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import {
  hashOrderSplit,
  parseDecisionEvalFixture,
  loadDecisionEvalFixture,
  resolveEvalFixturePath,
  verifyEvalTake,
} from "../../../src/core/decision-model/eval/take.ts";
import {
  DECISION_EVAL_DEV_FRACTION,
  type DecisionEvalSpec,
} from "../../../src/core/decision-model/eval-spec.ts";

const IDS = ["rk-001", "rk-002", "rk-003", "rk-004", "rk-005", "rk-006", "rk-007", "rk-008"];

function expectedDevFirst(seed: string, ids: ReadonlyArray<string>): string[] {
  return ids
    .map((id) => ({ id, h: sha256Hex(`${seed}:${id}`) }))
    .toSorted((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : a.id.localeCompare(b.id)))
    .slice(0, Math.ceil(ids.length * DECISION_EVAL_DEV_FRACTION))
    .map((e) => e.id)
    .toSorted();
}

describe("hashOrderSplit", () => {
  test("is deterministic and follows the sha256Hex(seed:id) ranking", () => {
    const seed = "cycle-20261020";
    const a = hashOrderSplit(seed, IDS);
    const b = hashOrderSplit(seed, IDS);
    expect(a).toEqual(b);
    expect(a.dev).toEqual(expectedDevFirst(seed, IDS));
    expect(a.dev).toHaveLength(Math.ceil(IDS.length * 0.3));
    expect(a.counted).toHaveLength(IDS.length - Math.ceil(IDS.length * 0.3));
  });

  test("is stable under input reorder and returns lexicographically sorted lists", () => {
    const seed = "cycle-20261020";
    const forward = hashOrderSplit(seed, IDS);
    const reversed = hashOrderSplit(seed, [...IDS].reverse());
    expect(reversed.dev).toEqual(forward.dev);
    expect(reversed.counted).toEqual(forward.counted);
    for (const list of [forward.dev, forward.counted]) {
      expect([...list].toSorted()).toEqual([...list]);
    }
  });

  test("dev and counted are disjoint and their union is the take", () => {
    const split = hashOrderSplit("another-seed", IDS);
    const union = [...split.dev, ...split.counted].toSorted();
    expect(union).toEqual([...IDS].toSorted());
    expect(split.dev.filter((id) => split.counted.includes(id))).toEqual([]);
  });

  test("a different seed moves the boundary", () => {
    expect(hashOrderSplit("seed-a", IDS)).not.toEqual(hashOrderSplit("seed-b", IDS));
  });

  test("empty and single-id takes split sanely", () => {
    expect(hashOrderSplit("s", [])).toEqual({ dev: [], counted: [] });
    expect(hashOrderSplit("s", ["only"])).toEqual({ dev: ["only"], counted: [] });
  });
});

describe("parseDecisionEvalFixture", () => {
  const rerankFixture = {
    use: "rerank",
    items: [
      {
        id: "rk-001",
        query: "How do I look after the bonsai?",
        candidates: [
          {
            title: "Potting diary",
            text: "The bonsai fig drops leaves when moved.",
            relevant: true,
          },
          {
            title: "Cluster notes",
            text: "The kubernetes cluster autoscaler adds nodes.",
            relevant: false,
          },
        ],
      },
    ],
  };

  test("accepts a well-formed rerank fixture", () => {
    const fixture = parseDecisionEvalFixture(rerankFixture, "rerank");
    expect(fixture.items).toHaveLength(1);
    expect(fixture.items[0]!.kind).toBe("rerank");
  });

  test("rejects a fixture whose use does not match the spec's use", () => {
    expect(() => parseDecisionEvalFixture(rerankFixture, "recall_inject")).toThrow(/use/);
  });

  test("rejects duplicate item ids, empty candidates and gold-less items", () => {
    const dup = {
      use: "rerank",
      items: [rerankFixture.items[0], rerankFixture.items[0]],
    };
    expect(() => parseDecisionEvalFixture(dup, "rerank")).toThrow(/rk-001/);
    expect(() =>
      parseDecisionEvalFixture(
        { use: "rerank", items: [{ id: "rk-002", query: "q", candidates: [] }] },
        "rerank",
      ),
    ).toThrow(/rk-002/);
    expect(() =>
      parseDecisionEvalFixture(
        {
          use: "rerank",
          items: [
            {
              id: "rk-003",
              query: "q",
              candidates: [
                { title: "t", text: "x", relevant: false },
                { title: "u", text: "y", relevant: false },
              ],
            },
          ],
        },
        "rerank",
      ),
    ).toThrow(/rk-003/);
  });

  test("rejects non-boolean gold labels and blank text", () => {
    expect(() =>
      parseDecisionEvalFixture(
        {
          use: "rerank",
          items: [
            {
              id: "rk-004",
              query: "q",
              candidates: [
                { title: "t", text: "x", relevant: "yes" },
                { title: "u", text: "y", relevant: false },
              ],
            },
          ],
        },
        "rerank",
      ),
    ).toThrow(/rk-004/);
  });

  test("accepts a well-formed recall_inject fixture and rejects a gold-less one", () => {
    const good = {
      use: "recall_inject",
      items: [
        {
          id: "ri-001",
          prompt: "What should I know about the glacier?",
          notes: [
            { title: "Field survey", text: "The glacier terminus retreated.", useful: true },
            { title: "Baking log", text: "The sourdough starter doubles.", useful: false },
          ],
        },
      ],
    };
    expect(parseDecisionEvalFixture(good, "recall_inject").items).toHaveLength(1);
    expect(() =>
      parseDecisionEvalFixture(
        {
          use: "recall_inject",
          items: [
            {
              id: "ri-002",
              prompt: "p",
              notes: [
                { title: "a", text: "x", useful: false },
                { title: "b", text: "y", useful: false },
              ],
            },
          ],
        },
        "recall_inject",
      ),
    ).toThrow(/ri-002/);
  });
});

describe("committed take fixtures", () => {
  test("load from their repo-relative spec reference", () => {
    const loaded = loadDecisionEvalFixture(
      "tests/fixtures/decision-model/rerank-take.json",
      "rerank",
    );
    expect(loaded.fixture.items).toHaveLength(43);
    expect(loaded.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an absolute path loads as is; a wrong use is refused", () => {
    const abs = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "tests/fixtures/decision-model/rerank-take.json",
    );
    expect(loadDecisionEvalFixture(abs, "rerank").fixture.items).toHaveLength(43);
    expect(() =>
      loadDecisionEvalFixture("tests/fixtures/decision-model/rerank-take.json", "dedup"),
    ).toThrow(/use/);
  });

  test("resolution stays package-rooted: the take loads from a bare working directory", () => {
    // The installed package has no caller working directory to lean on:
    // the repo-relative reference must resolve against the package root,
    // wherever the process happens to run - there is no working-directory
    // fallback, so a bare reference resolves there or raises a named
    // read error, never content from cwd.
    const repoRoot = resolve(join(import.meta.dir, "..", "..", ".."));
    const previous = process.cwd();
    const bare = mkdtempSync(join(tmpdir(), "osb-dm-take-bare-"));
    process.chdir(bare);
    try {
      const ref = "tests/fixtures/decision-model/rerank-take.json";
      expect(resolveEvalFixturePath(ref).startsWith(repoRoot)).toBe(true);
      const loaded = loadDecisionEvalFixture(ref, "rerank");
      expect(loaded.fixture.items).toHaveLength(43);
    } finally {
      process.chdir(previous);
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test("a look-alike file in the working directory is never hashed", () => {
    // The installed-package failure mode: a cwd-relative fallback would
    // read whatever sits at ./tests/fixtures/... and hash it into a
    // preregistration claim. A repo-relative reference resolves against
    // the package root or nowhere; a look-alike only the working
    // directory holds is a named read error, never content.
    const repoRoot = resolve(join(import.meta.dir, "..", "..", ".."));
    const previous = process.cwd();
    const decoy = mkdtempSync(join(tmpdir(), "osb-dm-take-decoy-"));
    mkdirSync(join(decoy, "tests", "fixtures", "decision-model"), { recursive: true });
    const ref = "tests/fixtures/decision-model/lookalike-take.json";
    writeFileSync(join(decoy, ref), JSON.stringify({ use: "rerank", items: [] }), "utf8");
    process.chdir(decoy);
    try {
      const resolved = resolveEvalFixturePath(ref);
      expect(resolved.startsWith(decoy)).toBe(false);
      expect(resolved).toBe(join(repoRoot, ref));
      expect(() => loadDecisionEvalFixture(ref, "rerank")).toThrow(/cannot read/);
    } finally {
      process.chdir(previous);
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe("verifyEvalTake", () => {
  const spec: DecisionEvalSpec = {
    version: 1,
    use: "rerank",
    fixture: "tests/fixtures/decision-model/rerank-take.json",
    seed: "cycle-20261020",
    split: { rule: "hash-order-30-70", dev_fraction: 0.3 },
    receipt: { dev: ["rk-002"], counted: ["rk-001"] },
    fixture_hash: "0".repeat(64),
    metric: "counted_error_rate",
    ceiling: 0.05,
    min_counted: 1,
    thresholds: {},
  };

  test("a hand-built two-item spec verifies when the receipt matches the derivation", () => {
    const doc = {
      use: "rerank",
      items: [
        {
          id: "rk-001",
          query: "q1",
          candidates: [
            { title: "t", text: "bonsai drops leaves", relevant: false },
            { title: "u", text: "kubernetes autoscaler", relevant: true },
          ],
        },
        {
          id: "rk-002",
          query: "q2",
          candidates: [
            { title: "t", text: "kubernetes autoscaler", relevant: true },
            { title: "u", text: "bonsai drops leaves", relevant: false },
          ],
        },
      ],
    };
    const fixture = parseDecisionEvalFixture(doc, "rerank");
    const split = hashOrderSplit(spec.seed, ["rk-001", "rk-002"]);
    expect(split.dev).toHaveLength(1);
    verifyEvalTake({ ...spec, receipt: split }, fixture, spec.fixture_hash);
  });

  test("a receipt that does not match the derivation is a named preregistration error", () => {
    const doc = {
      use: "rerank",
      items: [
        {
          id: "rk-001",
          query: "q1",
          candidates: [
            { title: "t", text: "bonsai drops leaves", relevant: false },
            { title: "u", text: "kubernetes autoscaler", relevant: true },
          ],
        },
        {
          id: "rk-002",
          query: "q2",
          candidates: [
            { title: "t", text: "kubernetes autoscaler", relevant: true },
            { title: "u", text: "bonsai drops leaves", relevant: false },
          ],
        },
      ],
    };
    const fixture = parseDecisionEvalFixture(doc, "rerank");
    const derived = hashOrderSplit(spec.seed, ["rk-001", "rk-002"]);
    const inverted = { dev: derived.counted, counted: derived.dev };
    expect(() =>
      verifyEvalTake({ ...spec, receipt: inverted }, fixture, spec.fixture_hash),
    ).toThrow(/preregistration/);
  });

  test("a fixture content hash that differs from the spec is refused", () => {
    const doc = {
      use: "rerank",
      items: [
        {
          id: "rk-001",
          query: "q1",
          candidates: [
            { title: "t", text: "bonsai drops leaves", relevant: false },
            { title: "u", text: "kubernetes autoscaler", relevant: true },
          ],
        },
        {
          id: "rk-002",
          query: "q2",
          candidates: [
            { title: "t", text: "kubernetes autoscaler", relevant: true },
            { title: "u", text: "bonsai drops leaves", relevant: false },
          ],
        },
      ],
    };
    const fixture = parseDecisionEvalFixture(doc, "rerank");
    const split = hashOrderSplit(spec.seed, ["rk-001", "rk-002"]);
    expect(() => verifyEvalTake({ ...spec, receipt: split }, fixture, "9".repeat(64))).toThrow(
      /fixture/,
    );
  });
});

/**
 * Bench fixture loading and materialization (Memory Observability
 * Suite, t_882c396a). Fixtures are repo-local JSON; materialization
 * writes ONLY into the caller-supplied disposable directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fixtureHash,
  loadBenchFixture,
  materializeBenchVault,
  parseBenchFixture,
} from "../../../src/core/bench/fixture.ts";
import { loadNormalizedContinuityRecords } from "../../../src/core/brain/continuity/read-model.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-bench-fixture-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const FIXTURE = {
  name: "mini",
  description: "smallest viable fixture",
  notes: [
    { path: "Brain/notes/coffee.md", body: "# Coffee\n\nThe operator prefers flat white.\n" },
  ],
  continuity: [
    {
      kind: "session_turn",
      created_at: "2026-06-01T10:00:00.000Z",
      payload: { session_id: "s-1", turn_id: "t-1", role: "user", text: "remember flat white" },
    },
  ],
  questions: [
    {
      id: "q1",
      category: "single_hop",
      query: "flat white coffee preference",
      top_k: 5,
      expected_paths: ["Brain/notes/coffee.md"],
    },
  ],
};

describe("parseBenchFixture", () => {
  test("accepts a well-formed fixture and rejects malformed ones", () => {
    const fixture = parseBenchFixture(FIXTURE);
    expect(fixture.name).toBe("mini");
    expect(fixture.questions).toHaveLength(1);

    expect(() => parseBenchFixture(null)).toThrow();
    expect(() => parseBenchFixture({ ...FIXTURE, name: "" })).toThrow("name");
    expect(() => parseBenchFixture({ ...FIXTURE, questions: [] })).toThrow("question");
    expect(() =>
      parseBenchFixture({
        ...FIXTURE,
        notes: [{ path: "../escape.md", body: "x" }],
      }),
    ).toThrow("path");
    expect(() =>
      parseBenchFixture({
        ...FIXTURE,
        notes: [{ path: "/abs/escape.md", body: "x" }],
      }),
    ).toThrow("path");
    expect(() =>
      parseBenchFixture({
        ...FIXTURE,
        questions: [{ id: "q1", category: "unknown_kind", query: "x" }],
      }),
    ).toThrow("category");
  });

  test("fixtureHash is stable across key order and changes with content", () => {
    const a = fixtureHash(parseBenchFixture(FIXTURE));
    const reordered = JSON.parse(JSON.stringify(FIXTURE)) as typeof FIXTURE;
    const b = fixtureHash(parseBenchFixture(reordered));
    expect(a).toBe(b);
    const c = fixtureHash(parseBenchFixture({ ...FIXTURE, name: "other" }));
    expect(c).not.toBe(a);
  });

  test("loadBenchFixture reads a file and fails fast on broken JSON", () => {
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify(FIXTURE));
    expect(loadBenchFixture(path).name).toBe("mini");
    writeFileSync(path, "{broken");
    expect(() => loadBenchFixture(path)).toThrow();
  });
});

describe("materializeBenchVault", () => {
  test("writes notes and continuity records into the disposable vault", () => {
    const vault = join(tmp, "vault");
    materializeBenchVault(parseBenchFixture(FIXTURE), vault);
    expect(existsSync(join(vault, "Brain", "notes", "coffee.md"))).toBe(true);
    expect(readFileSync(join(vault, "Brain", "notes", "coffee.md"), "utf8")).toContain(
      "flat white",
    );
    const turns = loadNormalizedContinuityRecords(vault, { kind: "session_turn" });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.sessionId).toBe("s-1");
  });
});

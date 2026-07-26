/**
 * Vault-wide broken-link ratchet (context-integrity-gates, unit G).
 *
 * Pins the three properties the gate rests on:
 *   - the SQL dangling definition (`target_document_id IS NULL AND
 *     target_path IS NOT NULL`), including its deliberate divergence
 *     from the read-time resolution ladder;
 *   - determinism: two measurements over an unchanged vault agree;
 *   - the full-resolution precondition: a count taken after an
 *     incremental run is reported as UNMEASURABLE, never as a number
 *     and never as "clean".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DANGLING_LINK_DEFINITION,
  LINK_RATCHET_FIX_COMMAND,
  LINK_RATCHET_SCHEMA_VERSION,
  judgeSubject,
  measureFromIndex,
  measureVault,
  parseCeiling,
  ratchetSearchConfig,
  serializeCeiling,
  LinkRatchetError,
  type LinkRatchetMeasurement,
} from "../../../src/core/search/link-ratchet.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { writeMd } from "../../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-link-ratchet-"));
  vault = join(tmp, "vault");
  // notes/a.md carries five link rows with a target path plus one tag:
  //   [[notes/b.md]]  → resolves by exact path
  //   [[b]]           → SQL-dangling, read-time resolvable (divergence)
  //   [[gone]]        → dangling, no such document
  //   (notes/c.md)    → resolves by exact path
  //   (missing.md)    → dangling, no such document
  //   #topic          → tag, target_path IS NULL, never counted
  writeMd(
    vault,
    "notes/a.md",
    [
      "# A",
      "",
      "See [[notes/b.md]] and [[b]] and [[gone]].",
      "Also [c](notes/c.md) and [nope](missing.md).",
      "Tag #topic",
      "",
    ].join("\n"),
  );
  writeMd(vault, "notes/b.md", "# B\n\nbody\n");
  writeMd(vault, "notes/c.md", "# C\n\nbody\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function measured(m: LinkRatchetMeasurement): number {
  if (!m.measurable) throw new Error(`expected a measurable result, got ${m.reason}`);
  return m.dangling;
}

describe("SQL dangling definition", () => {
  test("counts exactly the links with a target path and no materialized target", async () => {
    const m = await measureVault(vault);
    expect(m.measurable).toBe(true);
    expect(measured(m)).toBe(3);
    if (m.measurable) {
      expect(m.links).toBe(5);
      expect(m.documents).toBe(3);
      expect(m.definition).toBe(DANGLING_LINK_DEFINITION);
    }
  });

  test("a vault with no links measures zero, distinctly from unmeasurable", async () => {
    const clean = join(tmp, "clean");
    writeMd(clean, "solo.md", "# Solo\n\nno links here\n");
    const m = await measureVault(clean);
    expect(m.measurable).toBe(true);
    expect(measured(m)).toBe(0);
  });

  test("measuring never writes into the subject vault", async () => {
    const before = Bun.file(join(vault, "notes/a.md")).size;
    await measureVault(vault);
    expect(Bun.file(join(vault, "notes/a.md")).size).toBe(before);
    // The index run appends a metrics record into `<vault>/Brain/metrics`
    // when it is pointed at the subject directly; the hermetic copy is
    // what keeps the subject byte-identical.
    expect(await Bun.file(join(vault, "Brain", "metrics", "index.jsonl")).exists()).toBe(false);
  });
});

describe("determinism", () => {
  test("two measurements over an unchanged vault produce the same count", async () => {
    const first = await measureVault(vault);
    const second = await measureVault(vault);
    expect(measured(second)).toBe(measured(first));
    expect(second).toEqual(first);
  });
});

describe("full-resolution precondition", () => {
  test("a count after an incremental run is unmeasurable, not clean", async () => {
    const dbPath = join(tmp, "index.sqlite");
    const config = ratchetSearchConfig(vault, dbPath);
    await indexVault(config, { force: true });
    expect(measured(await measureFromIndex(config))).toBe(3);

    // An incremental pass leaves `last_indexed_at` ahead of
    // `last_full_index_at`; the resolution state is then not provably
    // complete, so the count must be refused.
    await indexVault(config, { force: false });
    const m = await measureFromIndex(config);
    expect(m.measurable).toBe(false);
    if (!m.measurable) expect(m.reason).toBe("partial-resolution");
  });

  test("a missing index is unmeasurable, not clean", async () => {
    const config = ratchetSearchConfig(vault, join(tmp, "absent.sqlite"));
    const m = await measureFromIndex(config);
    expect(m.measurable).toBe(false);
    if (!m.measurable) expect(m.reason).toBe("index-missing");
  });
});

describe("ceiling file", () => {
  const valid = {
    schema_version: LINK_RATCHET_SCHEMA_VERSION,
    definition: DANGLING_LINK_DEFINITION,
    subjects: [{ path: "templates/brain-starter", dangling: 4 }],
  };

  test("round-trips through serialize/parse", () => {
    const text = serializeCeiling(valid);
    expect(parseCeiling(text)).toEqual(valid);
    expect(serializeCeiling(parseCeiling(text))).toBe(text);
  });

  test("serialization is newline-terminated and sorted by subject path", () => {
    const text = serializeCeiling({
      ...valid,
      subjects: [
        { path: "b", dangling: 1 },
        { path: "a", dangling: 2 },
      ],
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
  });

  test("a foreign schema_version is refused", () => {
    const text = JSON.stringify({ ...valid, schema_version: 99 });
    expect(() => parseCeiling(text)).toThrow(LinkRatchetError);
  });

  test("a ceiling recorded under a different definition is refused by name", () => {
    const text = JSON.stringify({ ...valid, definition: "some-other-definition" });
    let message = "";
    try {
      parseCeiling(text);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("definition");
    expect(message).toContain(LINK_RATCHET_FIX_COMMAND);
  });

  test("a negative or fractional count is refused", () => {
    expect(() =>
      parseCeiling(JSON.stringify({ ...valid, subjects: [{ path: "x", dangling: -1 }] })),
    ).toThrow(LinkRatchetError);
    expect(() =>
      parseCeiling(JSON.stringify({ ...valid, subjects: [{ path: "x", dangling: 1.5 }] })),
    ).toThrow(LinkRatchetError);
  });

  test("an empty subject list is refused - a gate with nothing to measure is not a gate", () => {
    expect(() => parseCeiling(JSON.stringify({ ...valid, subjects: [] }))).toThrow(
      LinkRatchetError,
    );
  });

  test("duplicate subject paths are refused", () => {
    const text = JSON.stringify({
      ...valid,
      subjects: [
        { path: "x", dangling: 1 },
        { path: "x", dangling: 2 },
      ],
    });
    expect(() => parseCeiling(text)).toThrow(LinkRatchetError);
  });
});

describe("judgeSubject", () => {
  const clean: LinkRatchetMeasurement = Object.freeze({
    measurable: true,
    definition: DANGLING_LINK_DEFINITION,
    dangling: 3,
    links: 5,
    documents: 3,
  });

  test("equal is level, fewer is a drop, more is a rise", () => {
    expect(judgeSubject("s", 3, clean).status).toBe("level");
    expect(judgeSubject("s", 4, clean).status).toBe("drop");
    expect(judgeSubject("s", 2, clean).status).toBe("rise");
  });

  test("an unmeasurable subject is its own status, never level", () => {
    const v = judgeSubject("s", 0, {
      measurable: false,
      definition: DANGLING_LINK_DEFINITION,
      reason: "index-missing",
      detail: "no index",
    });
    expect(v.status).toBe("unmeasurable");
  });
});

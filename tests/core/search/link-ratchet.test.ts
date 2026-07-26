/**
 * Vault-wide broken-link ratchet (context-integrity-gates, unit G).
 *
 * Pins the three properties the gate rests on:
 *   - the counting definition: a link is broken when the READ-TIME
 *     resolution ladder cannot resolve it, so a basename wikilink a
 *     reader follows is not counted and an ambiguous one is;
 *   - determinism: two measurements over an unchanged vault agree;
 *   - the full-resolution precondition: a count taken after an
 *     incremental run is reported as UNMEASURABLE, never as a number
 *     and never as "clean".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { Store } from "../../../src/core/search/store.ts";
import { writeMd } from "../../helpers/search-fixtures.ts";

let tmp: string;
let vault: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-link-ratchet-"));
  vault = join(tmp, "vault");
  // notes/a.md carries five link rows with a target path plus one tag:
  //   [[notes/b.md]]  → resolves by exact path
  //   [[b]]           → resolves by unambiguous basename (ladder rung 3)
  //   [[gone]]        → unresolvable, no such document
  //   (notes/c.md)    → resolves by exact path
  //   (missing.md)    → unresolvable, no such document
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

describe("unresolved-after-the-ladder definition", () => {
  test("counts exactly the links the read-time ladder cannot resolve", async () => {
    const m = await measureVault(vault);
    expect(m.measurable).toBe(true);
    expect(measured(m)).toBe(2);
    if (m.measurable) {
      expect(m.links).toBe(5);
      expect(m.documents).toBe(3);
      expect(m.definition).toBe(DANGLING_LINK_DEFINITION);
    }
  });

  test("a basename wikilink a reader resolves does not raise the count", async () => {
    const before = await measureVault(vault);
    // `notes/c.md` exists and its basename is unambiguous, so `[[c]]` is
    // a healthy edit - the exact case that made the SQL predicate fire on
    // a vault written in Obsidian-style basename links.
    writeMd(vault, "notes/d.md", "# D\n\nSee [[c]].\n");
    const after = await measureVault(vault);
    expect(measured(after)).toBe(measured(before));
  });

  test("an ambiguous basename stays counted - the ladder refuses to guess", async () => {
    const before = await measureVault(vault);
    // Two nested documents named `dup` make `[[dup]]` unresolvable at read
    // time, so it is broken by the same definition the reader applies.
    writeMd(vault, "one/dup.md", "# Dup one\n");
    writeMd(vault, "two/dup.md", "# Dup two\n");
    writeMd(vault, "notes/e.md", "# E\n\nSee [[dup]].\n");
    const after = await measureVault(vault);
    expect(measured(after)).toBe(measured(before) + 1);
  });

  test("the count agrees with the ladder the readers use", async () => {
    // One link row per distinct edge, so the DISTINCT in
    // `resolvedDocLinkPairs` cannot mask a disagreement: whatever that
    // ladder resolves is exactly what this gate does not count.
    const agree = join(tmp, "agree");
    writeMd(agree, "x.md", "# X\n\nSee [[y]], [[z.md]] and [[gone]].\n");
    writeMd(agree, "sub/y.md", "# Y\n");
    writeMd(agree, "z.md", "# Z\n");
    const config = ratchetSearchConfig(agree, join(tmp, "agree.sqlite"));
    await indexVault(config, { force: true });
    const store = await Store.open(config, { mode: "read" });
    try {
      const counts = store.linkResolutionCounts();
      const resolvable = store.resolvedDocLinkPairs().length;
      expect(counts.total).toBe(3);
      expect(counts.total - counts.unresolved).toBe(resolvable);
      expect(counts.unresolved).toBe(1);
    } finally {
      await store.close();
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
    expect(measured(await measureFromIndex(config))).toBe(2);

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

/**
 * A present-but-empty subject used to measure `dangling: 0` and PASS:
 * `walked === 0` and `documents === 0` satisfy both completeness guards,
 * so a subject that was emptied, renamed, sparse-checked-out, or fully
 * excluded by its own ignore rules produced a clean bill of health -
 * and the write form then committed `0` as a permanent ceiling for a
 * subject nobody measured.
 */
describe("an empty subject is unmeasurable, not clean", () => {
  test("measureVault reports subject-empty rather than zero dangling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-ratchet-empty-"));
    try {
      const measurement = await measureVault(dir);
      expect(measurement.measurable).toBe(false);
      if (!measurement.measurable) {
        expect(measurement.reason).toBe("subject-empty");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a subject whose only markdown is excluded by its own rules is subject-empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "o2b-ratchet-excluded-"));
    try {
      mkdirSync(join(dir, "Brain"), { recursive: true });
      writeFileSync(
        join(dir, "Brain", "_brain.yaml"),
        "schema_version: 1\nvault:\n  ignore_paths:\n    - notes\n",
        "utf8",
      );
      mkdirSync(join(dir, "notes"), { recursive: true });
      writeFileSync(join(dir, "notes", "a.md"), "# A\n\n[[missing]]\n", "utf8");
      const measurement = await measureVault(dir);
      expect(measurement.measurable).toBe(false);
      if (!measurement.measurable) {
        expect(measurement.reason).toBe("subject-empty");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The set merge of list settings (task 3.12, design D19 item 1): a list
 * setting such as a schema field folds per entry, not as one register
 * over the whole list, so concurrent edits on two devices both survive
 * and every delivery order gives the same list.
 */
import { describe, expect, test } from "bun:test";

import { canonicalJson } from "../../../src/core/integrity/digest.ts";
import { SETTING_ENTRY_KIND } from "../../../src/core/store/constants.ts";
import {
  foldSettings,
  settingsFingerprint,
  settingValue,
} from "../../../src/core/store/fold-settings.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { settingEntrySlot } from "../../../src/core/store/fold-setting-lists.ts";
import { authored, pick, rec, seededRandom, shuffled } from "./fixtures/fold-records.ts";

const T = Date.UTC(2026, 10, 15, 12, 0, 0);
const KEY = "brain.schema.page_types";

const base = (value: string[], physical = T, authority: "human" | "agent" = "agent") =>
  rec({
    device: "dev-a",
    physical,
    kind: "setting-set",
    body: authored(authority, { key: KEY, value }),
  });

const entry = (
  device: string,
  physical: number,
  value: string,
  present: boolean,
  authority: "human" | "agent" | "model" = "agent",
  key = KEY,
) =>
  rec({
    device,
    physical,
    kind: SETTING_ENTRY_KIND,
    body: authored(authority, { key, entry: value, present }),
  });

/** Every delivery order of `records` folds to one list. */
function foldsInAnyOrder(records: ReadonlyArray<StoreRecord>, key = KEY): unknown {
  const rng = seededRandom(312);
  const expected = canonicalJson(settingValue(foldSettings(records), key));
  for (let round = 0; round < 25; round++) {
    const order = shuffled(rng, [...records, ...records.slice(0, round % records.length)]);
    expect(canonicalJson(settingValue(foldSettings(order), key))).toBe(expected);
  }
  return settingValue(foldSettings(records), key);
}

describe("list settings fold per entry", () => {
  test("two devices add different entries at once: both stay, in any delivery order", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 10, "paper", true),
      entry("dev-b", T + 5, "person", true),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "person", "paper"]);
  });

  test("an add on one device and a remove on another of different entries both apply", () => {
    const records = [
      base(["note", "paper"]),
      entry("dev-a", T + 10, "person", true),
      entry("dev-b", T + 5, "paper", false),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "person"]);
  });

  test("add and remove of the same entry on two devices: the later clock wins", () => {
    const addLater = [
      base(["note"]),
      entry("dev-b", T + 5, "paper", false),
      entry("dev-a", T + 10, "paper", true),
    ];
    expect(foldsInAnyOrder(addLater)).toEqual(["note", "paper"]);
    const removeLater = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true),
      entry("dev-b", T + 10, "paper", false),
    ];
    expect(foldsInAnyOrder(removeLater)).toEqual(["note"]);
  });

  test("a human entry beats a later agent entry for the same entry", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true, "human"),
      entry("dev-b", T + 10, "paper", false, "agent"),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "paper"]);
  });

  test("a whole-list record later than an entry decides that entry too", () => {
    // A release before the set merge writes the whole list: what it leaves
    // out is removed, as it was before.
    const records = [
      base(["note"]),
      entry("dev-b", T + 5, "paper", true),
      base(["note", "person"], T + 10),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "person"]);
  });

  test("keyed entries hold one value per key: a concurrent change keeps only the later", () => {
    const key = "brain.schema.prefixes";
    expect(settingEntrySlot(key, "proj=project")).toBe("proj");
    expect(settingEntrySlot(KEY, "paper")).toBe("paper");
    const records = [
      rec({
        physical: T,
        kind: "setting-set",
        body: authored("agent", { key, value: ["proj=project"] }),
      }),
      entry("dev-a", T + 5, "proj=initiative", true, "agent", key),
      entry("dev-b", T + 10, "proj=programme", true, "agent", key),
    ];
    expect(foldsInAnyOrder(records, key)).toEqual(["proj=programme"]);
  });

  test("removing every entry removes the setting", () => {
    const fold = foldSettings([base(["note"]), entry("dev-a", T + 5, "note", false)]);
    expect(fold.settings.get(KEY)?.removed).toBe(true);
    expect(settingValue(fold, KEY)).toBeNull();
  });

  test("a key with no entry record folds exactly as before", () => {
    const records = [base(["b", "a", "b"]), base(["c", "a"], T + 1)];
    const fold = foldSettings(records);
    expect(settingValue(fold, KEY)).toEqual(["c", "a"]);
    expect(fold.settings.get(KEY)?.winner.record.id).toBe(records[1]!.id);
  });

  test("malformed entry records are rejected, and only schema list keys take entries", () => {
    const malformed = [
      entry("dev-a", T, "", true),
      entry("dev-a", T + 1, "two\nlines", true),
      rec({
        physical: T + 2,
        kind: SETTING_ENTRY_KIND,
        body: authored("agent", { key: KEY, entry: "x", present: "yes" }),
      }),
      entry("dev-a", T + 3, "ru", true, "human", "view.language"),
    ];
    const fold = foldSettings(malformed);
    expect(fold.rejected.map((r) => r.id).toSorted()).toEqual(
      malformed.map((r) => r.id).toSorted(),
    );
    expect(fold.settings.size).toBe(0);
  });
});

describe("entry records on a key that is not a schema list", () => {
  for (const [key, value] of [
    ["permissions.document", "deny:\n  - Private/**\n"],
    ["brain.dream.enabled", true],
    ["brain.example.block", { a: 1 }],
    ["brain.example.numbers", [1, 2]],
  ] as const) {
    test(`${key}: the entry record is rejected and the human value stays in force`, () => {
      const set = rec({
        physical: T,
        kind: "setting-set",
        body: authored("human", { key, value }),
      });
      const stray = entry("dev-b", T + 10, "x", false, "model", key);
      const fold = foldSettings([set, stray]);
      expect(fold.rejected.map((r) => r.id)).toEqual([stray.id]);
      expect(fold.settings.get(key)).toMatchObject({ removed: false, value });
      expect(fold.lists.has(key)).toBe(false);
    });
  }
});

describe("one entry spelled several ways is one slot", () => {
  test("the slot is the form the schema pack parser reads", () => {
    expect(settingEntrySlot(KEY, " Paper ")).toBe("paper");
    expect(settingEntrySlot(KEY, '"paper"')).toBe("paper");
    expect(settingEntrySlot(KEY, "Cafe\u0301")).toBe(settingEntrySlot(KEY, "caf\u00e9"));
    expect(settingEntrySlot("brain.schema.prefixes", " PROJ = project")).toBe("proj");
    expect(settingEntrySlot("brain.schema.aliases", "Paper = Article")).toBe("paper=article");
    expect(settingEntrySlot("brain.schema.link_constraints", "cites=Paper -> Note")).toBe(
      "cites=paper->note",
    );
  });

  test("each side of a name=value line is normalised on its own, quotes included", () => {
    const aliases = "brain.schema.aliases";
    expect(settingEntrySlot(aliases, '"Paper"="Article"')).toBe("paper=article");
    expect(settingEntrySlot(aliases, "'Paper' = 'Article'")).toBe("paper=article");
    expect(settingEntrySlot(aliases, '"Paper=Article"')).toBe("paper=article");
    expect(settingEntrySlot("brain.schema.prefixes", '"Proj"="project"')).toBe("proj");
    expect(settingEntrySlot("brain.schema.link_constraints", '"cites"="Paper"->"Note"')).toBe(
      "cites=paper->note",
    );
    // A removal in the plain spelling removes the quoted entry.
    const records = [
      entry("dev-a", T + 5, '"Paper"="Article"', true, "human", aliases),
      entry("dev-b", T + 10, "paper=article", false, "human", aliases),
    ];
    expect(foldSettings(records).settings.get(aliases)).toMatchObject({ removed: true });
  });

  test("a compound type.field key is one slot however its dot is spaced, as the parser reads it", () => {
    for (const key of ["brain.schema.attributes", "brain.schema.frontmatter_tiers"]) {
      expect(settingEntrySlot(key, "Paper . Year=Publication year")).toBe("paper.year");
      expect(settingEntrySlot(key, "paper.year=other")).toBe("paper.year");
    }
    // Only the first dot splits the key, as in the parser.
    expect(settingEntrySlot("brain.schema.attributes", "paper . year . x=y")).toBe(
      "paper.year . x",
    );
  });

  test("an agent entry in another spelling cannot bring back an entry the operator removed", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true, "agent"),
      entry("dev-a", T + 10, "paper", false, "human"),
      entry("dev-b", T + 20, " Paper", true, "agent"),
      base(["note", "PAPER"], T + 30, "agent"),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note"]);
  });
});

describe("whole lists, unsets and entries together", () => {
  test("a setting-unset between entries removes what came before it, and a later entry adds back", () => {
    const records = [
      base(["note", "paper"]),
      entry("dev-a", T + 5, "person", true),
      rec({
        device: "dev-b",
        physical: T + 10,
        kind: "setting-unset",
        body: authored("agent", { key: KEY }),
      }),
      entry("dev-a", T + 15, "memo", true),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["memo"]);
  });

  test("a later agent whole list does not undo human entries", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true, "human"),
      entry("dev-a", T + 6, "note", false, "human"),
      base(["note", "memo"], T + 10, "agent"),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["paper", "memo"]);
  });

  test("a later human whole list decides agent entries", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true, "agent"),
      entry("dev-b", T + 6, "memo", true, "agent"),
      base(["note", "memo"], T + 10, "human"),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "memo"]);
  });

  test("a model entry loses to an earlier agent entry", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true, "agent"),
      entry("dev-b", T + 10, "paper", false, "model"),
    ];
    expect(foldsInAnyOrder(records)).toEqual(["note", "paper"]);
  });

  test("a clock tie between two devices resolves the same way in every order", () => {
    const records = [
      base(["note"]),
      entry("dev-a", T + 5, "paper", true),
      entry("dev-b", T + 5, "paper", false),
    ];
    const value = foldsInAnyOrder(records);
    expect([["note"], ["note", "paper"]]).toContainEqual(value as string[]);
  });

  test("the digest of a store with no entry record is the plain register's", () => {
    const records = [base(["b", "a"]), base(["c"], T + 1, "human")];
    expect(canonicalJson(settingsFingerprint(foldSettings(records)))).toBe(
      canonicalJson({
        settings: { [KEY]: { value: ["c"], removed: false, winner: records[1]!.id } },
        rejected: [],
      }),
    );
  });
});

describe("a conditional removal (if_decided_by)", () => {
  const PREFIXES = "brain.schema.prefixes";
  const conditional = (device: string, physical: number, text: string, decidedBy: string) =>
    rec({
      device,
      physical,
      kind: SETTING_ENTRY_KIND,
      body: authored("human", {
        key: PREFIXES,
        entry: text,
        present: false,
        if_decided_by: decidedBy,
      }),
    });

  test("applies while the record it names decides the slot", () => {
    const ghost = entry("dev-b", T + 5, "p=ghost", true, "human", PREFIXES);
    const records = [ghost, conditional("dev-a", T + 10, "p=ghost", ghost.id)];
    expect(foldsInAnyOrder(records, PREFIXES)).toBeNull();
  });

  test("never removes a replacement it did not judge, whatever the clocks and delivery order", () => {
    const ghost = entry("dev-b", T + 5, "p=ghost", true, "human", PREFIXES);
    const paper = entry("dev-c", T + 7, "p=paper", true, "human", PREFIXES);
    const records = [ghost, paper, conditional("dev-a", T + 10, "p=ghost", ghost.id)];
    expect(foldsInAnyOrder(records, PREFIXES)).toEqual(["p=paper"]);
  });

  test("whose record is not there leaves the key as its other records decide it", () => {
    const lone = conditional("dev-a", T + 10, "p=ghost", "01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(foldSettings([lone]).settings.has(PREFIXES)).toBe(false);
    const other = entry("dev-b", T + 5, "q=note", true, "human", PREFIXES);
    expect(foldsInAnyOrder([other, lone], PREFIXES)).toEqual(["q=note"]);
  });

  test("is malformed on an addition or without a record id", () => {
    const added = rec({
      device: "dev-a",
      physical: T,
      kind: SETTING_ENTRY_KIND,
      body: authored("human", { key: PREFIXES, entry: "p=x", present: true, if_decided_by: "x" }),
    });
    const empty = conditional("dev-a", T, "p=x", "");
    // The fold lists rejections in fold order, which ties on the clock
    // break by generated id: compare by record, not by position.
    const reasons = new Map(foldSettings([added, empty]).rejected.map((r) => [r.id, r.reason]));
    expect(reasons).toEqual(
      new Map([
        [added.id, "if_decided_by is for a removal only"],
        [empty.id, "if_decided_by must be a record id"],
      ]),
    );
  });
});

describe("if_decided_by on a record that is no setting-entry", () => {
  test("is ignored, as any field a kind does not define: the record applies as written", () => {
    const set = rec({
      physical: T,
      kind: "setting-set",
      body: authored("human", {
        key: KEY,
        value: ["note"],
        if_decided_by: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    });
    const fold = foldSettings([set]);
    expect(fold.rejected).toEqual([]);
    expect(settingValue(fold, KEY)).toEqual(["note"]);
  });
});

describe("a list key whose records name no entry", () => {
  const PREFIXES = "brain.schema.prefixes";
  const ABSENT = "01AAAAAAAAAAAAAAAAAAAAAAAA";
  const whole = (value: string[], physical: number, authority: "human" | "agent" = "human") =>
    rec({ physical, kind: "setting-set", body: authored(authority, { key: PREFIXES, value }) });
  const unset = (physical: number) =>
    rec({ physical, kind: "setting-unset", body: authored("human", { key: PREFIXES }) });
  const removal = (physical: number, text: string, decidedBy?: string) =>
    rec({
      device: "dev-b",
      physical,
      kind: SETTING_ENTRY_KIND,
      body: authored("human", {
        key: PREFIXES,
        entry: text,
        present: false,
        ...(decidedBy === undefined ? {} : { if_decided_by: decidedBy }),
      }),
    });

  test("an empty whole list with a removal whose named record is absent is a removed key", () => {
    const records = [whole([], T), removal(T + 10, "p=ghost", ABSENT)];
    expect(foldsInAnyOrder(records, PREFIXES)).toBeNull();
    const state = foldSettings(records).settings.get(PREFIXES);
    expect(state?.removed).toBe(true);
    expect(state?.winner.record.id).toBe(records[0]!.id);
  });

  test("an unset followed by conditional removals is a removed key", () => {
    const records = [unset(T), removal(T + 10, "p=a", ABSENT), removal(T + 20, "q=b", ABSENT)];
    expect(foldsInAnyOrder(records, PREFIXES)).toBeNull();
    expect(foldSettings(records).settings.get(PREFIXES)?.removed).toBe(true);
  });

  test("the key that names no entry is won as the whole-list register would win it", () => {
    const human = whole([], T);
    const records = [human, whole([], T + 5, "agent"), removal(T + 10, "p=a", ABSENT)];
    expect(foldSettings(records).settings.get(PREFIXES)?.winner.record.id).toBe(human.id);
  });
});

describe("the list fold never throws and does not depend on delivery order", () => {
  const PREFIXES = "brain.schema.prefixes";
  const ENTRIES = ["p=a", "p=b", "q=a", "r=c"];
  const AUTHORITIES = ["human", "agent", "model"] as const;

  /** A small random record set of one list key: every record shape the fold takes, and broken ones. */
  function recordSet(rng: () => number): StoreRecord[] {
    const out: StoreRecord[] = [];
    const count = 1 + Math.floor(rng() * 6);
    for (let i = 0; i < count; i++) {
      const physical = T + Math.floor(rng() * 4) * 10;
      const device = pick(rng, ["dev-a", "dev-b", "dev-c"]);
      const authority = pick(rng, AUTHORITIES);
      const shape = Math.floor(rng() * 6);
      const body =
        shape === 0
          ? { key: PREFIXES, value: ENTRIES.filter(() => rng() < 0.4) }
          : shape === 1
            ? { key: PREFIXES }
            : {
                key: PREFIXES,
                entry: pick(rng, ENTRIES),
                present: shape === 2,
                ...(shape === 4
                  ? { if_decided_by: pick(rng, [...out.map((r) => r.id), "x"]) }
                  : {}),
                ...(shape === 5 ? { if_decided_by: "" } : {}),
              };
      const kind = shape === 0 ? "setting-set" : shape === 1 ? "setting-unset" : SETTING_ENTRY_KIND;
      out.push(rec({ device, physical, kind, body: authored(authority, body), rng }));
    }
    return out;
  }

  const digest = (records: ReadonlyArray<StoreRecord>) => {
    const fold = foldSettings(records);
    return canonicalJson({
      fingerprint: settingsFingerprint(fold),
      lists: [...(fold.lists.get(PREFIXES) ?? new Map()).entries()]
        .map(([slot, state]) => [slot, state.value, state.winner.record.id])
        .toSorted(),
    });
  };

  test("over seeded small record sets", () => {
    const rng = seededRandom(3120);
    for (let round = 0; round < 400; round++) {
      const records = recordSet(rng);
      const expected = digest(records);
      for (let order = 0; order < 6; order++) {
        expect(digest(shuffled(rng, [...records, ...records.slice(0, order)]))).toBe(expected);
      }
    }
  });
});

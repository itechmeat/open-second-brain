/**
 * The title lookup of every lane whose records a title names, cell by
 * cell, as one table over the lanes in `lanes.ts`.
 *
 * The rules each cell checks:
 * 1. A title never reaches a page whose stored title is another one.
 * 2. A slug the product issued reaches its page, whatever its length
 *    (capped, hashed, device-suffixed, identity-suffixed).
 * 3. A page the caller's reach withholds is neither read nor named.
 * 4. No write mints a record that would make a title and a listed slug
 *    name two records.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";

import { intakePledges } from "../../../../src/core/brain/pledge-intake.ts";
import {
  addPledge,
  pledgeExists,
  readPledgeAt,
  showPledge,
} from "../../../../src/core/brain/pledges.ts";
import { slugify, titleSlug } from "../../../../src/core/vault.ts";
import {
  dropVault,
  makeVault,
  moveRecord,
  NOW,
  TITLED_LANES,
  type Readable,
  type TitledLane,
} from "./lanes.ts";

let vault: string;

beforeEach(() => {
  vault = makeVault();
});

afterEach(() => {
  dropVault(vault);
});

/** Titles whose slug takes each form a slug can have. */
const TITLE_FORMS: ReadonlyArray<readonly [string, string]> = [
  ["ASCII", "Ship the parser to Ada"],
  ["ASCII at the cap", "a".repeat(80)],
  ["Cyrillic at the cap (64 code units)", "я".repeat(64)],
  ["CJK at the cap (64 code units)", "远".repeat(64)],
  ["astral CJK cut at a pair boundary", "𠀀".repeat(40)],
  ["a Windows device name (suffixed slug)", "CON"],
  ["no letter (hashed slug)", "!!!"],
];

/** A stored title and a value that keys like it but is another title. */
const KEYING_ALIKE: ReadonlyArray<readonly [string, string, string]> = [
  ["other punctuation", "Ship the parser to Ada", "Ship the parser, to Ada"],
  ["other case", "Проект release", "Проект Release"],
  ["trailing punctuation", "远程办公提高长期效率", "远程办公提高长期效率!"],
];

/** A statement that is its own slug, and one that keys to it. */
const FIXED = "远程办公提高长期效率";
const KEYED = `${FIXED}!`;

/** A reach that reads every page but the one at `slug`. */
function denyPage(lane: TitledLane, slug: string): Readable {
  return (rel) => rel !== lane.rel(slug);
}

/** Write `title` under the slug an older release gave it (`slugify`). */
function storeOld(lane: TitledLane, title: string): string {
  const slug = lane.create(vault, title);
  moveRecord(vault, lane, slug, slugify(title));
  return slugify(title);
}

for (const lane of TITLED_LANES) {
  describe(`${lane.name}: a slug the lane issued and the title both reach the record`, () => {
    for (const [form, title] of TITLE_FORMS) {
      test(form, () => {
        const slug = lane.create(vault, title);
        expect(slug).toBe(titleSlug(title));
        expect(lane.show(vault, slug)).toBe(title);
        expect(lane.show(vault, title)).toBe(title);
        expect(lane.act(vault, slug)).toBe(slug);
      });
    }
  });

  describe(`${lane.name}: a title that only keys like a stored one reaches nothing`, () => {
    for (const [how, stored, value] of KEYING_ALIKE) {
      test(how, () => {
        lane.create(vault, stored);
        expect(lane.show(vault, value)).toBeNull();
        expect(() => lane.act(vault, value)).toThrow(titleSlug(value));
        if (lane.remove) expect(() => lane.remove!(vault, value)).toThrow(titleSlug(value));
        expect(lane.show(vault, stored)).toBe(stored);
      });
    }
  });

  describe(`${lane.name}: a record under its old Latin-only slug`, () => {
    test("is reached by its title and by the old slug", () => {
      const old = storeOld(lane, "Проект release");
      expect(old).toBe("release");
      expect(lane.show(vault, "Проект release")).toBe("Проект release");
      expect(lane.show(vault, "release")).toBe("Проект release");
      expect(lane.act(vault, "Проект release")).toBe("release");
    });

    test("a record under both its new and its old slug is met under the new one", () => {
      const slug = lane.create(vault, "Проект release");
      copyFileSync(join(vault, lane.rel(slug)), join(vault, lane.rel(slugify("Проект release"))));
      expect(slug).toBe(titleSlug("Проект release"));
      expect(lane.show(vault, "Проект release")).toBe("Проект release");
      expect(lane.act(vault, "Проект release")).toBe(slug);
    });

    test("a statement that is its own slug meets its record under the old hashed slug", () => {
      const old = storeOld(lane, FIXED);
      expect(old).toMatch(/^unnamed-[0-9a-f]{8}$/u);
      expect(lane.show(vault, FIXED)).toBe(FIXED);
      expect(lane.act(vault, FIXED)).toBe(old);
    });

    test("a statement never selects another record that sits at its slug", () => {
      // A record that keys alike holds the new slug (another device wrote
      // it while this one still filed the statement under its old slug).
      const keyed = lane.create(vault, KEYED);
      moveRecord(vault, lane, keyed, "parked");
      const old = storeOld(lane, FIXED);
      moveRecord(vault, lane, "parked", keyed);
      expect(keyed).toBe(FIXED);
      expect(lane.show(vault, FIXED)).toBe(FIXED);
      expect(lane.act(vault, FIXED)).toBe(old);
      expect(lane.show(vault, KEYED)).toBe(KEYED);
      expect(lane.act(vault, KEYED)).toBe(keyed);
    });

    test("a title whose slug is that record's own new slug is not written there", () => {
      storeOld(lane, FIXED);
      if (lane.name === "pledges") {
        // A pledge keying alike takes its identity-suffixed slot.
        const keyed = lane.create(vault, KEYED);
        expect(keyed.startsWith(`${FIXED}-`)).toBe(true);
        expect(lane.show(vault, keyed)).toBe(KEYED);
      } else {
        expect(() => lane.create(vault, KEYED)).toThrow(FIXED);
      }
      expect(lane.show(vault, FIXED)).toBe(FIXED);
      expect(lane.show(vault, KEYED)).toBe(lane.name === "pledges" ? KEYED : null);
    });
  });

  describe(`${lane.name}: the slug a title keys to, typed with no page at it`, () => {
    const HASHED = "Формат заметок релиза";
    const NEW = titleSlug(HASHED);

    test("reaches the one record an older release filed under its hashed slug", () => {
      const old = storeOld(lane, HASHED);
      expect(old).toMatch(/^unnamed-[0-9a-f]{8}$/u);
      expect(lane.show(vault, NEW)).toBe(HASHED);
      expect(lane.act(vault, NEW)).toBe(old);
      if (lane.remove) expect(lane.remove(vault, NEW)).toBe(old);
    });

    test("reaches a record whose old slug kept the Latin words", () => {
      const title = "Тема-четыре release format t4";
      const old = storeOld(lane, title);
      expect(old).toBe("release-format-t4");
      expect(lane.show(vault, titleSlug(title))).toBe(title);
      expect(lane.act(vault, titleSlug(title))).toBe(old);
    });

    test("never reaches a record whose title keys to another slug", () => {
      storeOld(lane, "Формат заметок");
      expect(lane.show(vault, NEW)).toBeNull();
      expect(() => lane.act(vault, NEW)).toThrow(NEW);
    });

    test("two records keying to it reach neither", () => {
      const a = lane.create(vault, HASHED);
      moveRecord(vault, lane, a, "parked");
      const other = `${HASHED}.`;
      const b = lane.create(vault, other);
      moveRecord(vault, lane, b, slugify(other));
      moveRecord(vault, lane, "parked", slugify(HASHED));
      expect(slugify(other)).not.toBe(slugify(HASHED));
      expect(lane.show(vault, NEW)).toBeNull();
      expect(lane.show(vault, HASHED)).toBe(HASHED);
      expect(lane.show(vault, other)).toBe(other);
    });

    test("once a title keying to it is written there, the page at it wins", () => {
      const old = storeOld(lane, HASHED);
      const keyed = `${HASHED}!`;
      expect(lane.create(vault, keyed)).toBe(NEW);
      expect(lane.show(vault, NEW)).toBe(keyed);
      expect(lane.show(vault, HASHED)).toBe(HASHED);
      expect(lane.act(vault, HASHED)).toBe(old);
    });

    if (lane.reach) {
      test("a withheld old record answers as absent", () => {
        const old = storeOld(lane, HASHED);
        const readable = denyPage(lane, old);
        expect(lane.show(vault, NEW, readable)).toBeNull();
        let message = "";
        try {
          lane.act(vault, NEW, readable);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toContain(NEW);
        expect(message).not.toContain(old);
      });
    }
  });

  describe(`${lane.name}: a title in another Unicode form`, () => {
    test("meets its record under the old slug of either form", () => {
      const old = storeOld(lane, "Café plan");
      expect(old).toBe("caf-plan");
      const nfd = "Cafe\u0301 plan";
      expect(lane.show(vault, nfd)).toBe("Café plan");
      expect(lane.act(vault, nfd)).toBe(old);
    });
  });

  describe(`${lane.name}: a title with no Latin letter typed with other runs of spaces`, () => {
    // An older release filed such a title at `unnamed-<hash>` of its exact
    // spelling, spaces included; the title is the same record however its
    // spaces are typed.
    for (const [how, stored, typed] of [
      ["more spaces than stored", "远程 办公", "远程   办公"],
      ["fewer spaces than stored", "远程  办公", "远程 办公"],
    ] as const) {
      test(`${how}: meets its record under the old hashed slug, and is not minted twice`, () => {
        const old = storeOld(lane, stored);
        expect(old).not.toBe(slugify(typed));
        expect(lane.show(vault, typed)).toBe(stored);
        expect(lane.act(vault, typed)).toBe(old);
        expect(() => lane.create(vault, typed)).toThrow();
      });
    }
  });

  describe(`${lane.name}: a record whose file a macOS restore renamed to NFD`, () => {
    // macOS bsdtar writes every name it extracts in NFD, and a vault synced
    // from that Mac carries the name to every other device.
    test("is reached by either form of its title and its slug, and not minted twice", () => {
      const title = "Café plan";
      const slug = lane.create(vault, title);
      const nfd = slug.normalize("NFD");
      expect(nfd).not.toBe(slug);
      moveRecord(vault, lane, slug, nfd);
      for (const value of [title, title.normalize("NFD"), slug, nfd]) {
        expect(lane.show(vault, value)).toBe(title);
      }
      expect(lane.act(vault, title).normalize("NFC")).toBe(slug);
      expect(() => lane.create(vault, title)).toThrow();
    });
  });

  describe(`${lane.name}: a title that is another record's listed slug`, () => {
    test("is refused, and the listed slug still names its record", () => {
      const slug = lane.create(vault, "Ship the parser to Ada");
      expect(() => lane.create(vault, slug)).toThrow(slug);
      expect(lane.show(vault, slug)).toBe("Ship the parser to Ada");
    });
  });

  if (lane.remove) {
    describe(`${lane.name}: remove`, () => {
      test("by a listed slug and by a title removes that record only", () => {
        const a = lane.create(vault, "Ship the parser to Ada");
        const b = lane.create(vault, "Проект release");
        expect(lane.remove!(vault, a)).toBe(a);
        expect(lane.remove!(vault, "Проект release")).toBe(b);
        expect(lane.show(vault, a)).toBeNull();
        expect(lane.show(vault, b)).toBeNull();
      });
    });
  }

  if (lane.reach) {
    describe(`${lane.name}: reach`, () => {
      test("a withheld old-slug page answers as an absent one", () => {
        const old = storeOld(lane, "Проект release");
        const readable = denyPage(lane, old);
        expect(lane.show(vault, "Проект release", readable)).toBeNull();
        expect(lane.show(vault, old, readable)).toBeNull();
        let message = "";
        try {
          lane.act(vault, "Проект release", readable);
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message).toContain(titleSlug("Проект release"));
        expect(message).not.toContain(`: ${old}`);
      });

      test("a withheld page at a listed slug answers as an absent one", () => {
        const slug = lane.create(vault, "Ship the parser to Ada");
        expect(lane.show(vault, slug, denyPage(lane, slug))).toBeNull();
        expect(() => lane.act(vault, slug, denyPage(lane, slug))).toThrow(slug);
      });
    });
  }
}

/** The pledge lane of the table. */
function pledgeLane(): TitledLane {
  return TITLED_LANES.find((l) => l.name === "pledges")!;
}

describe("pledges: a title whose page is an identity-suffixed stem", () => {
  const lane = pledgeLane;

  test("is found when the base slot is empty", () => {
    lane().create(vault, "release", 0);
    const suffixed = lane().create(vault, "release", 1);
    expect(suffixed).toMatch(/^release-[0-9a-f]{6}$/u);
    lane().remove!(vault, "release");
    expect(lane().show(vault, "release")).toBe("release");
    expect(lane().act(vault, "release")).toBe(suffixed);
  });

  test("a withheld base slot refuses without classifying the stored title", () => {
    lane().create(vault, "Release!", 0);
    expect(() =>
      addPledge(vault, {
        title: "release",
        due: "2026-08-11",
        source: "notes/meeting.md",
        evidence: ["Ada asked for a written recap"],
        agent: "tester",
        now: NOW,
        readable: (rel) => rel !== lane().rel("release"),
      }),
    ).toThrow(/pledge already exists/u);
  });

  test("an ordinary unnamed- base keeps its suffixed old stems reachable by the new slug", () => {
    const title = "Проект unnamed release";
    expect(slugify(title)).toBe("unnamed-release");
    lane().create(vault, title, 0);
    const suffixed = lane().create(vault, title, 1);
    const hex = suffixed.slice(-6);
    moveRecord(vault, lane(), suffixed, `unnamed-release-${hex}`);
    lane().remove!(vault, titleSlug(title));
    expect(lane().show(vault, titleSlug(title))).toBe(title);
  });
});

describe("pledges: an identity-suffixed slug at the cap", () => {
  const LONG = "я".repeat(64);

  test("is reached by show, fulfill and remove", () => {
    const lane = TITLED_LANES.find((l) => l.name === "pledges")!;
    const base = lane.create(vault, LONG, 0);
    const suffixed = lane.create(vault, LONG, 1);
    expect(base).toBe(LONG);
    expect(suffixed).toMatch(new RegExp(`^${LONG}-[0-9a-f]{6}$`, "u"));
    expect(suffixed.length).toBe(71);
    expect(showPledge(vault, { slug: suffixed })?.due).toBe("2026-08-11");
    expect(lane.act(vault, suffixed)).toBe(suffixed);
    expect(lane.remove!(vault, suffixed)).toBe(suffixed);
    expect(showPledge(vault, { slug: base })?.due).toBe("2026-08-10");
  });

  test("is read as its own slot, not as the base", () => {
    const lane = TITLED_LANES.find((l) => l.name === "pledges")!;
    lane.create(vault, LONG, 0);
    const suffixed = `${LONG}-abcdef`;
    expect(readPledgeAt(vault, suffixed)).toBeNull();
    expect(pledgeExists(vault, suffixed)).toBe(false);
  });

  test("an absent one misses under its own name, not the base", () => {
    const lane = TITLED_LANES.find((l) => l.name === "pledges")!;
    lane.create(vault, LONG, 0);
    const suffixed = `${LONG}-abcdef`;
    expect(lane.show(vault, suffixed)).toBeNull();
    expect(() => lane.act(vault, suffixed)).toThrow(suffixed);
  });

  test("intake of the same title with another due date takes the free suffixed slot", () => {
    const lane = TITLED_LANES.find((l) => l.name === "pledges")!;
    lane.create(vault, LONG, 0);
    const res = intakePledges(
      vault,
      {
        source: "notes/meeting.md",
        pledges: [{ title: LONG, due: "2026-08-12", evidence: ["Ada asked for a written recap"] }],
      },
      { agent: "tester", now: NOW },
    );
    expect(res.created).toHaveLength(1);
    expect(res.created[0]).toMatch(new RegExp(`^${LONG}-[0-9a-f]{6}$`, "u"));
  });
});

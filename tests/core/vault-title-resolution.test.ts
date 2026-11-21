/**
 * The shared title-slug resolvers keep every ASCII value on its old slug
 * without reading anything, and a slug that sits inside a longer name keeps
 * the stem a device name such as `CON` always had.
 */

import { describe, expect, test } from "bun:test";

import {
  claimedTitleSlot,
  hasTitleWords,
  isIdentitySuffixedStem,
  isTitleSlug,
  legacySlugForms,
  locateSuffixedTitleStem,
  locateTitledPage,
  resolveSuffixedTitleSlug,
  resolveTitleSlug,
  slugify,
  titleKeySlug,
  titleSlug,
} from "../../src/core/vault.ts";

const ASCII = [
  "release",
  "Hello, World",
  "  --Mixed_Case 42 / v2.1--  ",
  "a".repeat(200),
  "CON",
  "nul",
  "Com1",
  "@",
  "",
];

describe("titleKeySlug", () => {
  test("an ASCII value, a device name included, gets exactly the slug slugify gives it", () => {
    for (const value of ASCII) expect(titleKeySlug(value)).toBe(slugify(value));
  });

  test("letters of any script stay, as in titleSlug", () => {
    expect(titleKeySlug("Проект release")).toBe(titleSlug("Проект release"));
    expect(titleKeySlug("远程办公 CON")).toBe("远程办公-con");
  });
});

describe("hasTitleWords", () => {
  test("is asked of the value, so a literal fallback-shaped title has words", () => {
    expect(hasTitleWords("unnamed-deadbeef")).toBe(true);
    expect(hasTitleWords("Перейти на Postgres")).toBe(true);
    expect(hasTitleWords("!!! ---")).toBe(false);
    expect(hasTitleWords("❤️")).toBe(false);
  });
});

describe("resolveTitleSlug", () => {
  test("an ASCII value is answered without asking for any stored title", () => {
    for (const value of ASCII.filter((v) => titleSlug(v) === slugify(v))) {
      const asked: string[] = [];
      const slug = resolveTitleSlug(value, (s) => {
        asked.push(s);
        return ["anything"];
      });
      expect(slug).toBe(slugify(value));
      expect(asked).toEqual([]);
    }
  });
});

describe("resolveSuffixedTitleSlug", () => {
  test("an ASCII value, CON included, keeps its old stem and probes nothing", () => {
    for (const value of ASCII) {
      const probed: string[] = [];
      const stem = resolveSuffixedTitleSlug(value, "abc123", (s) => {
        probed.push(s);
        return true;
      });
      expect(stem).toBe(`${slugify(value)}-abc123`);
      expect(probed).toEqual([]);
    }
  });

  for (const [how, stored, typed] of [
    ["NFD then, NFC now", "Статьи/Cafe\u0301.md", "Статьи/Café.md"],
    ["NFC then, NFD now", "Статьи/Café.md", "Статьи/Cafe\u0301.md"],
  ] as const) {
    test(`the page under the old slug of another Unicode form is the record (${how})`, () => {
      const old = `${slugify(stored)}-abc123`;
      expect(slugify(typed)).not.toBe(slugify(stored));
      expect(resolveSuffixedTitleSlug(typed, "abc123", (s) => s === old)).toBe(old);
    });
  }

  test("probes the NFD spelling of its current suffixed stem", () => {
    const fresh = `${titleKeySlug("Café plan")}-abc123`;
    const nfd = fresh.normalize("NFD");
    expect(resolveSuffixedTitleSlug("Café plan", "abc123", (stem) => stem === nfd)).toBe(nfd);
  });
});

test("an identity-suffixed NFD spelling remains a listed title slug", () => {
  const base = titleKeySlug("é".repeat(64));
  const nfd = `${base.normalize("NFD")}-abcdef`;
  expect(isTitleSlug(nfd.slice(0, -7))).toBe(true);
  expect(isIdentitySuffixedStem(nfd)).toBe(true);
});

describe("legacySlugForms", () => {
  test("names the old slug of every Unicode form and spacing, once each", () => {
    expect(legacySlugForms("Café plan")).toEqual(["caf-plan", "cafe-plan"]);
    expect(legacySlugForms("远程   办公")).toContain(slugify("远程 办公"));
    expect(legacySlugForms("Ship the parser")).toEqual(["ship-the-parser"]);
  });
});

/** A lookup over `pages` (slug to stored title) that records every slug it reads. */
function lookup(pages: Record<string, string>, reads: string[] = []) {
  return {
    read: (slug: string) => {
      reads.push(slug);
      return pages[slug] ?? null;
    },
    titleOf: (title: string) => title,
  };
}

const withheld = (): boolean => false;

describe("locateTitledPage reads", () => {
  test("an ASCII listed slug reads its page once, whatever title it stores", () => {
    const reads: string[] = [];
    const located = locateTitledPage(
      "ship-the-parser",
      lookup({ "ship-the-parser": "Ship the parser" }, reads),
    );
    expect(located).toEqual({ slug: "ship-the-parser", page: "Ship the parser" });
    expect(reads).toEqual(["ship-the-parser"]);
  });

  test("an absent ASCII listed slug reads nothing more", () => {
    const reads: string[] = [];
    expect(locateTitledPage("ship-the-parser", lookup({}, reads)).page).toBeNull();
    expect(reads).toEqual(["ship-the-parser"]);
  });

  test("a value that is a slug and a stored title reaches the title's record", () => {
    const pages = { 远程办公: "远程办公!", [slugify("远程办公")]: "远程办公" };
    expect(locateTitledPage("远程办公", lookup(pages, []))).toEqual({
      slug: slugify("远程办公"),
      page: "远程办公",
    });
  });
});

describe("locateTitledPage by the slug a title keys to", () => {
  test("reads only the old slugs: the Latin-only one and the hashed ones", () => {
    const title = "Формат заметок релиза";
    const pages = {
      [slugify(title)]: title,
      "ship-the-parser": "Ship the parser",
      "release-notes": "Release notes",
    };
    const reads: string[] = [];
    const located = locateTitledPage(titleSlug(title), {
      ...lookup(pages, reads),
      stems: () => Object.keys(pages),
    });
    expect(located).toEqual({ slug: slugify(title), page: title });
    expect(reads.toSorted()).toEqual(
      [titleSlug(title), slugify(titleSlug(title)), slugify(title)].toSorted(),
    );
  });

  test("a keyed lookup checks all legacy spellings of the requested slug", () => {
    const title = "Cafe\u0301 plan";
    const oldStem = slugify(title);
    const pages = { [oldStem]: title };
    expect(
      locateTitledPage("café-plan", {
        ...lookup(pages),
        stems: () => Object.keys(pages),
      }),
    ).toEqual({ slug: oldStem, page: title });
  });
});

describe("claimedTitleSlot", () => {
  test("a title whose slug is another record's own new slug claims it", () => {
    expect(claimedTitleSlot("远程办公!", lookup({ [slugify("远程办公")]: "远程办公" }))).toBe(
      "远程办公",
    );
  });

  test("a title that is another record's listed slug claims it", () => {
    expect(claimedTitleSlot("ship-the-parser", lookup({ "ship-the-parser": "Ship it" }))).toBe(
      "ship-the-parser",
    );
  });

  test("nothing stored claims nothing", () => {
    expect(claimedTitleSlot("远程办公!", lookup({}))).toBeNull();
  });
});

describe("locateSuffixedTitleStem", () => {
  test("the selected page withheld, under either slug, answers the new stem as withheld", () => {
    const fresh = `${titleKeySlug("Проект")}-abc`;
    const legacy = `${slugify("Проект")}-abc`;
    for (const present of [[fresh], [legacy]]) {
      const exists = (stem: string): boolean => present.includes(stem);
      expect(locateSuffixedTitleStem("Проект", "abc", exists, withheld)).toEqual({
        stem: fresh,
        withheld: true,
      });
    }
    expect(locateSuffixedTitleStem("Проект", "abc", (s) => s === legacy)).toEqual({
      stem: legacy,
      withheld: false,
    });
  });
});

/**
 * A title names only the pledge that stores that title.
 *
 * "Ship the parser to Ada" and "Ship the parser, to Ada" key alike, so the
 * second takes the identity-suffixed slot. A title lookup used to return
 * whatever page sat at the shared slug, so fulfilling or removing the
 * second promise by its title acted on the first one. A title now reaches
 * only a page whose stored title is that title, at its slug, at the
 * Latin-only slug an older release gave it, or at either one's
 * identity-suffixed slot; a slug `list` issued still names its own page.
 * An older release's identity-suffixed page (`release-notes-<hex>`) is
 * found by its title, and an old slug that is a bare device name counts as
 * absent when nothing is stored there.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPledge,
  fulfillPledge,
  listPledges,
  removePledge,
  showPledge,
} from "../../../src/core/brain/pledges.ts";
import { slugify } from "../../../src/core/vault.ts";

const NOW = new Date("2026-06-19T12:00:00Z");
const SOURCE_REL = "notes/meeting.md";
const QUOTE = "Ada asked for a written recap";
const PLAIN = "Ship the parser to Ada";
const COMMA = "Ship the parser, to Ada";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pledge-title-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  mkdirSync(join(vault, "notes"), { recursive: true });
  writeFileSync(join(vault, SOURCE_REL), `${QUOTE} of the migration steps.\n`, "utf8");
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function add(title: string, due = "2026-06-25") {
  return addPledge(vault, {
    title,
    due,
    source: SOURCE_REL,
    evidence: [QUOTE],
    agent: "tester",
    now: NOW,
  });
}

function pledgeDir(): string {
  return join(vault, "Brain", "pledges");
}

function open(): string[] {
  return listPledges(vault, { now: NOW }).map((item) => item.title);
}

describe("two titles that key alike", () => {
  test("show reaches each title's own page", () => {
    const plain = add(PLAIN);
    const comma = add(COMMA);
    expect(comma.slug).not.toBe(plain.slug);
    expect(showPledge(vault, { slug: PLAIN })?.slug).toBe(plain.slug);
    expect(showPledge(vault, { slug: COMMA })?.slug).toBe(comma.slug);
  });

  test("fulfilling the second title stamps the second page, not the first", () => {
    add(PLAIN);
    const comma = add(COMMA);
    const stamped = fulfillPledge(vault, { slug: COMMA, now: NOW });
    expect(stamped.slug).toBe(comma.slug);
    expect(stamped.title).toBe(COMMA);
    expect(showPledge(vault, { slug: PLAIN })?.fulfilled).toBeNull();
  });

  test("removing the second title archives the second page, not the first", () => {
    add(PLAIN);
    const comma = add(COMMA);
    expect(removePledge(vault, { slug: COMMA }).slug).toBe(comma.slug);
    expect(open()).toEqual([PLAIN]);
  });

  test("a title that only keys like a stored one reaches nothing", () => {
    add(PLAIN);
    expect(showPledge(vault, { slug: COMMA })).toBeNull();
    expect(() => fulfillPledge(vault, { slug: COMMA })).toThrow(
      "no pledge: ship-the-parser-to-ada",
    );
    expect(() => removePledge(vault, { slug: COMMA })).toThrow("no pledge: ship-the-parser-to-ada");
    expect(open()).toEqual([PLAIN]);
  });

  test("the slugs list issued keep naming their own pages", () => {
    add(PLAIN);
    add(COMMA);
    for (const item of listPledges(vault, { now: NOW })) {
      expect(showPledge(vault, { slug: item.slug })?.title).toBe(item.title);
    }
  });

  test("a title differing only in whitespace or Unicode form is the same title", () => {
    const page = add("Отправить Аде отчёт");
    expect(showPledge(vault, { slug: "  Отправить   Аде отчёт " })?.slug).toBe(page.slug);
    expect(showPledge(vault, { slug: "Отправить Аде отчёт".normalize("NFD") })?.slug).toBe(
      page.slug,
    );
  });
});

describe("pages an older release wrote", () => {
  test("NFC and NFD reposts match the same legacy suffixed pledge", () => {
    add("Cafe");
    const decomposed = "Отчёт Cafe\u0301";
    const page = add(decomposed);
    const oldDigest = createHash("sha256")
      .update(`${decomposed}\n2026-06-25\n${SOURCE_REL}`)
      .digest("hex")
      .slice(0, 6);
    const legacy = `cafe-${oldDigest}`;
    renameSync(page.path, join(pledgeDir(), `${legacy}.md`));

    expect(showPledge(vault, { slug: "Отчёт Café" })?.slug).toBe(legacy);
    expect(() => add("Отчёт Café")).toThrow(/pledge already exists/u);
  });

  test("a withheld current slot is refused without classifying its contents", () => {
    const held = add(PLAIN);
    const readable = (rel: string) => !rel.endsWith(`/${held.slug}.md`);
    expect(() =>
      addPledge(vault, {
        title: "Ship, the parser to Ada",
        due: "2026-06-25",
        source: SOURCE_REL,
        evidence: [QUOTE],
        agent: "tester",
        now: NOW,
        readable,
      }),
    ).toThrow(/pledge already exists/u);
  });

  test("an identity-suffixed old slug is found by its title", () => {
    // An older release filed both titles under `release-notes`: the first
    // took the plain slot, the second its identity-suffixed one.
    const first = add("Отправить Аде release notes");
    const second = add("Показать Грейс release notes");
    renameSync(first.path, join(pledgeDir(), "release-notes.md"));
    const oldSuffixed = `release-notes-${"a1b2c3"}`;
    renameSync(second.path, join(pledgeDir(), `${oldSuffixed}.md`));
    expect(showPledge(vault, { slug: "Показать Грейс release notes" })?.slug).toBe(oldSuffixed);
    expect(showPledge(vault, { slug: "Отправить Аде release notes" })?.slug).toBe("release-notes");
    expect(fulfillPledge(vault, { slug: "Показать Грейс release notes", now: NOW }).slug).toBe(
      oldSuffixed,
    );
    expect(removePledge(vault, { slug: "Показать Грейс release notes" }).slug).toBe(oldSuffixed);
    expect(open()).toEqual(["Отправить Аде release notes"]);
  });

  test("a bare device-name old slug is found by its title, and absent it is nothing", () => {
    const title = "远程办公 CON";
    expect(showPledge(vault, { slug: title })).toBeNull();
    const page = add(title);
    expect(page.slug).toBe("远程办公-con");
    renameSync(page.path, join(pledgeDir(), `${slugify(title)}.md`));
    expect(showPledge(vault, { slug: title })?.slug).toBe("con");
    expect(readdirSync(pledgeDir())).toEqual(["con.md"]);
  });
});

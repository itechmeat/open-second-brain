/**
 * What the guides tell an operator before a step that can lose or expose
 * records (release 2.0.1):
 *
 *  - a store already in the vault folder is moved, and its store id
 *    checked, before `store_root` is set on any machine: a root that is
 *    still empty gets a new store with another id;
 *  - `store_root` alone does not keep `private/` off a machine that syncs
 *    the whole vault: the folder is kept out of that machine's sync;
 *  - the recovery copy of a moved store goes only after a carry finds
 *    nothing waiting in it: late lines exist nowhere else until then.
 *
 * Tokens, not prose: a paragraph rewritten in other words still passes,
 * one that drops the condition does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MOVE_OUT = "moving-the-store-out-of-the-vault-folder";

function doc(...path: string[]): string {
  return readFileSync(join(REPO_ROOT, ...path), "utf8");
}

/** Paragraphs and list items, blank-line separated. */
function paragraphs(text: string): string[] {
  return text.split(/\r?\n\s*\r?\n/);
}

/** GitHub's slug of a markdown heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

/** The text of the section under the heading whose slug is `anchor`, up to the next heading. */
function section(text: string, anchor: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(
    (l) => /^#{1,6} /.test(l) && slug(l.replace(/^#+ /, "")) === anchor,
  );
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

describe("moving a store that is in the vault folder to a root you choose", () => {
  test("the guide moves it and checks the store id before store_root is set", () => {
    const steps = section(doc("docs", "brain-store.md"), MOVE_OUT);
    expect(steps).toContain("o2b store path");
    expect(steps).toContain("same store id");
    expect(steps).toContain(".open-second-brain-store/shared");
  });

  test("the update guide and the release notes send the reader there", () => {
    expect(doc("docs", "updating.md")).toContain(`brain-store.md#${MOVE_OUT}`);
    expect(doc("docs", "brain-store.md")).toContain(`(#${MOVE_OUT})`);
    const notes = doc("CHANGELOG.md");
    const release = notes.slice(notes.indexOf("## [2.0.1]"), notes.indexOf("## [2.0.0]"));
    expect(release).toContain("Moving the store out of the vault folder");
  });
});

describe("a machine that must not hold private records", () => {
  test("is told that store_root alone does not keep private/ out of its vault sync", () => {
    for (const text of [doc("docs", "brain-store.md"), doc("docs", "updating.md")]) {
      const advice = paragraphs(text).filter(
        (p) => p.includes("must not hold private records") && p.includes("store_root"),
      );
      expect(advice.length).toBeGreaterThan(0);
      for (const p of advice) expect(p).toContain(".open-second-brain-store/private");
    }
  });
});

describe("the recovery copy of a moved store", () => {
  test("is removed only after a carry finds nothing waiting in it", () => {
    for (const text of [doc("docs", "brain-store.md"), doc("docs", "updating.md")]) {
      // The instruction and the conditions that follow it (a sentence, or a list after it).
      const at = [...text.matchAll(/delete (that|the old) folder by hand/gi)].map((m) => m.index!);
      expect(at.length).toBeGreaterThan(0);
      for (const i of at)
        expect(text.slice(i, i + 600)).toContain("o2b store move-into-vault --carry");
    }
  });
});

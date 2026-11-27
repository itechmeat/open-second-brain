/**
 * Where the operator first reads that the brain store travels with the
 * vault's sync (release 2.0.1), the same paragraph says it does so only
 * when the sync carries hidden folders, and links the guide's section that
 * names the way out (`store_root`). A sync tool that skips hidden folders
 * (Obsidian Sync) never carries `.open-second-brain-store/`, so an
 * unconditional claim promises a store the other machines never receive.
 *
 * Tokens, not prose: a paragraph rewritten in other words still passes,
 * one that drops the condition does not.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const STORE_FOLDER = ".open-second-brain-store/";
const SECTION = "the-default-the-store-travels-with-the-vault";

/** Paragraphs (blank-line separated) that say the store reaches other machines by the vault's sync. */
function syncClaims(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.includes(STORE_FOLDER) && /vault's (own )?sync/.test(p));
}

/** GitHub's slug of a markdown heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

describe("the store's sync claim", () => {
  for (const doc of [
    "README.md",
    "install.md",
    join("plugins", "codex", "README.md"),
    join("docs", "features.md"),
  ]) {
    test(`${doc} names the hidden-folder condition with the claim`, () => {
      const claims = syncClaims(readFileSync(join(REPO_ROOT, doc), "utf8"));
      expect(claims.length).toBeGreaterThan(0);
      for (const claim of claims) {
        expect(claim).toContain("hidden folders");
        expect(claim).toContain(`brain-store.md#${SECTION}`);
      }
    });
  }

  test("the 2.0.1 release notes name the hidden-folder condition with the claim", () => {
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const section = changelog.slice(
      changelog.indexOf("## [2.0.1]"),
      changelog.indexOf("## [2.0.0]"),
    );
    const claims = section
      .split(/\r?\n/)
      .filter(
        (line) => line.includes(STORE_FOLDER) && /syncs the vault|vault's (own )?sync/.test(line),
      );
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) expect(claim).toContain("hidden folders");
  });

  test("the update guide's section on a machine that switched on 2.0.0 exists and names the command", () => {
    const guide = readFileSync(join(REPO_ROOT, "docs", "updating.md"), "utf8");
    const headings = [...guide.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!));
    expect(headings).toContain("a-machine-that-switched-on-200");
    expect(readFileSync(join(REPO_ROOT, "install.md"), "utf8")).toContain(
      "updating.md#a-machine-that-switched-on-200",
    );
    expect(guide).toContain("o2b store move-into-vault");
  });

  test("the linked section exists in the guide", () => {
    const guide = readFileSync(join(REPO_ROOT, "docs", "brain-store.md"), "utf8");
    const headings = [...guide.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]!));
    expect(headings).toContain(SECTION);
  });
});

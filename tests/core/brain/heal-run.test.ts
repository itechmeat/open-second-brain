/**
 * Heal-enrichment runner (Brain lifecycle suite, Feature 6) - safety
 * properties: the Brain root AND the standard excluded dirs (.git /
 * .obsidian / .trash / .stversions) are never rewritten, and a page is
 * never linked to its own title or aliases.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHealEnrichment } from "../../../src/core/brain/heal-run.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-heal-run-"));
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function note(rel: string, content: string): string {
  const p = join(vault, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf8");
  return p;
}

describe("runHealEnrichment safety", () => {
  test("links exact mentions in ordinary user pages", () => {
    note("Notes/Acme.md", "---\ntitle: Acme\n---\nThe Acme page.\n");
    const ref = note("Notes/ref.md", "---\ntitle: Ref\n---\nwe rely on Acme daily\n");
    const result = runHealEnrichment(vault);
    expect(result.enriched).toBeGreaterThanOrEqual(1);
    expect(readFileSync(ref, "utf8")).toContain("[[Acme]]");
  });

  test("never rewrites pages under .obsidian / .stversions / .trash", () => {
    note("Notes/Acme.md", "---\ntitle: Acme\n---\nThe Acme page.\n");
    const obsidian = note(".obsidian/snippets/note.md", "mentions Acme here");
    const stversion = note(".stversions/old.md", "mentions Acme here");
    const trash = note(".trash/gone.md", "mentions Acme here");
    runHealEnrichment(vault);
    expect(readFileSync(obsidian, "utf8")).not.toContain("[[Acme]]");
    expect(readFileSync(stversion, "utf8")).not.toContain("[[Acme]]");
    expect(readFileSync(trash, "utf8")).not.toContain("[[Acme]]");
  });

  test("never rewrites pages under the Brain root", () => {
    note("Notes/Acme.md", "---\ntitle: Acme\n---\nx\n");
    const brainPage = note("Brain/preferences/pref-x.md", "mentions Acme here");
    runHealEnrichment(vault);
    expect(readFileSync(brainPage, "utf8")).not.toContain("[[Acme]]");
  });

  test("does not link a page to its own alias", () => {
    // ego.md has title Ego and an alias "Acme"; it must not link its own
    // alias even though another page also references "Acme".
    const ego = note(
      "Notes/ego.md",
      "---\ntitle: Ego\naliases:\n  - Acme\n---\nThis Acme note is mine.\n",
    );
    runHealEnrichment(vault);
    expect(readFileSync(ego, "utf8")).not.toContain("[[Acme]]");
  });
});

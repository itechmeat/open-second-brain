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
import {
  createSafeguard,
  SafeguardTimeoutError,
  type Safeguard,
} from "../../../src/core/brain/safeguard.ts";

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

describe("where the deadline is actually honoured", () => {
  /** A guard that never trips and counts how often it was consulted. */
  function countingGuard(): { guard: Safeguard; count: () => number } {
    let seen = 0;
    return {
      guard: Object.freeze({
        operation: "dream",
        timeoutMs: null,
        checkpoint: () => {
          seen += 1;
        },
      }),
      count: () => seen,
    };
  }

  test("the phrase build is consulted before, not only after", () => {
    // Two pages, so the arithmetic distinguishes a per-page checkpoint
    // from a per-phase one. The run consults the guard:
    //
    //   1x after the listing walk (uninterruptible, so bounded on exit),
    //   Px in the index loop,
    //   1x before prepareHealPhrases (uninterruptible, so bounded on
    //     entry - this is the one that was missing, which left the sort
    //     and regex-escape of every title and alias in the vault sitting
    //     between two checkpoints),
    //   Px in the rewrite loop.
    //
    // 2 * P + 2. Before the fix it was 2 * P + 1, and the phrase build
    // ran unconditionally no matter how long the budget had been gone.
    note("Notes/Acme.md", "---\ntitle: Acme\n---\nThe Acme page.\n");
    note("Notes/ref.md", "---\ntitle: Ref\n---\nwe rely on Acme daily\n");
    const { guard, count } = countingGuard();
    const result = runHealEnrichment(vault, { safeguard: guard });
    expect(result.scanned).toBe(2);
    expect(count()).toBe(2 * result.scanned + 2);
  });

  test("an already-elapsed budget stops before the phrase build", () => {
    note("Notes/Acme.md", "---\ntitle: Acme\n---\nThe Acme page.\n");
    const ref = note("Notes/ref.md", "---\ntitle: Ref\n---\nwe rely on Acme daily\n");
    expect(() => runHealEnrichment(vault, { safeguard: trippedGuard() })).toThrow(
      SafeguardTimeoutError,
    );
    // Nothing rewritten: the stop is at a boundary, before any write.
    expect(readFileSync(ref, "utf8")).not.toContain("[[Acme]]");
  });
});

/** A guard whose deadline is already in the past on its first check. */
function trippedGuard(): Safeguard {
  let calls = 0;
  return createSafeguard({
    operation: "dream",
    timeoutMs: 1,
    now: () => {
      calls += 1;
      return calls === 1 ? 0 : 1_000;
    },
  });
}

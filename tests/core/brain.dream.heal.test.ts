/**
 * Heal-phase vault enrichment wired into the dream pass (Brain lifecycle
 * suite, Feature 6). When `dream.heal_enrich_enabled` is on, a changed
 * dream run links exact title mentions across the user's vault pages
 * (outside the Brain root). Off by default: the heal phase is a
 * checkpoint-only no-op and user files are byte-identical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dream } from "../../src/core/brain/dream.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { bootstrapBrain } from "../../src/core/brain/init.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-dream-heal-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-dream-heal-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function enableHeal(): void {
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    "schema_version: 1\ndream:\n  heal_enrich_enabled: true\n",
    "utf8",
  );
}

function seedPromotion(): void {
  for (const [i, date] of ["2026-05-20", "2026-05-21", "2026-05-22"].entries()) {
    writeSignal(vault, {
      topic: "heal-topic",
      signal: "positive",
      agent: "claude",
      principle: "Prefer the healed approach",
      created_at: `${date}T10:00:00Z`,
      date,
      slug: `h${i}`,
      scope: "writing",
    });
  }
}

function makeNotes(): { refPath: string } {
  const notes = join(vault, "Notes");
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "Acme.md"), "---\ntitle: Acme\n---\nThe Acme page.\n", "utf8");
  const refPath = join(notes, "ref.md");
  writeFileSync(refPath, "---\ntitle: Ref\n---\nwe rely on Acme daily\n", "utf8");
  return { refPath };
}

const now = new Date("2026-05-23T12:00:00Z");

describe("dream heal phase enrichment", () => {
  test("links exact title mentions in user pages when enabled", () => {
    enableHeal();
    const { refPath } = makeNotes();
    seedPromotion();

    const summary = dream(vault, { now });
    expect(summary.changed).toBe(true);
    expect(readFileSync(refPath, "utf8")).toContain("[[Acme]]");
    const heal = summary.phases.find((p) => p.phase === "heal")?.metrics;
    expect(heal?.["enriched"]).toBeGreaterThanOrEqual(1);
  });

  test("leaves user pages untouched when disabled (default)", () => {
    // Note: heal flag NOT enabled (default _brain.yaml from bootstrap).
    const { refPath } = makeNotes();
    seedPromotion();

    const before = readFileSync(refPath, "utf8");
    const summary = dream(vault, { now });
    expect(summary.changed).toBe(true);
    expect(readFileSync(refPath, "utf8")).toBe(before);
    const heal = summary.phases.find((p) => p.phase === "heal")?.metrics;
    expect(heal?.["enriched"]).toBe(0);
  });

  test("never rewrites Brain-root pages (preferences stay txn-owned)", () => {
    enableHeal();
    // A Brain preference whose principle literally names a known page
    // title; heal must NOT inject a wikilink into it (Brain root is
    // excluded - preference frontmatter is owned by the txn writer).
    mkdirSync(join(vault, "Notes"), { recursive: true });
    writeFileSync(join(vault, "Notes", "Acme.md"), "---\ntitle: Acme\n---\nx\n");
    const prefPath = join(vault, "Brain", "preferences", "pref-mentions.md");
    writeFileSync(
      prefPath,
      "---\nkind: brain-preference\nid: pref-mentions\n_status: confirmed\ncreated_at: 2026-05-01T00:00:00Z\nunconfirmed_until: 2026-05-08T00:00:00Z\ntopic: mentions\nprinciple: Always cite Acme in reviews\ntags:\n  - brain\n  - brain/preference\npinned: false\n---\nbody mentions Acme here\n",
      "utf8",
    );
    seedPromotion();
    dream(vault, { now });
    expect(readFileSync(prefPath, "utf8")).not.toContain("[[Acme]]");
  });
});

/**
 * `brain_doctor` content-hash drift surface. The integrity suite's
 * Feature 1 reads each confirmed preference, recomputes the hash, and
 * surfaces a `content-hash-drift` warning when the stored hash diverges
 * from the recomputed value. Legacy preferences without `_content_hash`
 * are silent (no false positives), and non-confirmed preferences are
 * skipped entirely.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainDirs } from "../../../src/core/brain/paths.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-doctor-drift-"));
  // Minimal Brain skeleton: _brain.yaml + _BRAIN.md + preferences/.
  const dirs = brainDirs(vault);
  mkdirSync(dirs.brain, { recursive: true });
  mkdirSync(dirs.preferences, { recursive: true });
  mkdirSync(dirs.log, { recursive: true });
  writeFileSync(
    join(dirs.brain, "_brain.yaml"),
    `schema_version: 1
primary_agent: null
dream:
  candidate_threshold: 2
  unconfirmed_window_days: 7
  contradiction_window_days: 14
retire:
  stale_evidence_days: 90
confidence:
  low_max_applied: 2
  medium_min: 0.4
  high_min: 0.7
snapshots:
  retention_count: 10
`,
    "utf8",
  );
  writeFileSync(join(dirs.brain, "_BRAIN.md"), "---\ntitle: Brain\n---\n", "utf8");
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function writeConfirmedPref(
  slug: string,
  opts: {
    principle: string;
    scope?: string;
    content_hash?: string;
  },
): string {
  const dirs = brainDirs(vault);
  const path = join(dirs.preferences, `pref-${slug}.md`);
  const lines = [
    "---",
    "kind: brain-preference",
    `id: pref-${slug}`,
    'created_at: "2026-05-01T00:00:00Z"',
    '_confirmed_at: "2026-05-02T00:00:00Z"',
    'unconfirmed_until: "2026-05-08T00:00:00Z"',
    "tags: [brain, brain/preference, brain/topic/writing]",
    "topic: writing",
    "_status: confirmed",
    `principle: ${opts.principle}`,
    "_evidenced_by: []",
    "_applied_count: 1",
    "_violated_count: 0",
    '_last_evidence_at: "2026-05-02T00:00:00Z"',
    "_confidence: high",
    "_confidence_value: 0.8",
    "pinned: false",
  ];
  if (opts.scope) lines.push(`scope: ${opts.scope}`);
  if (opts.content_hash) lines.push(`_content_hash: ${opts.content_hash}`);
  lines.push("---", "");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

describe("runDoctor content-hash drift detection", () => {
  test("emits no drift warning when stored hash matches the live principle", () => {
    const principle = "the in-sync principle text";
    const hash = computeContentHash(principle, undefined);
    writeConfirmedPref("clean", { principle, content_hash: hash });
    const result = runDoctor(vault);
    const drift = result.warnings.filter((i) => i.code === "content-hash-drift");
    expect(drift).toEqual([]);
  });

  test("emits a content-hash-drift warning when the stored hash diverges", () => {
    const principle = "edited after hand modification";
    // Stored hash is for a DIFFERENT principle.
    const staleHash = computeContentHash("the original frozen principle", undefined);
    const path = writeConfirmedPref("drifted", {
      principle,
      content_hash: staleHash,
    });
    const result = runDoctor(vault);
    const drift = result.warnings.filter((i) => i.code === "content-hash-drift");
    expect(drift).toHaveLength(1);
    expect(drift[0]?.path).toBe(path);
    expect(drift[0]?.message).toContain("drift");
  });

  test("does not warn on preferences without _content_hash (legacy / unconfirmed)", () => {
    writeConfirmedPref("legacy", {
      principle: "no hash stored at all",
      // content_hash intentionally omitted
    });
    const result = runDoctor(vault);
    const drift = result.warnings.filter((i) => i.code === "content-hash-drift");
    expect(drift).toEqual([]);
  });

  test("scope changes are detected as drift", () => {
    const principle = "rule with scope";
    // Stored hash includes scope=writing; live scope is coding.
    const staleHash = computeContentHash(principle, "writing");
    writeConfirmedPref("scope-drift", {
      principle,
      scope: "coding",
      content_hash: staleHash,
    });
    const result = runDoctor(vault);
    const drift = result.warnings.filter((i) => i.code === "content-hash-drift");
    expect(drift).toHaveLength(1);
  });
});

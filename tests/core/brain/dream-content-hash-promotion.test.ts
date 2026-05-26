/**
 * Integration coverage for the Brain Integrity Suite Critical fix
 * surfaced during code review: dream's promotion path must produce
 * an on-disk `_content_hash` for every confirmed preference, so the
 * doctor's drift detection has something to compare against.
 *
 * The proof is end-to-end: drive a fresh dream run that promotes an
 * unconfirmed pref to confirmed, then read the resulting file and
 * assert the field is present and matches the canonical hash of the
 * live (principle, scope).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendApplyEvidence } from "../../../src/core/brain/apply-evidence.ts";
import { computeContentHash } from "../../../src/core/brain/content-hash.ts";
import { dream } from "../../../src/core/brain/dream.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { parsePreference } from "../../../src/core/brain/preference.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";

let vault: string;
let configHome: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-promo-hash-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-promo-hash-cfg-"));
  const configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

describe("dream content_hash on promotion", () => {
  test("an unconfirmed -> confirmed transition writes _content_hash matching the live principle", () => {
    // Three positive signals on the same topic clear the candidate
    // threshold; dream creates an unconfirmed pref.
    const topic = "no-magic-numbers";
    const principle = "Replace magic numbers with named constants in production code.";
    for (let i = 0; i < 3; i++) {
      writeSignal(vault, {
        topic,
        signal: "positive",
        agent: "claude",
        principle,
        created_at: `2026-05-12T0${i + 1}:00:00Z`,
        date: "2026-05-12",
        slug: `seed-${i}`,
        scope: "coding",
      });
    }
    const first = dream(vault, { now: new Date("2026-05-12T10:00:00Z") });
    expect(first.new_unconfirmed).toContain(`pref-${topic}`);

    // Record an apply-evidence for the new pref; the next dream pass
    // observes the applied event and flips the pref to confirmed.
    appendApplyEvidence(
      vault,
      {
        pref_id: `pref-${topic}`,
        artifact: "[[src/lib/example.ts]]",
        result: "applied",
        agent: "claude",
      },
      { now: new Date("2026-05-12T11:00:00Z") },
    );

    const second = dream(vault, { now: new Date("2026-05-12T12:00:00Z") });
    expect(second.confirmed).toContain(`pref-${topic}`);

    // Now the on-disk pref must carry _content_hash matching the
    // canonical hash of (principle, scope). Without this fix the
    // doctor's drift detection has nothing to compare against and
    // Feature 1 silently no-ops on every real vault.
    const path = preferencePath(vault, topic);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("_content_hash:");
    const parsed = parsePreference(path);
    expect(parsed.status).toBe("confirmed");
    expect(parsed.content_hash).toBe(
      computeContentHash(parsed.principle, parsed.scope),
    );
  });
});

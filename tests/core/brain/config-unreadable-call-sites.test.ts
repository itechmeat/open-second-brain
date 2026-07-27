/**
 * What a delivery surface does when `Brain/_brain.yaml` is present and
 * cannot be read.
 *
 * `policy-safe-loaders.test.ts` pins the READERS: absent is the defaults,
 * present-but-unreadable raises. This file pins the COMPOSITIONS those
 * readers sit inside, because a raise is only correct where something
 * downstream turns it into a named result. Two of them did not:
 *
 *   - the pre-compress pack, where the strict integrity fallback and the
 *     raising guardrail loader compose. An unreadable config resolves
 *     `owner_scope_delivery` to `fail`, which gives a scoped caller an
 *     enforced scope, which sends the active head through `renderActive`,
 *     which raises. The scoped caller lost its whole pre-compaction
 *     memory pack where the unscoped one still got a pack.
 *   - `packContext`, whose raise reached the MCP surface as a named tool
 *     error but escaped two CLI verbs as an unhandled throw.
 *
 * The absent-config case is asserted alongside every unreadable one: it
 * is the case the `*Safe` readers exist for, and it must not move.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAnticipatoryContext } from "../../../src/core/brain/anticipatory-cache.ts";
import { packContext } from "../../../src/core/brain/context-pack.ts";
import { brainActivePath, brainConfigPath } from "../../../src/core/brain/paths.ts";
import { buildPreCompressPack } from "../../../src/core/brain/pre-compress-pack.ts";
import { BrainConfigError, brainConfigUnreadableReport } from "../../../src/core/brain/policy.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_CONFIDENCE, BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

/**
 * Parses as YAML and fails validation. The exact shape the reviewer
 * reproduced against: one bad line in a block the pack never reads.
 */
const BROKEN_CONFIG = `schema_version: 1\ndream:\n  candidate_threshold: 0\n`;

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-config-unreadable-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  writeFileSync(brainActivePath(vault), "# Active\n\nshared head\n", "utf8");
  writePreference(vault, {
    slug: "keep-going",
    topic: "keep-going",
    principle: "Keep the highest-confidence rule.",
    created_at: "2026-05-01T00:00:00Z",
    unconfirmed_until: "2026-05-08T00:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    evidenced_by: ["[[sig-2026-05-01-keep-going]]"],
    confirmed_at: "2026-05-02T00:00:00Z",
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-02T00:00:00Z",
    confidence: BRAIN_CONFIDENCE.high,
    confidence_value: 0.9,
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function breakConfig(): void {
  writeFileSync(brainConfigPath(vault), BROKEN_CONFIG, "utf8");
}

describe("brainConfigUnreadableReport", () => {
  test("an absent config has nothing to report", () => {
    expect(brainConfigUnreadableReport(vault)).toBeNull();
  });

  test("a readable config has nothing to report", () => {
    writeFileSync(brainConfigPath(vault), "schema_version: 1\n", "utf8");
    expect(brainConfigUnreadableReport(vault)).toBeNull();
  });

  test("an unreadable config reports the cause the parser gave", () => {
    breakConfig();
    const report = brainConfigUnreadableReport(vault);
    expect(report).not.toBeNull();
    expect(report!).toContain(brainConfigPath(vault));
    expect(report!).toContain("dream.candidate_threshold");
  });
});

describe("buildPreCompressPack: an unreadable config degrades, it does not refuse", () => {
  test("absent config: a scoped and an unscoped call both deliver, with no warning", () => {
    const scoped = buildPreCompressPack(vault, { topK: 5, agentScope: "agent-a" });
    const unscoped = buildPreCompressPack(vault, { topK: 5 });
    expect(scoped.text).toContain("Keep the highest-confidence rule.");
    expect(unscoped.text).toContain("shared head");
    expect(scoped.warnings).toBeUndefined();
    expect(unscoped.warnings).toBeUndefined();
  });

  /** The reviewer's reproduction, verbatim. */
  test("a scoped call still returns a pack instead of throwing", () => {
    breakConfig();
    const pack = buildPreCompressPack(vault, { agentScope: "agent-a", topK: 5 });
    expect(pack.text).toContain("Keep the highest-confidence rule.");
  });

  test("an unscoped call keeps returning a pack", () => {
    breakConfig();
    const pack = buildPreCompressPack(vault, { topK: 5 });
    expect(pack.text).toContain("shared head");
  });

  /**
   * The scope-narrowed head comes from `renderActive`, and only from
   * there: falling back to the shared file's bytes under an enforcing
   * gate would hand one agent every other agent's memories.
   */
  test("the scoped active head is withheld rather than served from the shared file", () => {
    breakConfig();
    const pack = buildPreCompressPack(vault, { agentScope: "agent-a", topK: 5 });
    expect(pack.activeHeadIncluded).toBe(false);
    expect(pack.text).not.toContain("shared head");
  });

  test("the pack names the broken config so the operator can act on it", () => {
    breakConfig();
    const pack = buildPreCompressPack(vault, { agentScope: "agent-a", topK: 5 });
    expect(pack.warnings).toEqual([brainConfigUnreadableReport(vault)!]);
  });

  test("a readable config leaves the scoped pack unwarned", () => {
    writeFileSync(brainConfigPath(vault), "schema_version: 1\n", "utf8");
    const pack = buildPreCompressPack(vault, { agentScope: "agent-a", topK: 5 });
    expect(pack.warnings).toBeUndefined();
    expect(pack.activeHeadIncluded).toBe(true);
  });
});

describe("packContext: the raise is the contract, and every caller must name it", () => {
  test("absent config: the pack is built on the documented guardrail defaults", () => {
    expect(() => packContext(vault, { maxTokens: 500 })).not.toThrow();
  });

  test("an unreadable config raises, naming the file", () => {
    breakConfig();
    let caught: unknown;
    try {
      packContext(vault, { maxTokens: 500 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainConfigError);
    expect((caught as BrainConfigError).message).toContain(brainConfigPath(vault));
  });

  /**
   * `readAnticipatoryContext` documented itself as never throwing, and
   * that stopped being true the moment `packContext` grew a raise. The
   * contract is now the raise; this pins that the two agree, so the
   * docblock cannot drift back into a promise the code does not keep.
   */
  test("readAnticipatoryContext propagates the raise rather than swallowing it", () => {
    breakConfig();
    expect(() =>
      readAnticipatoryContext(vault, { sessionId: "s1", now: new Date("2026-05-02T00:00:00Z") }),
    ).toThrow(BrainConfigError);
  });
});
